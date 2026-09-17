// Runs only against a local mock ACP agent. Requires npm run build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
const directory = await mkdtemp(join(tmpdir(), 'demo-integration-'));
const mock = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(mock, 'listening');
let sequence = 0, promptCount = 0, cancellations = 0, held;
const sessions = new Map([['owner-secret', []]]);
mock.on('connection', ws => ws.on('message', raw => {
  for (const line of raw.toString().trim().split('\n')) {
    const m = JSON.parse(line), p = m.params ?? {};
    const send = payload => ws.send(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
    const respond = result => send({ id: m.id, result });
    const update = (sessionId, sessionUpdate, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } } });
    if (m.method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
    else if (m.method === 'session/list') respond({ sessions: [...sessions.keys()].map(sessionId => ({ sessionId, title: sessionId, cwd: '/data/work' })) });
    else if (m.method === 'session/new') { const id = `demo-${++sequence}`; sessions.set(id, []); respond({ sessionId: id, configOptions: [] }); }
    else if (m.method === 'session/load') {
      for (const item of sessions.get(p.sessionId) ?? []) update(p.sessionId, item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', item.text);
      respond({ configOptions: [] });
    } else if (m.method === 'session/prompt') {
      promptCount++;
      const text = p.prompt.filter(b => b.type === 'text').at(-1).text;
      sessions.get(p.sessionId).push({ role: 'user', text });
      const finish = () => { update(p.sessionId, 'agent_message_chunk', `Private answer ${p.sessionId}`); sessions.get(p.sessionId).push({ role: 'assistant', text: `Private answer ${p.sessionId}` }); respond({ stopReason: 'end_turn' }); };
      if (text === 'hold') held = finish;
      else if (text === 'overflow') { held = () => respond({ stopReason: 'cancelled' }); update(p.sessionId, 'agent_message_chunk', 'x'.repeat(36000)); }
      else finish();
    } else if (m.method === 'session/cancel') { cancellations++; held?.(); held = undefined; }
    else if (m.id !== undefined) respond({});
  }
}));
const base = 'http://127.0.0.1:5401';
let app, log = '';
const env = { ...process.env, PUBLIC_DEMO: 'true', DEMO_DB: join(directory, 'demo.db'), DEMO_TURN_LIMIT: '2', DEMO_TOKEN_LIMIT: '12000',
  DEMO_GLOBAL_TOKEN_LIMIT: '100000', DEMO_USER_LIMIT: '20', DEMO_IP_CHAT_LIMIT: '100', DEMO_IP_API_LIMIT: '1000', DEMO_TRUSTED_PROXIES: '', NODE_ENV: 'production', PORT: '5401',
  ACP_WS_URL: `ws://127.0.0.1:${mock.address().port}`, ACP_TOKEN: '', ACP_SECRET: '', AGENT_BOX_ID: '', EASYBITS_API_KEY: '',
  ACP_EXTENSIONS_DB: join(directory, 'extensions.db'), ACP_TITLES_DB: join(directory, 'titles.db'), WHATSAPP_ADMIN_KEY: 'private-owner-key' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(extra = {}) {
  app = spawn(process.execPath, ['server.js'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', value => { log += value; }); app.stderr.on('data', value => { log += value; });
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error(log);
    try { const r = await fetch(`${base}/api/demo`); if (r.status === 401 || r.status === 200) return; } catch {}
    await sleep(100);
  }
  throw new Error(`Server did not start: ${log}`);
}
async function stop() { if (app?.exitCode === null) { const done = once(app, 'exit'); app.kill(); await done; } }
const request = (path, cookie, init = {}) => fetch(base + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
const post = (path, cookie, body) => request(path, cookie, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
async function guest() {
  const r = await request('/'); assert.equal(r.status, 200);
  const html = await r.text(); assert.ok(!html.includes('owner-secret')); assert.ok(html.includes('Demo gratuita'));
  const cookie = r.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie;
}
try {
  await start();
  const a = await guest(), b = await guest();
  assert.notEqual(a, b);
  assert.equal((await request('/api/conversations')).status, 401);
  assert.equal((await request('/api/conversations/owner-secret/events', a)).status, 404);
  for (const path of ['/api/extensions', '/recipes', '/apps', '/schedules']) assert.equal((await request(path, a)).status, 403, path);
  assert.equal((await request('/skills', a)).status, 200);
  assert.equal((await post('/api/model-preference', a, { value: 'expensive' })).status, 403);
  assert.equal((await request('/api/conversations', a, { method: 'POST', headers: { origin: 'https://attacker.example' } })).status, 403);
  const results = await Promise.all([post('/api/conversations', a), post('/api/conversations', a)]);
  const ids = await Promise.all(results.map(r => r.json()));
  assert.equal(ids[0].conversationId, ids[1].conversationId); assert.equal(sequence, 1);
  const id = ids[0].conversationId;
  const extensionsPage = await request('/extensions', b);
  assert.equal(extensionsPage.status, 200);
  const extensionsHtml = await extensionsPage.text();
  assert.match(extensionsHtml, /Herramientas disponibles/);
  assert.ok(!extensionsHtml.includes('Hilo abierto'));
  assert.ok(!extensionsHtml.includes('Dar de alta'));
  assert.ok(!extensionsHtml.includes(id));
  const history = await (await request('/api/conversations', a)).json(); assert.deepEqual(history.conversations.map(c => c.id), [id]);
  const bHistory = await (await request('/api/conversations', b)).json(); assert.deepEqual(bHistory.conversations, []);
  assert.ok(!(await (await request('/.data', b)).text()).includes(id));
  assert.equal((await request(`/c/${id}`, b)).status, 404);
  for (const suffix of ['messages', 'cancel', 'close', 'permissions']) assert.equal((await post(`/api/conversations/${id}/${suffix}`, b, { text: 'attack' })).status, 404);
  assert.equal((await request(`/api/conversations/${id}/events`, b)).status, 404);
  assert.equal((await post(`/api/conversations/${id}/messages`, a, { text: 'hold' })).status, 200);
  for (let i = 0; i < 50 && !held; i++) await sleep(20);
  assert.ok(held);
  assert.equal((await post('/api/conversations', b)).status, 409, 'another guest must not interrupt the active reply');
  held(); held = undefined; await sleep(100);
  assert.equal((await post(`/api/conversations/${id}/messages`, a, { text: 'more info' })).status, 200);
  await sleep(100);
  const blocked = await post(`/api/conversations/${id}/messages`, a, { text: 'third prompt' });
  assert.equal(blocked.status, 429); assert.match((await blocked.json()).error, /ismaelfcom93/); assert.equal(promptCount, 2);
  assert.equal((await (await request('/api/demo', a)).json()).exhausted, true);
  assert.equal((await (await post('/api/conversations', a)).json()).conversationId, id);
  // Each guest gets independent WhatsApp state without connecting any real number.
  assert.equal((await request('/api/whatsapp', a)).status, 200);
  assert.equal((await request('/api/whatsapp', b)).status, 200);
  const db = new DatabaseSync(env.DEMO_DB);
  const owners = db.prepare('SELECT id FROM demo_guests ORDER BY rowid').all(); db.close();
  const waDb = new DatabaseSync(join(directory, 'whatsapp-guests', `${owners[0].id}.db`));
  waDb.prepare('INSERT INTO whatsapp_groups(jid, subject, enabled, seen_at) VALUES (?, ?, ?, ?)').run('secret@g.us', 'Private group A', 1, Date.now()); waDb.close();
  assert.equal((await (await request('/api/whatsapp', a)).json()).groups[0].subject, 'Private group A');
  assert.deepEqual((await (await request('/api/whatsapp', b)).json()).groups, []);
  const connect = await request('/api/whatsapp', a, { method: 'POST', body: new URLSearchParams({ intent: 'connect' }) }); assert.equal(connect.status, 429);
  const logout = await request('/api/whatsapp', a, { method: 'POST', body: new URLSearchParams({ intent: 'logout' }) }); assert.equal(logout.status, 200);
  const bid = (await (await post('/api/conversations', b)).json()).conversationId;
  assert.equal((await post(`/api/conversations/${bid}/messages`, b, { text: 'overflow' })).status, 200);
  for (let i = 0; i < 50 && !cancellations; i++) await sleep(20);
  assert.equal(cancellations, 1, 'streamed token boundary requests agent cancellation');
  assert.equal((await post(`/api/conversations/${bid}/messages`, b, { text: 'after overflow' })).status, 429);
  assert.equal(promptCount, 3);
  // Only one new guest remains for this IP. Concurrent cookie resets cannot race past it.
  const resets = await Promise.all(Array.from({ length: 6 }, () => request('/')));
  assert.equal(resets.filter(r => r.status === 200).length, 1);
  assert.equal(resets.filter(r => r.status === 429).length, 5);
  const spoofed = await request('/', undefined, { headers: { 'x-forwarded-for': '198.51.100.9', 'x-demo-client-ip': '198.51.100.10', 'cf-connecting-ip': '198.51.100.11' } });
  assert.equal(spoofed.status, 429, 'untrusted headers cannot replenish guest allowance');
  assert.ok(Number(spoofed.headers.get('retry-after')) > 0);
  assert.equal((await request('/', a)).status, 200, 'existing guests can still browse');
  const limitedPage = await request('/', undefined, { headers: { accept: 'text/html' } });
  assert.equal(limitedPage.status, 429);
  assert.match(await limitedPage.text(), /mailto:ismaelfcom93@gmail.com/);
  await stop(); await start();
  assert.equal((await request('/')).status, 429, 'IP limit survives process restart');
  assert.equal((await (await request('/api/demo', a)).json()).exhausted, true, 'quota survives restart');
  assert.equal((await (await post('/api/conversations', a)).json()).conversationId, id);
  assert.equal((await request(`/api/conversations/${id}/events`, b)).status, 404);
  // Test chat and pairing routes without invoking real WhatsApp: invalid pair requests
  // consume attempts before validation/network work, and exhausted guests are checked first.
  await stop(); await start({ DEMO_IP_CHAT_LIMIT: '1', DEMO_IP_API_LIMIT: '10', DEMO_IP_WHATSAPP_LIMIT: '1', DEMO_TRUSTED_PROXIES: 'loopback' });
  const proxyHeaders = { 'x-forwarded-for': '198.51.100.20' };
  const newGuest = await request('/', undefined, { headers: proxyHeaders });
  assert.equal(newGuest.status, 200);
  const c = newGuest.headers.get('set-cookie').split(';')[0];
  const cid = (await (await request('/api/conversations', c, { method: 'POST', headers: proxyHeaders })).json()).conversationId;
  const beforeReloads = promptCount;
  // Simulate more reloads than either IP request allowance, including SSE reconnects.
  for (let i = 0; i < 12; i++) {
    for (const path of ['/', `/c/${cid}`, '/api/demo', '/api/conversations', '/api/whatsapp']) {
      const response = await request(path, c, { headers: proxyHeaders });
      assert.equal(response.status, 200, `reload ${i}: ${path}`);
      await response.text();
    }
    const resumed = await request('/api/conversations', c, { method: 'POST', headers: proxyHeaders });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).conversationId, cid);
    const events = await request(`/api/conversations/${cid}/events`, c, { headers: proxyHeaders });
    assert.equal(events.status, 200);
    await events.body.cancel();
  }
  const untouched = await (await request('/api/demo', c, { headers: proxyHeaders })).json();
  assert.equal(untouched.turns, 0);
  assert.equal(untouched.tokens, 0);
  assert.equal(untouched.exhausted, false);
  assert.equal(promptCount, beforeReloads);
  const sendPrompt = headers => request(`/api/conversations/${cid}/messages`, c, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal((await sendPrompt(proxyHeaders)).status, 200);
  await sleep(100);
  assert.equal(promptCount, beforeReloads + 1);
  const limitedChat = await sendPrompt(proxyHeaders);
  assert.equal(limitedChat.status, 429); assert.equal((await limitedChat.json()).code, 'DEMO_IP_LIMIT');
  const pair = () => request('/api/whatsapp', c, { method: 'POST', headers: proxyHeaders, body: new URLSearchParams({ intent: 'pair', phone: 'invalid' }) });
  assert.equal((await pair()).status, 400);
  assert.equal((await pair()).status, 429);
  assert.equal((await request('/api/whatsapp', c, { method: 'POST', headers: proxyHeaders, body: new URLSearchParams({ intent: 'logout' }) })).status, 200);
  // A forged address to the left of the actual client is not trusted, even behind a trusted proxy.
  const forgedChain = await sendPrompt({ 'x-forwarded-for': '203.0.113.99, 198.51.100.20' });
  assert.equal(forgedChain.status, 429);
  assert.equal((await sendPrompt({ 'x-forwarded-for': '198.51.100.21' })).status, 200);
  await stop(); await start({ PUBLIC_DEMO: 'false' });
  assert.equal((await request('/api/conversations')).status, 200);
  assert.equal((await request('/api/whatsapp')).status, 403, 'original admin gate restored');
  assert.deepEqual(await (await request('/api/demo')).json(), { enabled: false });
  console.log('Demo integration passed: ownership, atomic creation, quotas, busy agent, private WhatsApp state, restart persistence, IP reset/rate/proxy protections, and kill switch.');
} catch (error) { console.error(log); throw error; }
finally { await stop(); for (const client of mock.clients) client.terminate(); await new Promise(resolve => mock.close(resolve)); await rm(directory, { recursive: true, force: true }); }
