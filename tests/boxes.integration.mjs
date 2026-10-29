import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

// Two mock agents (ACP_BOXES=one,two) that hand out the SAME session ids, as two goose boxes do.
// No real agent, credentials or model calls.
const directory = mkdtempSync(join(tmpdir(), 'acp-boxes-'));
const titlesDb = join(directory, 'titles.db');
const user = (text) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });

async function agent(name) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const state = { name, server, port: server.address().port, live: new Set(), loads: [], created: 0, sockets: new Set() };
  const saved = new Map([['shared', { title: `Saved on ${name}`, updates: [user(`hello ${name}`)] }]]);
  server.on('connection', (ws) => {
    state.sockets.add(ws);
    const owned = new Set();
    const send = (value) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
    ws.on('message', (raw) => {
      for (const line of raw.toString().trim().split('\n')) {
        const { id, method, params = {} } = JSON.parse(line);
        const respond = (result) => send({ id, result });
        if (method === 'initialize')
          respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }, agentInfo: { name: 'ghosty-lite', version: '1.51.0' } });
        else if (method === 'session/list')
          respond({ sessions: [...saved].map(([sessionId, row]) => ({ sessionId, title: row.title, cwd: '/data/work', updatedAt: '2026-10-28T10:00:00Z', _meta: { messageCount: row.updates.length } })) });
        else if (method === 'session/new' || method === 'session/load') {
          const sessionId = method === 'session/new' ? `new-${++state.created}` : params.sessionId;
          if (method === 'session/new') saved.set(sessionId, { title: 'New Chat', updates: [] });
          else {
            state.loads.push(sessionId);
            for (const u of saved.get(sessionId)?.updates ?? []) send({ method: 'session/update', params: { sessionId, update: u } });
          }
          state.live.add(sessionId); owned.add(sessionId);
          respond({ sessionId, configOptions: [] });
        } else if (method === 'session/close') {
          state.live.delete(params.sessionId); owned.delete(params.sessionId); respond({});
        } else if (id !== undefined) respond({});
      }
    });
    ws.on('close', () => { state.sockets.delete(ws); owned.forEach((s) => state.live.delete(s)); });
  });
  return state;
}

const one = await agent('one');
const two = await agent('two');
const port = 5299;
const base = `http://127.0.0.1:${port}`;
let app;
let log = '';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  app = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production', ACP_TITLES_DB: titlesDb, ACP_CONVERSATIONS_DB: join(directory, 'conversations.db'), ACP_CONNECT_TIMEOUT_MS: '2000',
      ACP_WS_URL: '', ACP_TOKEN: '', ACP_SECRET: '', AGENT_BOX_ID: '', EASYBITS_API_KEY: '', DEMO: 'false',
      ACP_BOXES: 'one,two',
      ACP_ONE_WS_URL: `ws://127.0.0.1:${one.port}`, ACP_ONE_TOKEN: '', ACP_ONE_BOX_ID: '', ACP_ONE_MAX_SESSIONS: '2',
      ACP_TWO_WS_URL: `ws://127.0.0.1:${two.port}`, ACP_TWO_TOKEN: '', ACP_TWO_BOX_ID: '', ACP_TWO_MAX_SESSIONS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => (log += d)); app.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`App failed to start: ${log}`);
}
const list = async () => (await fetch(`${base}/api/conversations`)).json();
const create = async () => {
  const response = await fetch(`${base}/api/conversations`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).conversationId;
};
async function snapshot(id) {
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/conversations/${encodeURIComponent(id)}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: started')) text += new TextDecoder().decode((await reader.read()).value);
    return { snapshot: JSON.parse(text.match(/event: snapshot\ndata: (.*)/)[1]), started: JSON.parse(text.match(/event: started\ndata: (.*)/)[1]) };
  } finally { controller.abort(); }
}

try {
  await start();

  // The same agent id on both boxes. The first box's thread is from before app ids and keeps
  // its agent id (old links work); the other gets an app id, which hides the box.
  const appId = /^[a-z2-9]{8}$/;
  const first = await list();
  assert.equal(first.error, null);
  const byTitle = Object.fromEntries(first.conversations.map((c) => [c.title, c.id]));
  assert.equal(byTitle['Saved on one'], 'shared');
  const onTwo = byTitle['Saved on two'];
  assert.match(onTwo, appId);
  await delay(10_100); // past the list cache: the id given out is kept
  assert.equal((await list()).conversations.find((c) => c.title === 'Saved on two').id, onTwo);

  // Opening an app id loads it from its own box, under the agent's id.
  assert.equal((await fetch(`${base}/c/${onTwo}`)).status, 200);
  const opened = await snapshot(onTwo);
  assert.equal(opened.started.sessionId, onTwo);
  assert.equal(opened.snapshot.messages[0].text, 'hello two');
  assert.deepEqual(two.loads, ['shared']);
  assert.deepEqual(one.loads, []);
  assert.equal((await fetch(`${base}/c/shared`)).status, 200);
  assert.deepEqual(one.loads, ['shared']);

  // New threads get app ids on every box, and go where there is room: each box holds one open
  // thread, so the first goes to box one (ties go first), the second to box two. Both agents
  // named their session `new-1`; the app ids still differ.
  const a = await create();
  const b = await create();
  assert.match(a, appId);
  assert.match(b, appId);
  assert.notEqual(a, b);
  assert.equal(one.created, 1);
  assert.equal(two.created, 1);
  assert.equal(one.live.size, 2);
  assert.equal(two.live.size, 2);

  // A box that goes down: new threads go to the other one; its threads stay listed until it is back.
  for (const ws of two.sockets) ws.terminate();
  await new Promise((r) => two.server.close(r));
  await delay(200);
  assert.match(await create(), appId);
  assert.equal(one.created, 2, 'the new thread went to the box that is up');
  await delay(10_100); // past the list cache
  const degraded = await list();
  assert.ok(degraded.conversations.some((row) => row.id === onTwo), 'the down box keeps its last rows');
  assert.match(degraded.error ?? '', /Part of the history/);
  assert.equal((await fetch(`${base}/c/${onTwo}`)).status >= 400, true, 'its threads cannot open while it is down');

  console.log('PASS: merged history with colliding ids, app ids routed to their box, room-based placement, box down fallback.');
} catch (error) {
  console.error(log.slice(-3000));
  throw error;
} finally {
  app?.kill('SIGKILL');
  one.server.close(); two.server.close();
}
