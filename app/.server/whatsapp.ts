/**
 * The WhatsApp channel — spec 5.
 *
 * The app acts as another linked device: `makeWASocket` runs in this same process, and the phone
 * sees it as another WhatsApp Web session. Baileys delivers everything that arrives at the number;
 * here we decide where to respond (only groups with the switch turned on), batch up bursts
 * into a single turn, and send the reply through the channel it came in. The agent doesn't know through which
 * channel they were contacted: they only see `askFromChannel`.
 */
import {
  claimDemoNumber,
  demoEnabled,
  demoStatus,
  demoMessage,
  DemoLimitError,
} from './demo';
import { EventEmitter } from 'node:events';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  initAuthCreds,
  isJidGroup,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type AuthenticationCreds,
  type ConnectionState,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import { askFromChannel, type PromptImage } from './acp';
import { clientDbPath } from './extensions';

export type WaPhase =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'pairing'
  | 'connected'
  | 'failed';

export interface WaStatus {
  phase: WaPhase;
  /** The QR as a data URL. Never saved: lives in memory during the handshake. */
  qr?: string;
  /** The 8-character code when pairing with the number. */
  pairingCode?: string;
  /** The linked number, already connected. */
  user?: { id: string; name?: string };
  error?: string;
  since: number;
}

export interface WaGroup {
  jid: string;
  subject: string;
  enabled: boolean;
  seenAt: number;
}

export type WaEvent =
  | { type: 'status'; status: WaStatus }
  | { type: 'groups'; groups: WaGroup[] };

