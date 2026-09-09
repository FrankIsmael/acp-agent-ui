import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

// The fixture owns history independently of the app process. No real agent,
// credentials, or billable model calls are used.
const mock = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(mock, 'listening');
const agentPort = mock.address().port;
const port = 5298;
const base = `http://127.0.0.1:${port}`;
let capabilities = { loadSession: true, sessionCapabilities: { list: {}, close: {} } };
let connections = 0;
let cancellations = 0;
let maxLive = 0;
let listFail = false;
let app;
let log = '';
const live = new Set();
const calls = [];
const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'one', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] }];
const user = text => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
const assistant = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const saved = new Map([
  ['saved-a', { title: 'Saved conversation A', cwd: '/data/project-a', updates: [user('Remember this'), { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking back' } }, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'pending' }, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, assistant('I remember'), { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 0.01, currency: 'USD' } }] }],
  ['saved-b', { title: 'Saved conversation B', cwd: '/data/project-b', updates: [user('Second question'), assistant('Second answer')] }],
]);
mock.on('connection', ws => {
  connections++;
  const owned = new Set();
  const prompts = new Map();
  const update = (sessionId, value) => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } }) + '\n');
  ws.on('message', raw => {
    for (const line of raw.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      calls.push(message);
      const { method, params = {} } = message;
      const respond = result => ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
      const fail = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'fixture error' } }) + '\n');
      if (method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: capabilities, agentInfo: { name: "ghosty-lite", version: "1.48.0" } });
      else if (method === '_goose/unstable/sources/list') respond({ sources: [{ type: 'skill', name: 'Project conventions', description: 'Use project conventions', content: 'Identifiers in English', path: '/data/work/.agents/skills/conventions' }, { type: 'builtinSkill', name: 'Built in', description: 'Included', content: 'Built in content', path: 'builtin' }, { type: 'recipe', name: 'Not a skill' }] });
      else if (method === 'session/list') {
        if (listFail) { fail(); continue; }
        const rows = [...saved].map(([sessionId, row]) => ({ sessionId, title: row.title, cwd: row.cwd, updatedAt: '2026-09-08T10:00:00Z', _meta: { messageCount: row.updates.filter(u => /message_chunk/.test(u.sessionUpdate)).length } }));
        respond(params.cursor ? { sessions: rows.slice(1) } : { sessions: rows.slice(0, 1), nextCursor: 'page-2' });
      } else if (method === 'session/load' || method === 'session/new') {
        const id = method === 'session/new' ? `new-${saved.size}` : params.sessionId;
        if (!saved.has(id) && method === 'session/load') { fail(); continue; }
        if (method === 'session/new') saved.set(id, { title: 'New Chat', cwd: params.cwd, updates: [] });
        live.add(id); owned.add(id); maxLive = Math.max(maxLive, live.size);
        if (method === 'session/load') saved.get(id).updates.forEach(u => update(id, u));
        respond({ sessionId: id, configOptions });
      } else if (method === 'session/set_config_option') {
        respond({ configOptions: configOptions.map(option => ({ ...option, currentValue: params.value })) });
      } else if (method === 'session/prompt') {
        const row = saved.get(params.sessionId);
        const chunks = [...params.prompt.filter(c => c.type === 'text').map(c => user(c.text)), assistant('Partial persisted response')];
        row.updates.push(...chunks);
        row.title = 'Agent generated title';
        update(params.sessionId, { sessionUpdate: 'session_info_update', title: row.title });
        update(params.sessionId, chunks.at(-1));
        prompts.set(params.sessionId, () => respond({ stopReason: 'cancelled' }));
      } else if (method === 'session/cancel') {
        cancellations++;
        prompts.get(params.sessionId)?.(); prompts.delete(params.sessionId);
      } else if (method === 'session/close') {
        live.delete(params.sessionId); owned.delete(params.sessionId); respond({});
      } else if (message.id !== undefined) respond({});
    }
  });
  ws.on('close', () => owned.forEach(id => live.delete(id)));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  app = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ACP_WS_URL: `ws://127.0.0.1:${agentPort}`, ACP_TOKEN: '', ACP_SECRET: '', AGENT_BOX_ID: '', EASYBITS_API_KEY: '', ACP_CONNECT_TIMEOUT_MS: '2000', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', d => log += d); app.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`App failed to start: ${log}`);
}
async function stop() { if (!app) return; const exited = once(app, 'exit'); app.kill('SIGKILL'); await exited; app = undefined; await delay(100); }
async function snapshot(id) {
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/api/conversations/${id}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: started')) text += new TextDecoder().decode((await reader.read()).value);
    return JSON.parse(text.match(/event: snapshot\ndata: (.*)/)[1]);
  } finally { controller.abort(); }
}
async function open(id) { const response = await fetch(`${base}/c/${id}`); assert.equal(response.status, 200, await response.text()); return snapshot(id); }
async function post(path, body) { return fetch(`${base}/api/conversations${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
try {
  await start();
  const list = await (await fetch(`${base}/api/conversations`)).json();
  assert.deepEqual(list.conversations.map(c => c.id), ['saved-a', 'saved-b']);
  assert.equal(live.size, 0, 'listing never opens a session');
  const skillsPage = await (await fetch(`${base}/skills`)).text();
  assert.ok(skillsPage.includes('Project conventions') && skillsPage.includes('Built in'));
  assert.ok(!skillsPage.includes('Not a skill'));
  assert.equal(live.size, 0, 'skills listing does not allocate a session');
  const first = await open('saved-a');
  assert.equal(first.messages[0].text, 'Remember this');
  assert.equal(first.messages[1].text, 'I remember');
  assert.equal(first.messages[1].thought, 'Thinking back');
  assert.equal(first.messages[1].tools[0].status, 'completed');
  assert.equal(first.messages[1].usage.used, 12);
  assert.equal(calls.find(c => c.method === 'session/load').params.cwd, '/data/project-a');
  await open('saved-b');
  assert.equal(connections, 1, 'thread switching reuses initialized connection');
  assert.equal(maxLive, 1);
  assert.ok(calls.findIndex(c => c.method === 'session/close') < calls.findIndex(c => c.method === 'session/load' && c.params.sessionId === 'saved-b'));
  const beforeDraft = calls.filter(c => c.method === 'session/new').length;
  const draft = await fetch(`${base}/api/model-preference`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'two' }) });
  assert.equal(draft.status, 200);
  assert.equal(calls.filter(c => c.method === 'session/new').length, beforeDraft, 'draft model preference opens no session');
  await fetch(`${base}/c/saved-a?tail=1`);
  assert.equal(calls.filter(c => c.method === 'session/load').at(-1).params._meta.replayTail, 1);
  await open('saved-a');
  assert.equal(calls.filter(c => c.method === 'session/load').at(-1).params._meta, undefined, 'full history removes replay limit');
  const created = await (await post('')).json();
  assert.match(created.conversationId, /^new-/);
  const id = created.conversationId;
  assert.equal((await post(`/${id}/messages`, { text: 'Persist after restart' })).status, 200);
  await delay(100);
  const streaming = await snapshot(id);
  assert.equal(streaming.busy, true);
  assert.equal(streaming.messages.at(-1).text, 'Partial persisted response');
  const titled = await (await fetch(`${base}/api/conversations`)).json();
  assert.equal(titled.conversations.find(c => c.id === id).title, 'Agent generated title');
  await stop(); // Kill the app in the middle of a prompt; fixture retains its saved history.
  await start();
  const recovered = await open(id);
  assert.equal(recovered.busy, false, 'interrupted prompt is not silently resubmitted');
  assert.deepEqual(recovered.messages.map(m => m.text), ['Persist after restart', 'Partial persisted response']);
  assert.equal((await post(`/${id}/messages`, { text: 'Continue' })).status, 200);
  await delay(50);
  await open('saved-a');
  assert.equal(cancellations, 1, 'switching cancels active prompt before closing');
  assert.equal(maxLive, 1);
  const cached = await (await fetch(`${base}/api/conversations`)).json();
  listFail = true;
  // A completed/cancelled prompt invalidates the short cache.
  await post('/saved-a/messages', { text: 'Invalidate list' });
  await delay(30); await post('/saved-a/cancel'); await delay(30);
  const stale = await (await fetch(`${base}/api/conversations`)).json();
  assert.ok(stale.error);
  assert.equal(stale.conversations.length, cached.conversations.length, 'refresh failure preserves list');
  const preference = await post('/saved-a/config', { configId: 'model', value: 'two' });
  assert.equal(preference.status, 200);
  const cookie = preference.headers.get('set-cookie').split(';')[0];
  await stop(); listFail = false; capabilities = {};
  await start();
  const before = calls.length;
  assert.deepEqual((await (await fetch(`${base}/api/conversations`)).json()).conversations, []);
  assert.equal(calls.slice(before).some(c => c.method === 'session/list'), false);
  assert.equal((await fetch(`${base}/c/saved-a`)).status, 409);
  const fallback = await (await fetch(`${base}/api/conversations`, { method: 'POST', headers: { cookie } })).json();
  assert.equal(calls.filter(c => c.method === 'session/set_config_option').at(-1).params.value, 'two', 'model preference survives app restart');
  const count = connections;
  await post('');
  assert.equal(connections, count + 1, 'without close capability the connection is recycled');
  assert.equal((await post(`/${fallback.conversationId}/messages`, { text: 'old' })).status, 409);
  console.log('PASS: paginated history, full replay, shared connection, agent titles, mid-turn app restart, cancellation, stale cache, capability fallbacks, skills, draft preference, partial replay.');
} catch (error) { console.error(log.slice(-3000)); throw error; }
finally { await stop(); for (const ws of mock.clients) ws.terminate(); await new Promise(resolve => mock.close(resolve)); }
