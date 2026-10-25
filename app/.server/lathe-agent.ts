/**
 * ACP client for the lathe agent box (docs/lathe/plan.md, section 4). Separate from `acp.ts` on
 * purpose: its own connection, its own `CNC_*` environment, no shared state with the chat.
 *
 * One turn = one prompt, tagged `[skill: lathe-job]` for the skill installed on the box
 * (docs/lathe/plan.md, section 5). If the reply's job doesn't pass the schema or the simulator,
 * the problems go back to the agent as automatic follow-ups.
 */
import { client, type ClientConnection } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { WebSocket } from 'ws';
import { jobFromReply } from '~/lathe/agent-reply';
import { checkJob } from '~/lathe/sim/check';
import type { Job, Setup } from '~/lathe/sim/job-schema';
import { setupBrief } from '~/lathe/setup-brief';
import { AgentError } from './errors';

const clean = (value: string | undefined) => (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
const WS_URL = clean(process.env.CNC_ACP_WS_URL);
const TOKEN = clean(process.env.CNC_ACP_SECRET);
// The secret goes in the Authorization header. Only for a proxy that drops headers on the
// WebSocket upgrade, CNC_ACP_TOKEN_IN_URL=1 also puts it in `?token=` (where logs can see it).
const TOKEN_IN_URL = clean(process.env.CNC_ACP_TOKEN_IN_URL) === '1';
const CWD = clean(process.env.CNC_ACP_CWD) || '/data/work';
const IDLE_MS = Number(process.env.CNC_ACP_IDLE_MS) || 5 * 60_000;
const SESSION_TIMEOUT_MS = Number(process.env.CNC_ACP_SESSION_TIMEOUT_MS) || 60_000;
// A turn that runs longer is cancelled: the agent thinks silently, and that thinking is billed.
const TURN_TIMEOUT_MS = Number(process.env.CNC_ACP_TURN_TIMEOUT_MS) || 4 * 60_000;
// The box's default effort thinks for minutes over a job the simulator checks anyway.
const THINKING_EFFORT = clean(process.env.CNC_ACP_THINKING_EFFORT) || 'medium';
const CONNECT_TIMEOUT_MS = 90_000; // a sleeping box takes ~20 s to wake on the WebSocket upgrade
const JOBS_PER_HOUR = 20;
const FIX_TURNS = 1; // follow-up turns with the problems found, before giving the job as it is

export const latheAgentConfigured = () => WS_URL !== '';

export type LatheEvent =
  | { type: 'status'; status: 'waking' | 'thinking' | 'writing' | 'fixing' }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'job'; job: Job }
  | { type: 'error'; message: string; errors?: string[] };

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// --- Connection -----------------------------------------------------------------------------

let connection: ClientConnection | undefined;
let connecting: Promise<ClientConnection> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
const listeners = new Map<string, (update: any) => void>();
const known = new Set<string>(); // sessions opened on the current connection
const activeTurns = new Set<string>();

function touch() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (activeTurns.size) return touch();
    connection?.close(); // lets the box go back to sleep
  }, IDLE_MS);
}

async function connect(): Promise<ClientConnection> {
  if (connection && !connection.signal.aborted) return connection;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!WS_URL) throw new AgentError('The lathe agent is not set up (CNC_ACP_WS_URL is missing on the server).');
    const target = new URL(WS_URL);
    if (TOKEN && TOKEN_IN_URL && !target.searchParams.has('token')) target.searchParams.set('token', TOKEN);
    const app = client({ name: 'acp-lathe' } as any);
    app.onNotification('session/update', ({ params }: any) => listeners.get(params.sessionId)?.(params.update));
    app.onRequest('session/request_permission', ({ params }: any) => {
      // The skill needs no tools; anything that asks is refused.
      console.warn('[lathe] refused a permission request:', params.toolCall?.title ?? params.toolCall?.kind ?? 'tool');
      return { outcome: { outcome: 'cancelled' } };
    });
    // A box that refuses the connection answers with an `id: null` JSON-RPC error and closes;
    // the SDK drops it, so read it from the raw socket and stop waiting when it closes.
    let rejection = '';
    let socketClosed!: Promise<never>;
    class ObservedWebSocket extends WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        socketClosed = new Promise((_, reject) => {
          this.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.id === null && msg.error?.message) rejection = msg.error.message;
            } catch {}
          });
          this.on('close', () => reject(new AgentError(rejection || 'The lathe agent closed the connection before responding.')));
        });
        socketClosed.catch(() => {});
      }
    }
    const conn = app.connect(
      createWebSocketStream(target.toString(), {
        WebSocket: ObservedWebSocket,
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
      } as any),
    );
    try {
      await withTimeout(
        Promise.race([
          conn.agent.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          }),
          socketClosed,
        ]),
        CONNECT_TIMEOUT_MS,
        'The lathe agent did not respond in time.',
      );
    } catch (error) {
      conn.close();
      throw error instanceof AgentError ? error : new AgentError('Could not connect to the lathe agent.');
    }
    connection = conn;
    known.clear();
    conn.closed.then(() => { if (connection === conn) connection = undefined; }).catch(() => {});
    touch();
    return conn;
  })().finally(() => { connecting = undefined; });
  return connecting;
}

