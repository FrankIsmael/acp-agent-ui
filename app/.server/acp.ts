/**
 * Server-side ACP engine — ported from web/server.mjs (SPEC-2).
 *
 * A shared ACP connection; the agent stores conversations in the
 * EasyBits box. The browser never talks to ACP: it consumes events via SSE.
 */
import {
  demoEnabled,
  conversationOwner,
  beginDemoTurn,
  chargeDemoOutput,
  estimateTokens,
  isFullAccess,
  demoMessage,
  demoChannelConversation,
} from './demo';
import { EventEmitter } from 'node:events';
import { client, type ClientConnection } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { WebSocket } from 'ws';
import type { ConnectPhase } from '~/hooks/useAcpStream';
import { parseSkills, replayMetadata } from './goose-adapter';
import { boxLifecycle } from './agent-box';
import { readBoxConfigs, type BoxConfig } from './box-config';
import { conversationIds } from './conversation-ids';
import { AgentError } from './errors';
import {
  CHANNEL_MARKER,
  EMBED_MARKER,
  LEGACY_INSTRUCTIONS,
  PROFILE_CLOSE,
  PROFILE_OPEN,
  SLACK_MARKER,
} from './channel-markers';
import { embedConversation, markProfiled } from './embed-conversations';
import { portfolioProfile } from './portfolio-profile';
import { PermissionQueue, type PendingPermission } from './permissions';
import { extensionStore, summarizeExtensions } from './extensions';
import { mapDataFromToolContent, mergeMapData, type MapData } from '~/lib/maps';
import { DEFAULT_TITLE, isGenericTitle, titleFromPrompt, titleStore } from './titles';
import {
  attachmentsBlock,
  takeAttachments,
  type AttachedFile,
} from '~/lib/attachments';

// Which boxes (URL, token, box id, session limit): see box-config.ts.

// Default working directory
const CWD = process.env.ACP_CWD ?? '/data/work';

/**
 * List of model IDs that support images (from ACP_VISION_MODELS, comma-separated).
 * If empty, defaults to matching model names with 'vision' or 'vl'.
 */
const VISION_MODELS = (process.env.ACP_VISION_MODELS ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Always treat these IDs as vision models, even if their names don't indicate it.
 */
const ALWAYS_VISION = new Set(['openrouter/free']);

const isVisionModel = (id: string) =>
  ALWAYS_VISION.has(id) ||
  (VISION_MODELS.length > 0
    ? VISION_MODELS.includes(id)
    : /vision|-vl\b|-vl-/i.test(id));

// Extra model IDs (and optional display names) to inject, in `id|Visible Name` format, comma-separated.
const EXTRA_MODELS = (process.env.ACP_EXTRA_MODELS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [value, ...name] = entry.split('|');
    return { value: value.trim(), name: name.join('|').trim() || value.trim() };
  });
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Types of events sent to the browser
// ---------------------------------------------------------------------------

export interface PromptImage {
  mimeType: string;
  data: string;
  name?: string;
}

/**
 * A selector that the agent exposes for its session. ACP does not have a
 * `session/set_model`: the model is just another `SessionConfigOption`, with
 * `category: "model"`. See the long comment in `handshake()`.
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type?: 'select' | 'boolean';
  currentValue?: string | boolean;
  options?: unknown;
}

export type AcpEvent =
  | {
      type: 'snapshot';
      messages: StoredMessage[];
      busy: boolean;
      permissions: PendingPermission[];
    }
  | { type: 'permissions'; permissions: PendingPermission[] }
  | { type: 'title'; title: string }
  | { type: 'started'; sessionId: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'chunk'; text: string }
  | { type: 'thought'; text: string }
  // A turn that came in through another channel (WhatsApp...): the browser did not send it, so it needs to be rendered. Browser-originating user events are not sent: the browser already has them.
  | {
      type: 'user';
      text: string;
      images?: PromptImage[];
      via: string;
      from?: string;
    }
  // An image returned by an MCP tool within the turn; it's attached to the agent's message in progress.
  | { type: 'image'; mimeType: string; data: string }
  // Locations and routes from a Google Maps tool in the turn, already merged with previous ones.
  | { type: 'map'; map: MapData }
  | {
      // An agent tool: tool_call creates it, tool_call_update updates it.
      // The same id arrives multiple times; the browser does upsert.
      type: 'tool';
      id: string;
      title?: string;
      kind?: string;
      status?: string;
      path?: string;
    }
  | { type: 'usage'; used: number; size: number; cost: number }
  // Session selectors (model, mode, reasoning level...) and whether the agent accepts images in the prompt. Sent on connect and whenever they change, coming from here or the agent.
  | {
      type: 'config';
      options: ConfigOption[];
      imageSupport: boolean;
      /** Which selectors' models actually see images. */
      visionModels: string[];
    }
  | { type: 'done'; stopReason: string; usage: unknown }
  | { type: 'error'; message: string }
  // Connection phase, so the UI doesn't just say "Connecting..." for the ~15s it takes to wake up a sleeping agent box.
  | { type: 'status'; phase: ConnectPhase }
  | { type: 'closed' };

const CONNECT_TIMEOUT_MS = Number(process.env.ACP_CONNECT_TIMEOUT_MS ?? 60_000);
// session/new and session/load wait for MCP extensions of the session to start:
// a server that does not respond (bad URL, wrong credential) would leave the request hanging forever, blocking any attempt to open a conversation.
const SESSION_TIMEOUT_MS = Number(process.env.ACP_SESSION_TIMEOUT_MS ?? 60_000);
// An idle thread someone still has on screen is evicted only after this long without a turn.
const VIEWED_GRACE_MS = 5 * 60 * 1000;

// Routes import it from here.
export { AgentError };


// ghosty does not deliver the permission response with claude-acp (`No task waiting for confirmation`)
// and the tool stays stuck forever. Until it's fixed, the thread is set to this mode when opened.
// Empty = do not touch the agent's mode.
const ACP_MODE = process.env.ACP_MODE ?? 'auto';

