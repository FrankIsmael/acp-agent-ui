/**
 * Agent box lifecycle (app-owned): the box wakes up when spoken to and sleeps when idle.
 * Two providers, chosen by key: instabox (`INSTABOX_API_KEY`) or EasyBits (`EASYBITS_API_KEY`).
 */
import { readFileSync } from 'node:fs';
import { AgentError } from './errors';

// Optional, with no fallback for the same reason as ACP_WS_URL: they pointed to a specific box and snapshot,
// so a partially filled .env could operate other people's resources. Without them, this is a normal ACP client
// and the lifecycle logic simply doesn't run.
export const AGENT_BOX = process.env.AGENT_BOX_ID ?? '';
const AGENT_SNAPSHOT = process.env.AGENT_SNAPSHOT_ID ?? '';
const EB_KEY =
  process.env.EASYBITS_API_KEY ??
  (() => {
    try {
      return readFileSync('/root/.ebkey', 'utf8').trim();
    } catch {
      return null;
    }
  })();

// instabox (https://api.instabox.sh): the box pauses itself when idle (no agent working, no terminal,
// little CPU) and `resume` brings it back with its processes, so the bridge keeps running and the
// published port keeps its URL. The app sets that idle pause to its own idle time (ACP_IDLE_MS) instead of suspending
// the box itself. The key needs the `machines:read` and `machines:write` scopes.
const INSTABOX_KEY = process.env.INSTABOX_API_KEY ?? '';
const INSTABOX_API = (
  process.env.INSTABOX_API_URL || 'https://api.instabox.sh'
).replace(/\/+$/, '');

type InstaboxMachine = {
  state?: string;
  runtime?: { ready?: boolean };
  autoSuspendAfterSeconds?: number | null;
};

async function instabox(
  path: string,
  method = 'GET',
  body?: object,
): Promise<InstaboxMachine> {
  const headers: Record<string, string> = { 'X-API-Key': INSTABOX_KEY };
  // Every write must carry one.
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(
    `${INSTABOX_API}/v1/machines/${encodeURIComponent(AGENT_BOX)}${path}`,
    { method, headers, body: body && JSON.stringify(body) },
  );
  if (!res.ok)
    throw new Error(`instabox ${method} ${path || '/'}: HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

const isAwake = (box: InstaboxMachine) =>
  box.state === 'running' && box.runtime?.ready === true;

async function ensureInstabox(idleMs: number) {
  let box = await instabox('');
  console.log(`[lifecycle] instabox state=${box.state}`);
  if (!isAwake(box)) {
    if (box.state !== 'running') {
      // `wake` only resumes a box that paused itself; `resume` also covers one paused by hand.
      const action = box.state === 'stopped' ? '/start' : '/resume';
      await instabox(action, 'POST');
    }
    const deadline = Date.now() + 90_000;
    while (!isAwake(box)) {
      if (Date.now() > deadline)
        throw new AgentError(
          'The agent box did not wake up in time. Please try again in a moment.',
        );
      await new Promise((r) => setTimeout(r, 2000));
      box = await instabox('');
    }
    console.log('[lifecycle] instabox is now awake');
  }
  const idle = Math.round(idleMs / 1000);
  if (idle > 0 && box.autoSuspendAfterSeconds !== idle)
    await instabox('', 'PATCH', { autoSuspendAfterSeconds: idle }).catch(
      (e: Error) => console.warn('[lifecycle] idle pause not set:', e.message),
    );
  return box;
}

let ebClient: any = null;
async function getEbClient() {
  if (ebClient) return ebClient;
  if (!EB_KEY) return null;
  try {
    // The SDK is optional: without it, the app still works, it just doesn't manage the box.
    // @ts-ignore -- optional dependency, may not be installed
    const { EasybitsClient } = await import('@easybits.cloud/sdk');
    ebClient = new EasybitsClient({ apiKey: EB_KEY });
  } catch (e: any) {
    console.warn('[lifecycle] sin SDK/API key:', e.message);
    ebClient = null;
  }
  return ebClient;
}

/**
 * Wakes up the agent box BEFORE connecting. OPTIONAL: without `AGENT_BOX_ID` and a key
 * (`INSTABOX_API_KEY`, else `EASYBITS_API_KEY`) this does not run and the client works the same
 * with any ACP agent — only without waking it up (the agent must already be up).
 * `idleMs` is the app's idle time (ACP_IDLE_MS); instabox gets it as the box's own idle pause.
 */
export async function ensureAgentBox(idleMs: number) {
  if (!AGENT_BOX) return null;
  if (INSTABOX_KEY) return ensureInstabox(idleMs);
  const eb = await getEbClient();
  if (!eb) {
    console.warn('[lifecycle] no SDK — not managing agent box lifecycle');
    return null;
  }
  const sb = await eb.sandboxes.get(AGENT_BOX);
  await sb.refresh();
  console.log(`[lifecycle] agent box status=${sb.status}`);
  if (sb.status === 'running') {
    await sb
      .extend(3600)
      .catch((e: Error) =>
        console.warn('[lifecycle] extend failed:', e.message),
      );
    return sb;
  }
  if (sb.status === 'suspended') await sb.resume().catch(() => {});
  try {
    await sb.waitUntilReady(90_000);
    console.log('[lifecycle] agent box is now awake');
    return sb;
  } catch {
    // lost box → self-heal from snapshot
  }
  // Self-healing from snapshot used to create a NEW box — with a new URL — and immediately connect
  // to the old ACP_WS_URL, so it never actually worked: a recovery that lies is worse than none.
  // This is only attempted if a snapshot is configured, and a warning is given that the URL
  // must be updated manually.
  if (!AGENT_SNAPSHOT) {
    throw new AgentError(
      'Agent did not wake up and there is no AGENT_SNAPSHOT_ID to recreate it. Please start it again and update ACP_WS_URL.',
    );
  }
  console.warn('[lifecycle] lost box; self-healing from snapshot');
  const [child] = await eb.sandboxes.forkFromSnapshot(AGENT_SNAPSHOT, {});
  await child.waitUntilReady(90_000);
  console.warn(
    `[lifecycle] box recreated (${child.id}) — ⚠️ its URL is different: update ACP_WS_URL or you will keep connecting to the previous one`,
  );
  return child;
}

/** Suspends an idle EasyBits box. */
export async function suspendAgentBox() {
  if (!AGENT_BOX) return;
  // instabox pauses the box itself once idle (see ensureInstabox).
  if (INSTABOX_KEY) return;
  const eb = await getEbClient();
  if (!eb) return;
  try {
    const sb = await eb.sandboxes.get(AGENT_BOX);
    await sb.refresh();
    if (sb.status === 'running') {
      await sb.suspend();
      console.log('[lifecycle] box suspended (idle)');
    }
  } catch {}
}