// Baileys logs through pino. By default we don't want its log in ours; with `WHATSAPP_LOG`
// (`info`, `debug`, `trace`) it dumps to the console to debug a handshake that won't complete.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const LOG_LEVEL = process.env.WHATSAPP_LOG?.toLowerCase() ?? '';
function makeLogger(level: string, bindings: Record<string, unknown> = {}) {
  const threshold = LEVELS.indexOf(level);
  const log = (name: string) => (obj: unknown, msg?: string) => {
    if (threshold < 0 || LEVELS.indexOf(name) < threshold) return;
    const extra =
      typeof obj === 'object' && obj !== null
        ? { ...bindings, ...(obj as object) }
        : { ...bindings, value: obj };
    if ((extra as { err?: unknown }).err instanceof Error)
      (extra as { err: unknown }).err = String(
        (extra as { err: Error }).err.stack ?? extra,
      );
    console.log(
      `[whatsapp:${name}] ${msg ?? (typeof obj === 'string' ? obj : '')} ${Object.keys(extra).length ? JSON.stringify(extra).slice(0, 2000) : ''}`,
    );
  };
  const logger = {
    level: threshold < 0 ? 'silent' : level,
    child(extra: Record<string, unknown>) {
      return makeLogger(level, { ...bindings, ...extra });
    },
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return logger;
}
const silent = makeLogger(LOG_LEVEL);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS whatsapp_auth (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_groups (
    jid     TEXT PRIMARY KEY,
    subject TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    seen_at INTEGER NOT NULL
  );
`;

/** How long to wait for a burst of incoming messages before opening a turn. */
const BURST_MS = 1500;
/** Signal (encryption) keys arrive in bursts during pairing: they are written together, or the handshake breaks. */
const AUTH_FLUSH_MS = 600;
const MAX_RECONNECTS = 5;
const GROUPS_TTL_MS = 60_000;
/** WhatsApp rejects a long caption; the rest goes as a separate message. */
const CAPTION_MAX = 1024;

// ---------------------------------------------------------------------------
// Persistence: credentials and group allowlist, in the same db as the extensions.
// ---------------------------------------------------------------------------
class WhatsAppStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /**
   * The Baileys authentication state persisted on sqlite. All lives in memory (reads for the handshake are many and in practice synchronous) and is flushed to the db with debounce.
   */
  authState() {
    const cache = new Map<string, unknown>();
    for (const row of this.db
      .prepare('SELECT key, value FROM whatsapp_auth')
      .all() as { key: string; value: string }[]) {
      cache.set(row.key, JSON.parse(row.value, BufferJSON.reviver));
    }
    const creds =
      (cache.get('creds') as AuthenticationCreds | undefined) ??
      initAuthCreds();
    cache.set('creds', creds);
    const dirty = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const upsert = this.db.prepare(
      'INSERT INTO whatsapp_auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const remove = this.db.prepare('DELETE FROM whatsapp_auth WHERE key = ?');
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!dirty.size) return;
      this.db.exec('BEGIN');
      try {
        for (const key of dirty) {
          if (cache.has(key))
            upsert.run(
              key,
              JSON.stringify(cache.get(key), BufferJSON.replacer),
            );
          else remove.run(key);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      dirty.clear();
    };
    const mark = (key: string) => {
      dirty.add(key);
      timer ??= setTimeout(flush, AUTH_FLUSH_MS);
    };
    const keys: SignalKeyStore = {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = cache.get(`${type}:${id}`);
          if (value === undefined || value === null) continue;
          if (type === 'app-state-sync-key')
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
            );
          out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: (data) => {
        for (const category of Object.keys(
          data,
        ) as (keyof SignalDataTypeMap)[]) {
          for (const [id, value] of Object.entries(data[category] ?? {})) {
            const key = `${category}:${id}`;
            if (value) cache.set(key, value);
            else cache.delete(key);
            mark(key);
          }
        }
      },
    };
    return {
      creds,
      keys,
      saveCreds: () => mark('creds'),
      flush,
      clear: () => {
        clearTimeout(timer);
        timer = undefined;
        cache.clear();
        dirty.clear();
        this.db.exec('DELETE FROM whatsapp_auth');
      },
    };
  }

  /** Is a number linked? Checked before reconnect on server startup only. */
  registered() {
    const row = this.db
      .prepare("SELECT value FROM whatsapp_auth WHERE key = 'creds'")
      .get() as { value: string } | undefined;
    if (!row) return false;
    try {
      return JSON.parse(row.value).registered === true;
    } catch {
      return false;
    }
  }

  listGroups(): WaGroup[] {
    return (
      this.db
        .prepare(
          'SELECT jid, subject, enabled, seen_at FROM whatsapp_groups ORDER BY enabled DESC, seen_at DESC',
        )
        .all() as {
        jid: string;
        subject: string;
        enabled: number;
        seen_at: number;
      }[]
    ).map((row) => ({
      jid: row.jid,
      subject: row.subject,
      enabled: row.enabled === 1,
      seenAt: row.seen_at,
    }));
  }

  /** Record a seen group; if already there, just refresh timestamp (and name, if it arrived). Returns if it's a new group. */
  touchGroup(jid: string, subject?: string) {
    const known = this.db
      .prepare('SELECT subject FROM whatsapp_groups WHERE jid = ?')
      .get(jid) as { subject: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(jid) DO UPDATE SET seen_at = excluded.seen_at, subject = CASE WHEN excluded.subject = '' THEN subject ELSE excluded.subject END`,
      )
      .run(jid, subject ?? '', Date.now());
    return !known || (!!subject && known.subject !== subject);
  }

  enabled(jid: string) {
    const row = this.db
      .prepare('SELECT enabled FROM whatsapp_groups WHERE jid = ?')
      .get(jid) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  setEnabled(jid: string, enabled: boolean) {
    return (
      this.db
        .prepare('UPDATE whatsapp_groups SET enabled = ? WHERE jid = ?')
        .run(Number(enabled), jid).changes !== 0
    );
  }
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------
interface Incoming {
  from: string;
  text: string;
  images: PromptImage[];
  key: WAMessageKey;
}

const SINGLE_EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:[️⃣]|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}[️]?)*$/u;

function unwrap(
  message: proto.IMessage | null | undefined,
): proto.IMessage | undefined {
  if (!message) return undefined;
  // Ephemeral and view-once messages wrap the actual message inside.
  return (
    unwrap(
      message.ephemeralMessage?.message ??
        message.viewOnceMessage?.message ??
        message.viewOnceMessageV2?.message ??
        message.documentWithCaptionMessage?.message,
    ) ?? message
  );
}