/** What an external channel (WhatsApp...) needs to know about a turn it requested itself. */
export interface ChannelTurn {
  via: string;
  from?: string;
  onAnswer?: (
    answer: string,
    error: string | null,
    images: PromptImage[],
  ) => void;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: PromptImage[];
  /** Documents the user attached: where they landed in the box, not their bytes. */
  files?: AttachedFile[];
  /** Through which channel the turn came in (`whatsapp`...). If not set: the web chat. */
  via?: string;
  /** Who wrote it in that channel, as shown by the channel. */
  from?: string;
  thought?: string;
  tools?: {
    id: string;
    title?: string;
    kind?: string;
    status?: string;
    path?: string;
  }[];
  map?: MapData;
  usage?: { used: number; size: number; cost: number };
  at: number;
}

interface Capabilities {
  loadSession?: boolean;
  sessionCapabilities?: { list?: unknown; close?: unknown };
  promptCapabilities?: { image?: boolean };
}

/**
 * One agent box: its connection, what its agent can do and the sessions open on it. Every box of
 * ACP_BOXES has its own; a session lives and dies with its box's connection.
 */
class AgentBox {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  readonly boxId: string;
  readonly maxSessions: number;
  private readonly lifecycle: ReturnType<typeof boxLifecycle>;
  connection: ClientConnection | undefined;
  private connecting: Promise<ClientConnection> | undefined;
  capabilities: Capabilities = {};
  agentName = '';
  // Open sessions by sessionId. A thread opening with session/new joins once the agent names it.
  readonly sessions = new Map<string, GooseSession>();
  private opening = 0;
  private transition = Promise.resolve();
  // Last failed connection: new conversations skip this box for BOX_RETRY_MS.
  failedAt = 0;

  constructor(
    config: BoxConfig,
    readonly primary: boolean,
  ) {
    this.name = config.name;
    this.url = config.url;
    this.token = config.token;
    this.boxId = config.boxId;
    this.maxSessions = config.maxSessions;
    this.lifecycle = boxLifecycle(config.boxId, config.snapshotId);
  }