// --- Turns ----------------------------------------------------------------------------------

const recent: number[] = [];
function allowJob() {
  const hourAgo = Date.now() - 3600_000;
  while (recent.length && recent[0] < hourAgo) recent.shift();
  if (recent.length >= JOBS_PER_HOUR) return false;
  recent.push(Date.now());
  return true;
}

/**
 * Asks the lathe agent for a job. Events stream through `emit`; the promise settles when the turn
 * (and the possible fix-up turn) ends. Aborting `signal` sends `session/cancel`.
 */
export async function requestJob(
  input: { prompt: string; sessionId?: string; setup?: Setup },
  emit: (event: LatheEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!allowJob()) throw new AgentError(`Limit of ${JOBS_PER_HOUR} lathe jobs per hour reached; try again later.`);
  if (!connection || connection.signal.aborted) emit({ type: 'status', status: 'waking' });
  const conn = await connect();

  // Sessions from an earlier connection aren't loaded here; a follow-up after that starts fresh.
  let sessionId = input.sessionId && known.has(input.sessionId) ? input.sessionId : undefined;
  let firstTurn = false;
  if (!sessionId) {
    const response: any = await withTimeout(
      conn.agent.request('session/new', { cwd: CWD, mcpServers: [] }),
      SESSION_TIMEOUT_MS,
      'The lathe agent did not open a session in time.',
    );
    sessionId = response.sessionId as string;
    known.add(sessionId);
    if (response.configOptions?.some((option: any) => option.id === 'thinking_effort'))
      await withTimeout(
        conn.agent.request('session/set_config_option', { sessionId, configId: 'thinking_effort', value: THINKING_EFFORT }),
        SESSION_TIMEOUT_MS,
        'The lathe agent did not set its thinking effort in time.',
      ).catch((error) => console.warn('[lathe] thinking effort left as it was:', error?.message ?? error));
    firstTurn = true;
  }
  emit({ type: 'session', sessionId });

  const turn = async (text: string) => {
    let reply = '';
    emit({ type: 'status', status: 'thinking' });
    listeners.set(sessionId!, (update) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        if (!reply) emit({ type: 'status', status: 'writing' });
        reply += update.content.text;
        emit({ type: 'text', text: update.content.text });
      }
      touch();
    });
    const onAbort = () => void conn.agent.notify('session/cancel', { sessionId }).catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    activeTurns.add(sessionId!);
    try {
      const result: any = await withTimeout(
        conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
        TURN_TIMEOUT_MS,
        `The lathe agent took more than ${Number((TURN_TIMEOUT_MS / 60_000).toFixed(1))} min and was stopped. Try a simpler part, or ask for it in steps.`,
      ).catch((error) => {
        onAbort(); // stops the agent's turn; a late answer is ignored
        throw error;
      });
      if (result?.stopReason === 'cancelled' || signal.aborted) throw new AgentError('Cancelled.');
      return reply;
    } finally {
      signal.removeEventListener('abort', onAbort);
      listeners.delete(sessionId!);
      activeTurns.delete(sessionId!);
      touch();
    }
  };

  // The skill is installed on the box; the first turn adds the machine as the page has it.
  const instructions = firstTurn && input.setup ? `${setupBrief(input.setup)}\n\n---\n\n` : '';
  let reply = await turn(`[skill: lathe-job]\n${instructions}${input.prompt}`);
  // Check the format, then run the job through the simulator; send what's wrong back to the agent.
  let job: Job | undefined;
  let problems: string[] = [];
  let fixFailed = '';
  for (let fix = 0; ; fix++) {
    const result = jobFromReply(reply);
    job = result.ok ? result.job : undefined;
    problems = result.ok ? checkJob(result.job) : result.errors;
    if (!problems.length || fix === FIX_TURNS || signal.aborted) break;
    emit({ type: 'status', status: 'fixing' });
    emit({ type: 'text', text: '\n\n' });
    try {
      reply = await turn(
        `[skill: lathe-job]\n${result.ok ? 'I ran your job in the simulator. It' : 'The lathe-job block'} has these problems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFix every one of them (change the values they name, and anything that depends on them), check the rules of the skill again, then send the whole corrected job as one \`\`\`lathe-job block.`,
      );
    } catch (error) {
      // A fix that times out or fails keeps the job from before it, problems and all.
      if (signal.aborted || !(error instanceof AgentError)) throw error;
      fixFailed = error.message;
      break;
    }
  }
  if (job) emit({ type: 'job', job });
  if (problems.length)
    emit({
      type: 'error',
      message:
        (fixFailed ? `The fix-up turn failed (${fixFailed}). ` : '') +
        (job ? 'The simulator still finds problems in this job.' : 'The agent’s job still has problems.'),
      errors: problems,
    });
}