/**
 * The agent's text as WhatsApp understands it. An escaped `<artifact>` (despite instructions) is replaced with a note: the file appears in the web chat, where the same turn painted it. From markdown, only minimal translation: bold, headings, code fences.
 */
export function paraWhatsApp(text: string) {
  return text
    .replace(
      /<artifact\b[^>]*?\btitle\s*=\s*"([^"]*)"[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi,
      (_, title) => `📎 _${title || 'Archivo'}_ (see it in the web chat)`,
    )
    .replace(
      /<artifact\b[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi,
      '📎 _Archivo_ (see it in the web chat)',
    )
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^```[^\n]*\n([\s\S]*?)```$/gm, '```$1```')
    .trim();
}

class WhatsAppChannel extends EventEmitter {
  status: WaStatus = { phase: 'disconnected', since: Date.now() };
  private store: WhatsAppStore;
  private auth: ReturnType<WhatsAppStore['authState']> | undefined;
  private sock: WASocket | undefined;
  private generation = 0;
  private wanted = false;
  private attempts = 0;
  private pairPhone: string | undefined;
  private retry: NodeJS.Timeout | undefined;
  /** Ids of messages we send: so we don't respond to ourselves and to know which messages are reacted to. */
  private ownIds = new Set<string>();
  private buffers = new Map<
    string,
    { items: Incoming[]; timer: NodeJS.Timeout }
  >();
  private groupsAt = 0;

  private owner: string | undefined;
  private limitNotices = new Set<string>();
  constructor(store: WhatsAppStore, owner?: string) {
    super();
    this.store = store;
    this.owner = owner;
  }

  private setStatus(patch: Partial<WaStatus> & { phase: WaPhase }) {
    this.status = { ...patch, since: Date.now() };
    this.emit('event', {
      type: 'status',
      status: this.status,
    } satisfies WaEvent);
  }

  snapshot() {
    return { status: this.status, groups: this.store.listGroups() };
  }

  /** Reconnects on first request if there are credentials from a previous life. */
  rehidratar() {
    if (this.sock || this.wanted || !this.store.registered()) return;
    void this.connect();
  }