  // Serializes thread changes on this box, without blocking session/cancel behind a prompt.
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation);
    this.transition = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  busy() {
    return [...this.sessions.values()].some((s) => s.busy);
  }

  /**
   * The id the app uses for one of this box's sessions (see conversation-ids.ts). A first-box
   * session from before app ids keeps the agent's id, so its old links still work.
   */
  globalId(sessionId: string) {
    const ids = conversationIds();
    return (
      ids.find(this.name, sessionId) ??
      (this.primary ? sessionId : ids.assign(this.name, sessionId))
    );
  }

  private capacity() {
    return this.capabilities.sessionCapabilities?.close != null || !this.connection
      ? this.maxSessions
      : 1;
  }

  /** Slots open without evicting anyone. */
  free() {
    return this.capacity() - this.sessions.size - this.opening;
  }

  reachable() {
    return Date.now() - this.failedAt > BOX_RETRY_MS;
  }

  /**
   * Frees a slot for one more session. Never evicts a thread mid-turn. First goes a thread nobody
   * is watching, then one on screen but idle for VIEWED_GRACE_MS; the least recently used of each.
   * Without session/close, a session can only be freed by dropping the connection, so there is one.
   */
  async makeRoom() {
    while (this.free() <= 0) {
      const idle = [...this.sessions.values()]
        .filter((s) => !s.busy && !s.configuringExtensions)
        .sort((a, b) => a.usedAt - b.usedAt);
      const victim =
        idle.find((s) => s.listenerCount('event') === 0) ??
        idle.find((s) => Date.now() - s.usedAt > VIEWED_GRACE_MS);
      if (!victim)
        throw new Response(
          'The agent is busy with other conversations. Please try again in a moment.',
          { status: 409 },
        );
      // ask() refuses from here on: a prompt can't slip in while session/close is in flight.
      victim.ready = false;
      await victim.close();
    }
  }

  /** Opens a session on this box: one slot is taken while the agent creates or replays it. */
  async open(session: GooseSession, load: boolean, replayTail?: number) {
    await this.makeRoom();
    // A loaded thread joins before session/load: the agent replays it as session/update
    // notifications. A new one has no id until the agent names it, so it holds a slot meanwhile.
    if (load) this.sessions.set(session.sessionId, session);
    else this.opening++;
    try {
      await session.initialize(load, replayTail);
      this.sessions.set(session.sessionId, session);
    } catch (error) {
      session.disconnected();
      this.abandonConnection();
      throw error;
    } finally {
      if (!load) this.opening--;
    }
  }

  // A failed session/new or session/load may have taken a relay slot. Dropping the connection
  // frees it, but also cuts every other open thread, so only when nobody else is using it.
  private abandonConnection() {
    if ([...this.sessions.values()].some((s) => !s.closed)) return;
    this.disconnect();
  }

  disconnect() {
    const conn = this.connection;
    this.connection = undefined;
    conn?.close();
  }

  /** Closes every thread and the connection, then lets the box sleep. */
  async sleep() {
    for (const s of [...this.sessions.values()]) await s.close();
    this.disconnect();
    await this.lifecycle.suspend();
  }

  connect(): Promise<ClientConnection> {
    if (this.connection && !this.connection.signal.aborted)
      return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.url)
        throw new AgentError(
          this.name === 'main'
            ? 'Missing ACP_WS_URL on the server.'
            : `Missing ACP_${this.name.toUpperCase()}_WS_URL on the server.`,
        );
      await this.lifecycle.ensure(IDLE_MS);
      const target = new URL(this.url);
      const token = this.token;
      if (token && !target.searchParams.has('token'))
        target.searchParams.set('token', token);
      const app = client({ name: 'acp-web3' } as any);
      app.onNotification('session/update', ({ params }: any) => {
        this.sessions.get(params.sessionId)?.update(params.update);
      });
      app.onRequest('session/request_permission', ({ params }: any) => {
        const s = this.sessions.get(params.sessionId);
        if (!s || s.closed || !s.busy || s.cancelling) {
          return { outcome: { outcome: 'cancelled' } };
        }
        s.update({
          ...params.toolCall,
          sessionUpdate: 'tool_call_update',
          status: 'pending',
        });
        return s.permissions.request(params.toolCall, params.options ?? []);
      });
      // The box may reject the connection (conversation quota reached, bad token) with a JSON-RPC error having `id: null` and close the socket. The SDK discards it ("response to unknown request null") and `initialize` would hang until timeout without indicating the reason.
      // The reason is captured from the raw socket and the wait is cut as soon as it closes.
      let rejection = '';
      let socketClosed!: Promise<never>;
      class ObservedWebSocket extends WebSocket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          socketClosed = new Promise((_, reject) => {
            this.on('message', (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.id === null && msg.error?.message)
                  rejection = msg.error.message;
              } catch {}
            });
            this.on('close', () =>
              reject(
                new AgentError(
                  rejection ||
                    'The agent closed the connection before responding.',
                ),
              ),
            );
          });
          socketClosed.catch(() => {});
        }
      }
      const conn = app.connect(
        createWebSocketStream(target.toString(), {
          WebSocket: ObservedWebSocket,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        } as any),
      );
      try {
        const init: any = await withTimeout(
          Promise.race([
            conn.agent.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                session: { configOptions: { boolean: {} } },
              },
            }),
            socketClosed,
          ]),
          CONNECT_TIMEOUT_MS,
          'The agent did not respond in time.',
        );
        this.capabilities = init.agentCapabilities ?? {};
        this.agentName = init.agentInfo?.name ?? '';
        this.connection = conn;
        conn.closed
          .then(() => {
            if (this.connection !== conn) return;
            this.connection = undefined;
            for (const s of [...this.sessions.values()]) s.disconnected();
          })
          .catch(() => {});
        this.failedAt = 0;
        return conn;
      } catch (error) {
        conn.close();
        throw error instanceof AgentError
          ? error
          : new AgentError(
              'Could not connect to the agent. Check your connection and server configuration.',
            );
      }
    })()
      .catch((error) => {
        this.failedAt = Date.now();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
}

const boxes = readBoxConfigs().map(
  (config, i) => new AgentBox(config, i === 0),
);
// Ids the app never gave out (links from before app ids) belong to it; also what settings show.
const primary = boxes[0];
// A box that could not be reached is skipped by new conversations this long.
const BOX_RETRY_MS = 60_000;
// With several boxes, one asleep or down must not hold the merged history for long.
const LIST_TIMEOUT_MS = 30_000;

/** Which box holds a conversation, and the agent's own id for it there. None: its box was removed. */
function locate(id: string) {
  const place = conversationIds().place(id);
  if (!place) return { box: primary, local: id };
  const box = boxes.find((b) => b.name === place.box);
  return box ? { box, local: place.session } : undefined;
}

// Roomiest reachable box first; config order breaks ties.
function boxesByRoom() {
  return [...boxes].sort(
    (a, b) =>
      Number(b.reachable()) - Number(a.reachable()) || b.free() - a.free(),
  );
}

let lastConfigOptions: ConfigOption[] = [];
let history: ConversationSummary[] = [];
let historyAt = 0;
let historyError: string | null = null;
let refreshing: Promise<void> | undefined;

function liveSession(id: string) {
  const place = locate(id);
  const s = place?.box.sessions.get(place.local);
  return s && !s.closed ? s : undefined;
}

// The thread used most recently: where an owner's WhatsApp turn and the extensions page land.
function latestSession() {
  let latest: GooseSession | undefined;
  for (const box of boxes)
    for (const s of box.sessions.values())
      if (!s.closed && s.ready && (!latest || s.usedAt > latest.usedAt))
        latest = s;
  return latest;
}

class GooseSession extends EventEmitter {
  sessionId: string;
  busy = false;
  cancelling = false;
  configuringExtensions = false;
  ready = false;
  closed = false;
  phase: ConnectPhase = 'session';
  lastError: string | null = null;
  cost = 0;
  tokens = 0;
  contextSize = 0;
  title = DEFAULT_TITLE;
  cwd: string;
  configOptions: ConfigOption[] = [];
  imageSupport = false;
  createdAt = Date.now();
  updatedAt = Date.now();
  messages: StoredMessage[] = [];
  permissions = new PermissionQueue((permissions) =>
    this.emit('event', { type: 'permissions', permissions }),
  );
  private assistant: StoredMessage | undefined;
  private running: Promise<void> | undefined;
  private replaying = false;
  private demoOwner: string | undefined;
  private demoStopped = false;
  replayTail: number | undefined;
  // Last open, turn or subscription: decides which idle thread makeRoom evicts first.
  usedAt = Date.now();

  constructor(
    readonly box: AgentBox,
    id: string,
    cwd: string,
  ) {
    super();
    this.sessionId = id;
    this.cwd = cwd;
  }

  // Set when known: on load, the id asked for; on session/new, the one given out then.
  private appId: string | undefined;

  /** The conversation id outside: in URLs, the browser and the app's stores. `sessionId` is the agent's. */
  get id() {
    return this.appId ?? this.box.globalId(this.sessionId);
  }

  private setConfigOptions(list: ConfigOption[] | undefined | null) {
    // The provider (claude-acp, openai...) is decided by whoever launches the box, not by whoever chats:
    // changing it mid-conversation would leave the agent without credentials. It is not offered in the selector.
    const options = (list ?? []).filter(
      (o) => o.id !== 'provider' && o.category !== 'provider',
    );
    if (EXTRA_MODELS.length > 0) {
      const model = options.find(
        (o) => o.category === 'model' || o.id === 'model',
      );
      const raw = model?.options;
      if (Array.isArray(raw)) {
        // The options are either flat or grouped; you only know by looking at
        // the first element. In grouped, the extras go into their own group.
        const grouped =
          raw.length > 0 &&
          typeof raw[0] === 'object' &&
          raw[0] !== null &&
          'group' in (raw[0] as object);
        const known = new Set(
          grouped
            ? (raw as any[]).flatMap((g) =>
                (g.options ?? []).map((v: any) => v.value),
              )
            : (raw as any[]).map((v) => v.value),
        );
        const missing = EXTRA_MODELS.filter((m) => !known.has(m.value));
        if (missing.length > 0) {
          model!.options = grouped
            ? [
                ...(raw as any[]),
                { group: 'extra', name: 'Added', options: missing },
              ]
            : [...missing, ...(raw as any[])];
        }
      }
    }
    this.configOptions = options;
    lastConfigOptions = structuredClone(options);
  }

  async initialize(load: boolean, replayTail?: number) {
    const conn = await this.box.connect();
    this.imageSupport = this.box.capabilities.promptCapabilities?.image === true;
    this.replaying = load;
    this.replayTail =
      load && replayMetadata(this.box.agentName, replayTail)._meta
        ? replayTail
        : undefined;
    try {
      const mcpServers = extensionStore().servers();
      console.log(
        `[acp] mcpServers: ${mcpServers.map((s) => s.name).join(', ') || '(none)'}`,
      );
      const response: any = await withTimeout(
        load
          ? conn.agent.request('session/load', {
              sessionId: this.sessionId,
              cwd: this.cwd,
              mcpServers,
              ...replayMetadata(this.box.agentName, replayTail),
            })
          : conn.agent.request('session/new', { cwd: this.cwd, mcpServers }),
        SESSION_TIMEOUT_MS,
        `The agent did not open the session in time${mcpServers.length ? ` (check the active extensions: ${mcpServers.map((s) => s.name).join(', ')})` : ''}.`,
      );
      if (!load) {
        this.sessionId = response.sessionId;
        this.appId = conversationIds().assign(this.box.name, this.sessionId);
      }
      this.setConfigOptions(response.configOptions);
      await this.forceMode(conn, response.modes);
      this.ready = true;
      if (load)
        this.entitle(this.messages.find((m) => m.role === 'user')?.text ?? '');
      this.emit('event', { type: 'started', sessionId: this.id });
      this.emitConfig();
      remember(this);
    } finally {
      this.replaying = false;
      this.assistant = undefined;
    }
  }

  // See ACP_MODE: without `auto`, with claude-acp every tool that asks permission gets stuck.
  private async forceMode(
    conn: ClientConnection,
    modes:
      | { currentModeId?: string; availableModes?: { id: string }[] }
      | undefined,
  ) {
    if (!ACP_MODE || !modes || modes.currentModeId === ACP_MODE) return;
    if (
      modes.availableModes &&
      !modes.availableModes.some((m) => m.id === ACP_MODE)
    )
      return;
    try {
      await conn.agent.request('session/set_mode', {
        sessionId: this.sessionId,
        modeId: ACP_MODE,
      });
    } catch (error) {
      console.warn(
        `[acp] could not set mode ${ACP_MODE}:`,

        (error as Error).message,
      );
    }
  }

  // If the agent didn't name the thread, the first user message is used as the title.
  // A true title from the agent (`session_info_update`) always overwrites it.
  private entitle(text: string) {
    if (!isGenericTitle(this.title)) return;
    const title = titleStore().get(this.id) || titleFromPrompt(text);
    if (!title) return;
    this.title = title;
    titleStore().set(this.id, title);
    if (!this.replaying) this.emit('event', { type: 'title', title });
  }

  private answer() {
    if (!this.assistant) {
      this.assistant = { role: 'assistant', text: '', at: Date.now() };
      this.messages.push(this.assistant);
    }
    return this.assistant;
  }

  update(u: any) {
    if (this.closed) return;
    if (this.demoOwner && this.busy && !this.replaying && !this.demoStopped) {
      const text = ['agent_message_chunk', 'agent_thought_chunk'].includes(
        u.sessionUpdate,
      )
        ? (u.content?.text ?? '')
        : '';
      // Tool activity has a fixed allowance too, including image generation outside model tokens.
      const charge =
        estimateTokens(text) + (u.sessionUpdate === 'tool_call' ? 1024 : 0);
      if (charge && chargeDemoOutput(this.demoOwner, charge)) this.stopDemo();
    }
    const emit = (event: AcpEvent) => {
      if (!this.replaying) this.emit('event', event);
    };
    if (u.sessionUpdate === 'user_message_chunk') {
      if (!this.replaying) return;
      // Old threads may contain inline instructions; new ones only the channel marker.
      // None of those prefixes should be displayed as if written by the user.
      const content = { ...u.content };
      if (content.type === 'text') {
        for (const [start, end] of LEGACY_INSTRUCTIONS) {
          const stop = content.text.startsWith(start)
            ? content.text.indexOf(end)
            : -1;
          if (stop > -1)
            content.text = content.text.slice(stop + end.length).trimStart();
        }
        for (const marker of [CHANNEL_MARKER, SLACK_MARKER, EMBED_MARKER]) {
          if (content.text.startsWith(marker))
            content.text = content.text.slice(marker.length).trimStart();
        }
        // The attachments block becomes the message's file chips.
        const attached = takeAttachments(content.text);
        content.text = attached.text;
        if (attached.files.length > 0) {
          this.assistant = undefined;
          let last = this.messages.at(-1);
          if (last?.role !== 'user') {
            last = { role: 'user', text: '', at: Date.now() };
            this.messages.push(last);
          }
          (last.files ??= []).push(...attached.files);
        }
        const profileEnd = content.text.startsWith(PROFILE_OPEN)
          ? content.text.indexOf(PROFILE_CLOSE)
          : -1;
        if (profileEnd > -1)
          content.text = content.text
            .slice(profileEnd + PROFILE_CLOSE.length)
            .trimStart();
        if (!content.text) return;
      }
      this.assistant = undefined;
      let message = this.messages.at(-1);
      if (message?.role !== 'user') {
        message = { role: 'user', text: '', at: Date.now() };
        this.messages.push(message);
      }
      if (content?.type === 'text') message.text += content.text;
      if (content?.type === 'image')
        (message.images ??= []).push({
          mimeType: content.mimeType,
          data: content.data,
        });
    } else if (u.sessionUpdate === 'agent_message_chunk') {
      const text = u.content?.text ?? '';
      this.answer().text += text;
      emit({ type: 'chunk', text });
    } else if (u.sessionUpdate === 'agent_thought_chunk') {
      const text = u.content?.text ?? '';
      const answer = this.answer();
      answer.thought = (answer.thought ?? '') + text;
      emit({ type: 'thought', text });
    } else if (
      u.sessionUpdate === 'tool_call' ||
      u.sessionUpdate === 'tool_call_update'
    ) {
      const event: Extract<AcpEvent, { type: 'tool' }> = {
        type: 'tool',
        id: u.toolCallId,
      };
      for (const key of ['title', 'kind', 'status'] as const)
        if (u[key] != null) event[key] = u[key];
      if (u.locations?.[0]?.path) event.path = u.locations[0].path;
      const answer = this.answer();
      const tools = (answer.tools ??= []);
      const existing = tools.find((t) => t.id === event.id);
      if (existing) Object.assign(existing, event);
      else tools.push(event);
      emit(event);
      // Images travel in `content[]` of the update. Only those from extensions (`mcp:`) count:
      // a `Read` of a PNG also returns an image, but that one was read by the agent, not produced as output.
      const title = existing?.title ?? event.title ?? '';
      if (
        u.sessionUpdate === 'tool_call_update' &&
        Array.isArray(u.content) &&
        /^mcp:/i.test(title)
      ) {
        for (const block of u.content) {
          const content = block?.type === 'content' ? block.content : undefined;
          if (
            content?.type !== 'image' ||
            typeof content.data !== 'string' ||
            !content.data
          )
            continue;
          const image: PromptImage = {
            mimeType: content.mimeType || 'image/png',
            data: content.data,
          };
          (answer.images ??= []).push(image);
          emit({ type: 'image', ...image });
        }
        const map = mapDataFromToolContent(u.content);
        if (map) {
          answer.map = mergeMapData(answer.map, map);
          emit({ type: 'map', map: answer.map });
        }
      }
    } else if (u.sessionUpdate === 'config_option_update') {
      this.setConfigOptions(u.configOptions);
      if (!this.replaying) this.emitConfig();
    } else if (u.sessionUpdate === 'session_info_update') {
      if (typeof u.title === 'string' && !isGenericTitle(u.title))
        this.title = u.title;
      if (u.updatedAt && Number.isFinite(Date.parse(u.updatedAt)))
        this.updatedAt = Date.parse(u.updatedAt);
      remember(this);
      emit({ type: 'title', title: this.title });
    } else if (u.sessionUpdate === 'usage_update') {
      const usage = {
        used: u.used ?? 0,
        size: u.size ?? 0,
        cost: u.cost?.amount ?? 0,
      };
      this.tokens = usage.used;
      this.contextSize = usage.size;
      this.cost = usage.cost;
      if (this.assistant) this.assistant.usage = usage;
      emit({ type: 'usage', ...usage });
    }
  }

  configEvent(): AcpEvent {
    const model = this.configOptions.find(
      (o) => o.category === 'model' || o.id === 'model',
    );
    const raw = (model?.options ?? []) as any[];
    const values: string[] =
      raw.length && 'group' in (raw[0] ?? {})
        ? raw.flatMap((g) => (g.options ?? []).map((v: any) => v.value))
        : raw.map((v) => v.value);
    return {
      type: 'config',
      options: demoEnabled() ? [] : this.configOptions,
      imageSupport: this.imageSupport,
      visionModels: values.filter(isVisionModel),
    };
  }
  emitConfig() {
    this.emit('event', this.configEvent());
  }

  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.ready || this.closed || this.busy)
      throw new Error(
        'The session is not available to change the configuration.',
      );
    const response: any = await this.box.connection!.agent.request(
      'session/set_config_option',
      {
        sessionId: this.sessionId,
        configId,
        ...(typeof value === 'boolean'
          ? { type: 'boolean', value }
          : { value }),
      },
    );
    this.setConfigOptions(response.configOptions ?? this.configOptions);
    this.emitConfig();
  }

  private stopDemo() {
    if (this.demoStopped) return;
    this.demoStopped = true;
    this.emit('event', { type: 'error', message: demoMessage() });
    void this.cancel().catch(() => {});
  }

  /** The turn has ended, with or without error. An external channel waits here for its response. */
  whenIdle() {
    return (this.running ?? Promise.resolve()).catch(() => {});
  }

  ask(
    text: string,
    images: PromptImage[] = [],
    channel?: ChannelTurn,
    files: AttachedFile[] = [],
  ) {
    if (!this.ready || this.closed || this.busy || this.configuringExtensions)
      return false;
    this.demoOwner = conversationOwner(this.id);
    this.demoStopped = false;
    if (demoEnabled() && !this.demoOwner)
      throw new Error('Demo conversation has no owner');
    if (this.demoOwner) {
      // Context is billed again on each prompt; include it and a fixed instructions/tool overhead.
      const context = this.messages.reduce(
        (sum, m) =>
          sum +
          estimateTokens(m.text + (m.thought ?? '')) +
          (m.images?.length ?? 0) * 2048,
        0,
      );
      beginDemoTurn(
        this.demoOwner,
        2048 + context + estimateTokens(text) + images.length * 2048,
      );
    }
    this.busy = true;
    this.usedAt = Date.now();
    this.cancelling = false;
    this.assistant = undefined;
    const message: StoredMessage = {
      role: 'user',
      text,
      images,
      at: Date.now(),
    };
    // The links expire: the history keeps where the files are, not how to fetch them.
    if (files.length > 0) message.files = files.map(({ url, ...f }) => f);
    if (channel) {
      message.via = channel.via;
      if (channel.from) message.from = channel.from;
    }
    this.messages.push(message);
    this.updatedAt = Date.now();
    if (channel)
      this.emit('event', {
        type: 'user',
        text,
        images,
        via: channel.via,
        from: channel.from,
      });
    this.emit('event', { type: 'busy', busy: true });
    this.entitle(text);
    remember(this);
    this.running = (async () => {
      let error: string | null = null;
      // Invited guests have no limits, including this per-turn time cap.
      const demoTimer =
        this.demoOwner && !isFullAccess(this.demoOwner)
          ? setTimeout(() => this.stopDemo(), 120_000)
          : undefined;
      try {
        // Formatting and language rules live in CLAUDE.md / .goosehints in the box.
        // Only the channel varies per turn: web, WhatsApp and Slack share the thread. A thread
        // opened from the portfolio widget always carries its marker, and its first turn
        // (or the next one, if the portfolio did not answer) Ismael's profile.
        const embed = channel ? null : embedConversation(this.id);
        const profile =
          embed && !embed.profiled ? await portfolioProfile() : null;
        const result: any = await this.box.connection!.agent.request('session/prompt', {
          sessionId: this.sessionId,
          prompt: [
            ...(channel
              ? [
                  {
                    type: 'text' as const,
                    text:
                      channel.via === 'slack' ? SLACK_MARKER : CHANNEL_MARKER,
                  },
                ]
              : embed
                ? [{ type: 'text' as const, text: EMBED_MARKER }]
                : []),
            ...(profile
              ? [
                  {
                    type: 'text' as const,
                    text: `${PROFILE_OPEN}\n${profile}\n${PROFILE_CLOSE}`,
                  },
                ]
              : []),
            { type: 'text', text },
            // Documents were uploaded before the turn (app/.server/uploads.ts): it only names them.
            ...(files.length > 0
              ? [{ type: 'text' as const, text: attachmentsBlock(files) }]
              : []),
            ...images.map((img) => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
          ],
        });
        if (profile) markProfiled(this.id);
        this.emit('event', {
          type: 'done',
          stopReason: result.stopReason,
          usage: this.assistant?.usage ?? null,
        });
        if (result.stopReason === 'cancelled')
          error = 'The turn was stopped before it finished.';
      } catch (e) {
        error =
          'The response was interrupted. Reopen the thread to recover what was saved by the agent.';

        this.emit('event', { type: 'error', message: error });
      } finally {
        clearTimeout(demoTimer);
        // The channel is notified before 'busy' is set to false, with the whole agent's message.
        try {
          channel?.onAnswer?.(
            (this.assistant?.text ?? '') +
              (this.demoStopped ? `\n\n${demoMessage()}` : ''),
            error,
            this.assistant?.images ?? [],
          );
        } catch {}
        this.permissions.cancel();
        this.busy = false;
        this.usedAt = Date.now();
        this.assistant = undefined;
        this.updatedAt = Date.now();
        remember(this);
        historyAt = 0;
        this.emit('event', { type: 'busy', busy: false });
      }
    })();
    return true;
  }

  async cancel() {
    this.cancelling = true;
    this.permissions.cancel();
    const conn = this.box.connection;
    if (this.busy && conn)
      await conn.agent.notify('session/cancel', {
        sessionId: this.sessionId,
      });
  }

  disconnected() {
    this.permissions.cancel();
    this.closed = true;
    this.ready = false;
    this.busy = false;
    if (this.box.sessions.get(this.sessionId) === this)
      this.box.sessions.delete(this.sessionId);
    this.emit('event', { type: 'closed' });
  }

  async close() {
    if (this.closed) return;
    if (this.busy) {
      await this.cancel();
      // An agent that ignores cancel should not block thread change forever.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.running,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('The agent did not confirm the cancellation.'),
                ),

              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const conn = this.box.connection;
    if (this.box.capabilities.sessionCapabilities?.close != null && conn) {
      await conn.agent.request('session/close', {
        sessionId: this.sessionId,
      });
    } else {
      this.box.disconnect();
    }
    remember(this);
    this.disconnected();
  }
}

