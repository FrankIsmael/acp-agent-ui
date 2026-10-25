/**
 * POST /api/lathe/jobs — asks the lathe agent for a job. Body `{ prompt, sessionId?, setup? }`,
 * where `setup` is the bar and tools loaded in the page.
 *
 * The response is the event stream itself (`text/event-stream`): `status`, `session`, `text`,
 * `job`, `error`, then `done`. Closing the request cancels the agent's turn.
 */
import type { Route } from './+types/api.lathe.jobs';
import { requireAdmin } from '~/.server/admin-gate';
import { demoEnabled, demoUser, isFullAccess } from '~/.server/demo';
import { AgentError } from '~/.server/errors';
import { requestJob, type LatheEvent } from '~/.server/lathe-agent';
import { setupSchema } from '~/lathe/sim/job-schema';

const MAX_PROMPT = 4000;

export async function action({ request }: Route.ActionArgs) {
  // In the demo, only invited guests (identified by the middleware) prompt the agent.
  if (!demoEnabled()) requireAdmin(request);
  else if (!isFullAccess(demoUser(request)!))
    return Response.json({ error: 'The lathe agent is only for invited guests.' }, { status: 403 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.json().catch(() => null);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
  const setup = setupSchema.safeParse(body?.setup); // what the page has loaded; ignored if malformed
  if (!prompt) return Response.json({ error: 'Describe the part first.' }, { status: 400 });
  if (prompt.length > MAX_PROMPT) return Response.json({ error: `Keep the description under ${MAX_PROMPT} characters.` }, { status: 400 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // the browser already left
        }
      };
      const send = (event: LatheEvent | { type: 'done' }) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const beat = setInterval(() => write(': ping\n\n'), 25_000);
      write(': connected\n\n');
      requestJob({ prompt, sessionId, setup: setup.success ? setup.data : undefined }, send, abort.signal)
        .catch((error) => {
          if (!(error instanceof AgentError)) console.error('[lathe] job failed:', error);
          send({ type: 'error', message: error instanceof AgentError ? error.message : 'The lathe agent failed.' });
        })
        .finally(() => {
          clearInterval(beat);
          send({ type: 'done' });
          try { controller.close(); } catch {}
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
}