  /**
   * Opens the socket. With `phone`, requests the 8-character pairing code instead of QR. It's the same handshake: requesting one cancels the other.
   */
  async connect(phone?: string) {
    if (this.owner && demoStatus(this.owner).exhausted) {
      this.setStatus({ phase: 'disconnected', error: demoMessage() });
      return;
    }
    this.teardown();
    const gen = ++this.generation;
    this.wanted = true;
    this.pairPhone = phone;
    this.setStatus({ phase: 'connecting' });
    try {
      this.auth ??= this.store.authState();
      const { creds, keys, saveCreds } = this.auth;
      // The WhatsApp Web version announced by the socket: latest if fetched within 5s,
      // fallback to Baileys default otherwise.
      const version = await Promise.race([
        fetchLatestWaWebVersion({}).then(
          (v) => v.version as WAVersion,
          () => undefined,
        ),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 5000),
        ),
      ]);
      if (gen !== this.generation) return;
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds, keys: makeCacheableSignalKeyStore(keys, silent) },
        logger: silent,
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on(
        'connection.update',
        (update) => void this.onConnection(gen, update),
      );
      sock.ev.on(
        'messages.upsert',
        (event) => void this.onMessages(gen, event),
      );
      if (phone && !creds.registered) {
        setTimeout(async () => {
          if (gen !== this.generation) return;
          try {
            const code = await sock.requestPairingCode(phone);
            if (gen === this.generation)
              this.setStatus({ phase: 'pairing', pairingCode: code });
          } catch (error) {
            if (gen === this.generation)
              this.setStatus({
                phase: 'failed',
                error: `Couldn't request the code: ${(error as Error).message}`,
              });
          }
        }, 1500);
      }
    } catch (error) {
      if (gen === this.generation)
        this.setStatus({ phase: 'failed', error: (error as Error).message });
    }
  }

  /** Closes the socket. With `logout` also unlinks the device and erases credentials. */
  async disconnect(logout = false) {
    this.wanted = false;
    const sock = this.sock;
    this.teardown();
    if (logout) {
      try {
        await sock?.logout();
      } catch {}
      this.auth?.clear();
      this.auth = undefined;
    } else {
      this.auth?.flush();
    }
    this.setStatus({ phase: 'disconnected' });
  }

  private teardown() {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.generation++;
    const sock = this.sock;
    this.sock = undefined;
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.end(undefined);
      } catch {}
    }
  }

  private async onConnection(gen: number, update: Partial<ConnectionState>) {
    if (gen !== this.generation) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr && !this.pairPhone) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (gen === this.generation)
        this.setStatus({ phase: 'qr_pending', qr: dataUrl });
    }
    if (connection === 'open') {
      this.attempts = 0;
      this.pairPhone = undefined;
      this.auth?.flush();
      const me = this.sock?.user;
      if (
        this.owner &&
        (!me || !claimDemoNumber(this.owner, me.id.split(':')[0].split('@')[0]))
      ) {
        await this.disconnect(true);
        this.setStatus({
          phase: 'disconnected',
          error:
            'This number is already used in a demo. Open the browser where you paired it or contact Ismael.',
        });
        return;
      }
      this.setStatus({
        phase: 'connected',
        user: me
          ? { id: me.id.split(':')[0].split('@')[0], name: me.name }
          : undefined,
      });
      // With the 60s cache intact: reconnecting several times quickly shouldn't re-request the list every time (WhatsApp would reply `rate-overlimit`).
      void this.groups(true);
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      this.sock = undefined;
      if (code === DisconnectReason.loggedOut) {
        this.wanted = false;
        this.auth?.clear();
        this.auth = undefined;
        this.setStatus({
          phase: 'disconnected',
          error: 'The phone logged out. Pair again.',
        });
        return;
      }
      if (!this.wanted) return;
      // 515 is routine after pairing: WhatsApp requests reopening the socket. Doesn't count as failure.
      if (code === DisconnectReason.restartRequired) {
        this.setStatus({ phase: 'connecting' });
        this.retry = setTimeout(() => void this.connect(this.pairPhone), 500);
        return;
      }
      this.attempts++;
      if (this.attempts > MAX_RECONNECTS) {
        this.wanted = false;
        this.setStatus({
          phase: 'failed',
          error: `Connection lost (${code ?? 'no code'}) and didn't return after ${MAX_RECONNECTS} attempts.`,
        });
        return;
      }
      const wait = Math.min(30_000, 2 ** this.attempts * 1000);
      this.setStatus({
        phase: 'connecting',
        error: `Connection lost (${code ?? 'no code'}); retry ${this.attempts} in ${wait / 1000} s.`,
      });
      this.retry = setTimeout(() => void this.connect(this.pairPhone), wait);
    }
  }

  /** The groups the number is in. `groupFetchAllParticipating` is cached 60s and never runs in polling. */
  async groups(refresh = false): Promise<WaGroup[]> {
    const sock = this.sock;
    if (
      refresh &&
      sock &&
      this.status.phase === 'connected' &&
      Date.now() - this.groupsAt > GROUPS_TTL_MS
    ) {
      this.groupsAt = Date.now();
      try {
        const all = await sock.groupFetchAllParticipating();
        let changed = false;
        for (const [jid, meta] of Object.entries(all))
          changed = this.store.touchGroup(jid, meta.subject) || changed;
        if (changed)
          this.emit('event', {
            type: 'groups',
            groups: this.store.listGroups(),
          } satisfies WaEvent);
      } catch (error) {
        console.warn(
          '[whatsapp] could not list groups:',
          (error as Error).message,
        );
      }
    }
    return this.store.listGroups();
  }

  setGroup(jid: string, enabled: boolean) {
    if (!isJidGroup(jid)) return false;
    const ok = this.store.setEnabled(jid, enabled);
    if (ok)
      this.emit('event', {
        type: 'groups',
        groups: this.store.listGroups(),
      } satisfies WaEvent);
    return ok;
  }

  private grupoActivo(jid: string) {
    return isJidGroup(jid) && this.store.enabled(jid);
  }

  private async onMessages(
    gen: number,
    event: { type: string; messages: WAMessage[] },
  ) {
    if (gen !== this.generation || event.type !== 'notify') return;
    for (const m of event.messages) {
      const jid = m.key.remoteJid ?? '';
      if (!isJidGroup(jid)) continue;
      // Messages sent by THIS process (agent responses) are recognized by id. Messages from the owner of the number also arrive as `fromMe`, and those DO count: otherwise, those pairing their own number can't speak to the agent.
      if (m.key.id && this.ownIds.has(m.key.id)) continue;
      // A new group appears in the list when someone writes to it.
      if (this.store.touchGroup(jid))
        this.emit('event', {
          type: 'groups',
          groups: this.store.listGroups(),
        } satisfies WaEvent);
      if (!this.grupoActivo(jid)) continue;
      if (this.owner && demoStatus(this.owner).exhausted) {
        if (!this.limitNotices.has(jid)) {
          this.limitNotices.add(jid);
          await this.send(jid, { text: demoMessage() });
        }
        continue;
      }
      const msg = unwrap(m.message);
      if (!msg) continue;
      const from =
        m.pushName ||
        (m.key.fromMe ? this.status.user?.name : undefined) ||
        (m.key.participant ?? '').split('@')[0] ||
        'someone';
      if (msg.reactionMessage) {
        const target = msg.reactionMessage.key?.id;
        const emoji = msg.reactionMessage.text;
        // Only reactions to messages we sent; removing a reaction comes with empty text.
        if (!target || !this.ownIds.has(target) || !emoji) continue;
        this.enqueue(jid, {
          from,
          text: `${from} reacted with ${emoji} to an agent message.`,
          images: [],
          key: m.key,
        });
        continue;
      }
      let text = msg.conversation ?? msg.extendedTextMessage?.text ?? '';
      const images: PromptImage[] = [];
      if (msg.imageMessage) {
        try {
          const buffer = await downloadMediaMessage(m, 'buffer', {});
          images.push({
            mimeType: msg.imageMessage.mimetype || 'image/jpeg',
            data: buffer.toString('base64'),
          });
        } catch (error) {
          console.warn(
            '[whatsapp] could not download photo:',
            (error as Error).message,
          );
        }
        text = msg.imageMessage.caption || text;
      }
      if (!text && !images.length) continue;
      this.enqueue(jid, { from, text, images, key: m.key });
    }
  }

  // Several messages in a row are ONE turn: batched for 1.5s and sent as a single request.
  private enqueue(jid: string, item: Incoming) {
    const pending = this.buffers.get(jid);
    if (pending) clearTimeout(pending.timer);
    const items = pending?.items ?? [];
    items.push(item);
    this.buffers.set(jid, {
      items,
      timer: setTimeout(() => {
        this.buffers.delete(jid);
        void this.turn(jid, items);
      }, BURST_MS),
    });
  }

  private async react(key: WAMessageKey, text: string) {
    try {
      await this.sock?.sendMessage(key.remoteJid!, { react: { text, key } });
    } catch {}
  }

  private async turn(jid: string, items: Incoming[]) {
    const sock = this.sock;
    if (!sock) return;
    const last = items[items.length - 1];
    void this.react(last.key, '👀');
    const composing = () =>
      sock.sendPresenceUpdate('composing', jid).catch(() => {});
    void composing();
    const typing = setInterval(composing, 8000);
    const text = items.map((i) => `${i.from}: ${i.text}`.trim()).join('\n');
    const images = items.flatMap((i) => i.images);
    const from = [...new Set(items.map((i) => i.from))].join(', ');
    try {
      const answer = await askFromChannel(
        text,
        'whatsapp',
        from,
        images,
        this.owner,
      );
      clearInterval(typing);
      void this.sock?.sendPresenceUpdate('paused', jid).catch(() => {});
      // The turn could take minutes: `send` uses the current socket, not the one from back then.
      await this.deliver(jid, last.key, answer);
      void this.react(last.key, '✅');
      if (this.owner && answer.text.includes(demoMessage()))
        this.limitNotices.add(jid);
      if (
        this.owner &&
        demoStatus(this.owner).exhausted &&
        !this.limitNotices.has(jid)
      ) {
        this.limitNotices.add(jid);
        await this.send(jid, { text: demoMessage() });
      }
    } catch (error) {
      clearInterval(typing);
      console.warn('[whatsapp] turn failed:', (error as Error).message);
      if (!(error instanceof DemoLimitError) || !this.limitNotices.has(jid)) {
        if (error instanceof DemoLimitError) this.limitNotices.add(jid);
        await this.send(jid, {
          text: `⚠️ ${error instanceof Response ? await error.text() : (error as Error).message || 'Could not answer.'}`,
        });
      }
      void this.react(last.key, '❌');
    }
  }

  private async deliver(
    jid: string,
    replyTo: WAMessageKey,
    answer: { text: string; images: PromptImage[] },
  ) {
    const text = paraWhatsApp(answer.text);
    // If the agent replies with a single emoji, send as a reaction.
    if (!answer.images.length && text && SINGLE_EMOJI.test(text)) {
      await this.react(replyTo, text);
      return;
    }
    if (!answer.images.length) {
      await this.send(jid, { text: text || '(no response)' });
      return;
    }
    // Images from tools go as a photo with the caption as the first image's caption.
    let caption = text;
    let rest = '';
    if (caption.length > CAPTION_MAX) {
      rest = caption;
      caption = '';
    }
    for (const [index, image] of answer.images.entries()) {
      await this.send(jid, {
        image: Buffer.from(image.data, 'base64'),
        mimetype: image.mimeType,
        ...(index === 0 && caption ? { caption } : {}),
      });
    }
    if (rest) await this.send(jid, { text: rest });
  }

  private async send(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
  ) {
    const sent = await this.sock?.sendMessage(jid, content);
    if (sent?.key.id) {
      this.ownIds.add(sent.key.id);
      // Bounded: the ids are only used to recognize recent reactions.
      if (this.ownIds.size > 500)
        this.ownIds.delete(this.ownIds.values().next().value!);
    }
    return sent;
  }
}