export interface ConversationSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens: number;
  contextSize: number;
  cost: number;
  busy: boolean;
  closed: boolean;
  canOpen: boolean;
}

function summarize(s: GooseSession): ConversationSummary {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    tokens: s.tokens,
    contextSize: s.contextSize,
    cost: s.cost,
    busy: s.busy,
    closed: s.closed,
    canOpen: !s.closed || !!s.box.capabilities.loadSession,
  };
}
function remember(s: GooseSession) {
  const row = summarize(s);
  history = [row, ...history.filter((c) => c.id !== row.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

// A thread nobody wrote in can never get a title: it stays hidden unless it's the one open now.
function isEmpty(c: ConversationSummary) {
  return (
    c.messageCount === 0 &&
    c.title === DEFAULT_TITLE &&
    !liveSession(c.id)
  );
}

export function getHistorySnapshot() {
  const conversations = history.filter((c) => !isEmpty(c)).map((c) => ({
    ...c,
    busy: liveSession(c.id)?.busy ?? false,
    canOpen: !!locate(c.id)?.box.capabilities.loadSession || !!liveSession(c.id),
  }));
  return {
    conversations,
    error: historyError,
    loaded: historyAt > 0,
    persistent: boxes.some((b) => b.capabilities.sessionCapabilities?.list != null),
  };
}

// One box's threads, with the app's ids. Without session/list, only the ones open now.
async function listBox(box: AgentBox) {
  const conn = await box.connect();
  if (box.capabilities.sessionCapabilities?.list == null)
    return [...box.sessions.values()].map(summarize);
  const rows: ConversationSummary[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page: any = await conn.agent.request('session/list', {
      ...(cursor ? { cursor } : {}),
    });
    for (const session of page.sessions ?? []) {
      const id = box.globalId(session.sessionId);
      const old = history.find((c) => c.id === id);
      const updatedAt = Date.parse(session.updatedAt) || old?.updatedAt || 0;
      const title =
        [session.title, titleStore().get(id), old?.title].find(
          (t) => !isGenericTitle(t),
        ) || DEFAULT_TITLE;
      rows.push({
        id,
        title,
        cwd: session.cwd || CWD,
        createdAt: old?.createdAt ?? updatedAt,
        updatedAt,
        messageCount: session._meta?.messageCount ?? old?.messageCount ?? 0,
        tokens: old?.tokens ?? 0,
        contextSize: old?.contextSize ?? 0,
        cost: old?.cost ?? 0,
        busy: false,
        closed: true,
        canOpen: !!box.capabilities.loadSession,
      });
    }
    cursor = page.nextCursor || undefined;
    if (cursor && seen.has(cursor))
      throw new Error('Repeated session list cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

export async function listConversations() {
  if (Date.now() - historyAt < 10_000) return getHistorySnapshot();
  if (!refreshing)
    refreshing = (async () => {
      const results = await Promise.allSettled(
        boxes.map((box) =>
          boxes.length > 1
            ? withTimeout(listBox(box), LIST_TIMEOUT_MS, 'slow box')
            : listBox(box),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed === boxes.length) {
        historyError =
          'Could not update the history. The last available list is shown.';
        return;
      }
      // A box that did not answer keeps its last known threads; they open again once it is back.
      history = results.flatMap((result, i) =>
        result.status === 'fulfilled'
          ? result.value
          : history.filter((c) => locate(c.id)?.box === boxes[i]),
      );
      for (const box of boxes) for (const s of box.sessions.values()) remember(s);
      history.sort((a, b) => b.updatedAt - a.updatedAt);
      historyError = failed
        ? 'Part of the history could not be updated. The last available list is shown.'
        : null;
      historyAt = Date.now();
    })().finally(() => {
      refreshing = undefined;
    });
  await refreshing;
  return getHistorySnapshot();
}

/**
 * Opens a thread on the reachable box with the most room. A box that is full of busy threads or
 * cannot be reached passes it to the next one; the last error is the answer when none can.
 */
export async function createConversation(model?: string | null) {
  let failure: unknown;
  for (const box of boxesByRoom()) {
    try {
      return await box.exclusive(() => createOn(box, model));
    } catch (error) {
      if (error instanceof Response && error.status !== 409) throw error;
      failure = error;
    }
  }
  throw failure;
}

async function createOn(box: AgentBox, model?: string | null) {
  await box.connect();
  const session = new GooseSession(box, 'nuevo', CWD);
  await box.open(session, false);
  if (model) {
    const option = session.configOptions.find(
      (option) => option.category === 'model' || option.id === 'model',
    );
    if (option) {
      try {
        await session.setConfigOption(option.id, model);
      } catch {
        /* Catalog changed: keep the model confirmed by the agent. */
      }
    }
  }
  historyAt = 0;
  markActivity();
  return session.id;
}

export function loadConversation(
  id: string,
  options: { replayTail?: number; reload?: boolean } = {},
) {
  const place = locate(id);
  if (!place)
    return Promise.reject(
      new Response('This conversation was on an agent box that is no longer configured.', {
        status: 404,
      }),
    );
  const { box, local } = place;
  return box.exclusive(async () => {
    const open = liveSession(id);
    if (
      open &&
      // A reload or another replay window reopens the thread, but never under a running turn.
      (open.busy ||
        (!options.reload &&
          open.replayTail ===
            (replayMetadata(box.agentName, options.replayTail)._meta
              ? options.replayTail
              : undefined)))
    ) {
      open.usedAt = Date.now();
      markActivity();
      return open;
    }
    await box.connect();
    if (!box.capabilities.loadSession)
      throw new Response(
        'The agent does not allow reopening saved conversations.',

        { status: 409 },
      );
    await open?.close();
    await box.connect();
    if (!history.some((c) => c.id === id)) await listConversations();
    const row = history.find((c) => c.id === id);
    const session = new GooseSession(box, local, row?.cwd ?? CWD);
    if (row) {
      session.title = row.title;
      session.createdAt = row.createdAt;
      session.updatedAt = row.updatedAt;
    }
    try {
      await box.open(session, true, options.replayTail);
    } catch (error) {
      if (error instanceof Response) throw error;
      throw new Response(
        'Could not retrieve this conversation from the agent.',
        {
          status: 502,
        },
      );
    }
    markActivity();
    return session;
  });
}
export function getConversation(id: string) {
  return liveSession(id) ?? null;
}
export function getMessages(id: string): StoredMessage[] {
  return getConversation(id)?.messages ?? [];
}
export async function closeConversation(id: string) {
  const s = getConversation(id);
  if (!s) return false;
  return s.box.exclusive(async () => {
    if (s.closed) return false;
    await s.close();
    return true;
  });
}
export function askConversation(
  id: string,
  text: string,
  images: PromptImage[] = [],
  files: AttachedFile[] = [],
) {
  const s = getConversation(id);
  if (!s) return false;
  markActivity();
  return s.ask(text, images, undefined, files);
}

/**
 * A turn requested from outside the browser (WhatsApp...). A demo guest's turn goes to that guest's thread; the owner's goes to the thread used most recently, or opens one. Channels take turns: if that thread is answering (the web chat or another group), the next one waits for it to finish.
 * Resolves with the full agent's response text and images returned by its tools.
 */
let channelQueue = Promise.resolve();
export function askFromChannel(
  text: string,
  via: string,
  from?: string,
  images: PromptImage[] = [],
  owner?: string,
) {
  const turn = channelQueue.then(
    async (): Promise<{ text: string; images: PromptImage[] }> => {
      if (demoEnabled() && !owner)
        throw new AgentError('Missing demo channel owner.');

      let session: GooseSession | undefined;
      if (owner) {
        const id = await demoChannelConversation(owner, () =>
          createConversation(),
        );
        session = await loadConversation(id);
      } else {
        session = latestSession();
      }
      if (!session) session = getConversation(await createConversation()) ?? undefined;
      if (!session || session.closed)
        throw new AgentError('There is no open thread with the agent.');
      // Simple queue: waits until the turn in progress is released and, if someone else slipped in, retries.
      for (let attempt = 0; attempt < 20; attempt++) {
        await session.whenIdle();
        while (session.configuringExtensions)
          await new Promise((r) => setTimeout(r, 250));
        if (session.closed)
          throw new AgentError(
            'The thread was closed while waiting for the turn.',
          );

        const answer = new Promise<{ text: string; images: PromptImage[] }>(
          (resolve, reject) => {
            const ok = session!.ask(text, images, {
              via,
              from,
              onAnswer: (answer, error, images) =>
                error && !answer
                  ? reject(new AgentError(error))
                  : resolve({ text: answer, images }),
            });
            if (!ok) reject(new Error('busy'));
          },
        );
        try {
          markActivity();
          return await answer;
        } catch (error) {
          if ((error as Error).message === 'busy') continue;
          // The box went to sleep and the WebSocket dropped with the turn in flight: the thread was closed.
          // Reopen one (that wakes the box) and retry just once.
          if (!owner && session.closed && attempt === 0) {
            session = getConversation(await createConversation()) ?? undefined;
            if (!session) throw error;
            continue;
          }
          throw error;
        }
      }
      throw new AgentError('The agent did not become available in time.');
    },
  );
  channelQueue = turn.then(
    () => {},
    () => {},
  );
  return turn;
}
export async function setConversationConfig(
  id: string,
  configId: string,
  value: string | boolean,
) {
  const s = getConversation(id);
  if (!s) return false;
  await s.setConfigOption(configId, value);
  markActivity();
  return true;
}
export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = getConversation(id);
  if (!s) return null;
  s.usedAt = Date.now();
  s.on('event', onEvent);
  // Atomic snapshot on subscribe: covers tokens between loader and SSE, and reconnections.
  onEvent({
    type: 'snapshot',
    messages: s.messages,
    busy: s.busy,
    permissions: s.permissions.snapshot(),
  });
  onEvent({ type: 'started', sessionId: s.id });
  onEvent(s.configEvent());
  onEvent({ type: 'busy', busy: s.busy });
  return () => s.off('event', onEvent);
}
export function getLastConfigOptions() {
  return lastConfigOptions;
}
/** What the agent accepted last time it connected, so the Hub can offer images before a session exists. */
export function getLastAttachmentSupport() {
  const model = lastConfigOptions.find((o) => o.category === 'model' || o.id === 'model');
  const raw = (model?.options ?? []) as any[];
  const values: string[] =
    raw.length && 'group' in (raw[0] ?? {})
      ? raw.flatMap((g) => (g.options ?? []).map((v: any) => v.value))
      : raw.map((v) => v.value);
  return {
    imageSupport: primary.capabilities.promptCapabilities?.image === true,
    visionModels: values.filter(isVisionModel),
  };
}
// The visible URL never includes agent credentials.
const publicWsUrl = (() => {
  try {
    const url = new URL(primary.url);
    url.search = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
})();
export const config = {
  wsUrl: publicWsUrl,
  cwd: CWD,
  agentBox: primary.boxId,
  idleMs: IDLE_MS,
};
let lastActivity = Date.now();
let activeSse = 0;
export const markActivity = () => (lastActivity = Date.now());
export const openSse = () => {
  activeSse++;
  markActivity();
};
export const closeSse = () => {
  activeSse = Math.max(0, activeSse - 1);
};
const anyBusy = () => boxes.some((box) => box.busy());
setInterval(() => {
  if (activeSse === 0 && !anyBusy() && Date.now() - lastActivity > IDLE_MS) {
    lastActivity = Date.now();
    for (const box of boxes)
      void box
        .exclusive(async () => {
          if (activeSse || anyBusy()) return;
          await box.sleep();
        })
        .catch(() => {});
  }
}, 30_000).unref?.();

/** Does not open a session to discover skills. Agents without the extension degrade to an empty list. */
export async function listAgentSkills() {
  // Every box runs the same agent: the first that answers speaks for all.
  for (const box of boxesByRoom()) {
    try {
      const conn = await box.connect();
      const result = await conn.agent.request('_goose/unstable/sources/list', {
        projectDir: CWD,
      });
      return { skills: parseSkills(result), supported: true, error: null };
    } catch (error) {
      if ((error as { code?: number }).code === -32601)
        return { skills: [], supported: false, error: null };
    }
  }
  return {
    skills: [],
    supported: true,
    error: 'Could not load skills. Please try again.',
  };
}

export async function listClientExtensions() {
  try {
    return {
      extensions: summarizeExtensions({ extensions: extensionStore().list() }),
      error: null,
    };
  } catch {
    return {
      extensions: [],
      error: 'Could not read the extensions saved on this client.',
    };
  }
}

export async function listSessionExtensions() {
  const session = latestSession();
  if (!session) return null;
  try {
    const conn = await session.box.connect();
    // goose returns each session extension flat (without wrapper or key): it is identified by its name, which is also what `extensions/remove` expects (`name`, not `extensionKey`).
    // The wrapped form `{ extensionKey, extension }` is also accepted in case it changes.
    type SessionExtension = { name?: string; server?: { name?: string } };
    const response = (await conn.agent.request(
      '_goose/unstable/session/extensions/list',
      { sessionId: session.sessionId },
    )) as {
      extensions: (SessionExtension & {
        extensionKey?: string;
        extension?: SessionExtension;
      })[];
    };
    const extensions = summarizeExtensions({
      extensions: response.extensions.map((entry) => {
        const extension = entry.extension ?? entry;
        return {
          configKey:
            entry.extensionKey ??
            extension.server?.name ??
            extension.name ??
            null,
          enabled: true,
          extension,
        };
      }),
    });
    return {
      id: session.id,
      title: session.title,
      busy: session.busy || session.configuringExtensions,
      extensions,
      error: null,
    };
  } catch (error) {
    return {
      id: session.id,
      title: session.title,
      busy: session.busy,
      extensions: [],
      error:
        (error as { code?: number }).code === -32601
          ? 'The agent does not allow managing extensions for this conversation.'
          : 'Could not retrieve the tools for this conversation.',
    };
  }
}

export function changeSessionExtension(
  id: string,
  operation: 'add' | 'remove',
  key: string,
) {
  const box = getConversation(id)?.box ?? primary;
  return box.exclusive(async () => {
    const session = getConversation(id);
    if (!session || !session.ready || session.box !== box)
      throw new Response(
        'The active conversation has changed. Please refresh the page.',
        { status: 409 },
      );
    if (session.busy)
      throw new Response(
        'Please wait for the current action to finish or stop it before changing tools.',

        { status: 409 },
      );
    session.configuringExtensions = true;
    try {
      const conn = await box.connect();
      if (operation === 'add') {
        const extension = extensionStore().get(key);
        if (!extension)
          throw new Response('The extension no longer exists', { status: 404 });

        await conn.agent.request('_goose/unstable/session/extensions/add', {
          sessionId: session.sessionId,
          extension,
        });
      } else {
        // goose removes by name; the browser can send the client id (UUID) or the name.
        const name = extensionStore().get(key)?.server.name ?? key;
        await conn.agent.request('_goose/unstable/session/extensions/remove', {
          sessionId: session.sessionId,
          name,
        });
      }
      markActivity();
    } finally {
      session.configuringExtensions = false;
    }
  });
}

// Slack connects on its own (Socket Mode), not when a page asks for it like WhatsApp: it starts
// the first time this module loads. Imported late because `slack.ts` imports this module.
void import('./slack').then(({ startSlack }) => startSlack());