// The singleton lives in `globalThis`: in development Vite reevaluates this module with every edit
// and a module `let` would create a second channel with the same credentials. Two sockets with the
// same number expel each other (conflict 440) and the state oscillates connecting/connected.
// Price: in dev, a change in this class requires restarting the server for it to take effect.
const GLOBAL_KEY = Symbol.for('acp-agent-ui.whatsapp');
const DEMO_KEY = Symbol.for('acp-agent-ui.whatsapp-demo');
export function whatsappChannel(owner?: string): WhatsAppChannel {
  if (demoEnabled() && !owner)
    throw new Error('Demo WhatsApp requires an owner');
  if (owner) {
    if (!/^[a-f0-9-]{36}$/.test(owner)) throw new Error('Invalid demo owner');
    const globals = globalThis as { [DEMO_KEY]?: Map<string, WhatsAppChannel> };
    const channels = (globals[DEMO_KEY] ??= new Map());
    let channel = channels.get(owner);
    if (!channel) {
      const directory = dirname(process.env.DEMO_DB ?? '.data/demo.db');
      channel = new WhatsAppChannel(
        new WhatsAppStore(join(directory, 'whatsapp-guests', `${owner}.db`)),
        owner,
      );
      channels.set(owner, channel);
      channel.setMaxListeners(100);
      channel.rehidratar();
    }
    return channel;
  }
  const globals = globalThis as { [GLOBAL_KEY]?: WhatsAppChannel };
  if (!globals[GLOBAL_KEY]) {
    const channel = new WhatsAppChannel(new WhatsAppStore(clientDbPath()));
    channel.setMaxListeners(100);
    channel.rehidratar();
    globals[GLOBAL_KEY] = channel;
  }
  return globals[GLOBAL_KEY];
}
