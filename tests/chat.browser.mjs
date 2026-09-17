import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Requires a production build and a Chromium-family browser. All agent traffic
// stays on localhost; no remote agent or credentials are used.
const root = fileURLToPath(new URL('../', import.meta.url));
const browserPath = process.env.CHAT_TEST_BROWSER ?? process.env.ARTIFACT_TEST_BROWSER;
if (!browserPath) throw new Error('Set CHAT_TEST_BROWSER to your Chrome, Chromium or Brave executable.');
const require = createRequire(`${root}/package.json`);
const { WebSocketServer } = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'chat-browser-'));
const mock = new WebSocketServer({ host: '127.0.0.1', port: 5197 });
let cancellations = 0;
let newSessions = 0;
const modelOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Modelo', currentValue: 'one', options: [{ value: 'one', name: 'Model One' }, { value: 'two', name: 'Model Two' }] }];
mock.on('connection', ws => {
  let active;
  ws.on('message', raw => {
    for (const line of raw.toString().trim().split('\n')) {
      const m = JSON.parse(line);
      const respond = result => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
      if (m.method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
      else if (m.method === '_goose/unstable/sources/list') respond({ sources: [{ type: 'skill', name: 'Project conventions', description: 'Repository instructions', content: 'Identifiers in English', path: '/data/work/.agents/skills/conventions' }] });
      else if (m.method === 'session/list') respond({ sessions: [{ sessionId: 'saved-history', cwd: '/data/work', title: 'A remembered conversation', updatedAt: '2026-09-08T12:00:00Z', _meta: { messageCount: 2 } }] });
      else if (m.method === 'session/load') {
        for (const [sessionUpdate, text] of [['user_message_chunk', 'A question from yesterday'], ['agent_message_chunk', 'An answer from yesterday']]) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate, content: { type: 'text', text } } } }) + '\n');
        respond({ configOptions: modelOptions });
      }
      else if (m.method === 'session/new') { newSessions++; respond({ sessionId: 'mock-session', configOptions: modelOptions }); }
      else if (m.method === 'session/set_config_option') respond({ configOptions: modelOptions.map(option => ({ ...option, currentValue: m.params.value })) });
      else if (m.method === 'session/prompt') {
        let n = 0;
        const chunk = text => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\n');
        chunk('Initial response.\n\n'.repeat(100));
        const timer = setInterval(() => chunk(`Streaming paragraph ${++n}.\n\n`), 80);
        active = () => { clearInterval(timer); respond({ stopReason: 'cancelled' }); active = undefined; };
      } else if (m.method === 'session/cancel') { cancellations++; active?.(); }
      else if (m.id !== undefined) respond({});
    }
  });
  ws.on('close', () => active?.());
});
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '5198', ACP_WS_URL: 'ws://127.0.0.1:5197', ACP_TOKEN: '', ACP_SECRET: '', AGENT_BOX_ID: '', EASYBITS_API_KEY: '', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => serverLog += d); server.stderr.on('data', d => serverLog += d);
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--remote-debugging-port=5199', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: ['ignore','pipe','pipe'] });
let browserLog = ''; browser.stderr.on('data', d => browserLog += d);
let socket; let debugPage;
try {
  const wait = async (fn, name, timeout = 12000) => { const start = Date.now(); while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await sleep(100); } throw new Error(`Timed out: ${name}`); };
  await wait(async () => (await fetch('http://127.0.0.1:5198/artifacts')).ok, 'server');
  await wait(async () => (await fetch('http://127.0.0.1:5199/json/version')).ok, 'browser');
  const target = await (await fetch('http://127.0.0.1:5199/json/new?about:blank', { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => socket.addEventListener('open', r, { once: true }));
  let sequence = 0; const pending = new Map(); const errors = []; const contexts = new Map();
  socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id,m.params.context); if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId); });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) })); });
  const evaluate = async (expression, contextId) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(typeof contextId === 'number' ? { contextId } : {}) }, typeof contextId === 'string' ? contextId : undefined); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  debugPage = () => evaluate(`({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),disabled:b.disabled})),textarea:document.querySelector('textarea')?.value})`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const fill = async (selector, value) => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  const { conversationId } = await (await fetch('http://127.0.0.1:5198/api/conversations', { method: 'POST' })).json();
  await cdp('Page.navigate', { url: `http://127.0.0.1:5198/c/${conversationId}` });
  await wait(() => evaluate(`document.querySelector('textarea')?.placeholder === 'Sigue la conversación…'`), 'connected chat');
  await fill('textarea', 'Stream a long reply');
  await click('button[aria-label="Enviar"]');
  const area = `document.querySelector('[aria-label="Mensajes"]')`;
  await wait(() => evaluate(`${area}?.scrollTop > 500`), 'follows streaming reply');
  await evaluate(`${area}.scrollTop = 150`);
  await sleep(200);
  const position = await evaluate(`${area}.scrollTop`);
  await sleep(700);
  assert.equal(await evaluate(`${area}.scrollTop`), position, 'reading position preserved during streaming');
  assert.equal(await evaluate(`document.documentElement.scrollHeight <= innerHeight`), true, 'no page overflow');
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('textarea').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`), true, 'composer stays visible');
  await evaluate(`${area}.scrollTop = ${area}.scrollHeight`);
  await sleep(500);
  assert.ok(await evaluate(`${area}.scrollHeight - ${area}.clientHeight - ${area}.scrollTop < 48`), 'resumes following at bottom');
  await click('button[aria-label="Detener"]');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Enviar"]')`), 'cancel confirmed');
  assert.equal(cancellations, 1, 'real ACP cancellation notification');
  const stopped = await evaluate(`${area}.textContent`);
  await sleep(300);
  assert.equal(await evaluate(`${area}.textContent`), stopped, 'stream stopped and partial reply retained');
  await fill('textarea', 'Another response');
  await click('button[aria-label="Enviar"]');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Detener"]')`), 'new turn after stop');
  await cdp('Page.reload');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Detener"]')`), 'reload restores busy state');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  assert.equal(await evaluate(`document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth`), true, 'no mobile page overflow');
  await click('button[aria-label="Detener"]');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Enviar"]')`), 'stop after reload');
  assert.equal(cancellations, 2);
  const missing = await fetch('http://127.0.0.1:5198/api/conversations/missing/cancel', {method:'POST'});
  assert.equal(missing.status,404);
  const cross = await fetch(`http://127.0.0.1:5198/api/conversations/${conversationId}/cancel`, {method:'POST',headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(cross.status,403);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await wait(() => evaluate(`!!document.querySelector('a[href="/sessions"]')`), 'desktop navigation visible');
  await click('a[href="/sessions"]');
  await wait(() => evaluate(`document.querySelector('h1')?.textContent === 'Historial' && document.body.innerText.includes('A remembered conversation')`), 'history page loads saved sessions');
  assert.ok(await evaluate(`document.querySelectorAll('a[href="/c/saved-history"]').length >= 2`), 'history and chats share saved session');
  await click('a[href="/c/saved-history"]');
  await wait(() => evaluate(`document.querySelector('[aria-label="Mensajes"]')?.textContent.includes('An answer from yesterday')`), 'saved chat replay');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Mensajes"]').textContent.split('An answer from yesterday').length - 1`), 1, 'replay appears once');
  await cdp('Page.reload');
  await wait(() => evaluate(`document.querySelector('[aria-label="Mensajes"]')?.textContent.includes('A question from yesterday')`), 'saved chat survives reload');
  await click('a[href="/skills"]');
  await wait(() => evaluate(`document.querySelector('h1')?.textContent === 'Habilidades' && document.body.innerText.includes('Project conventions')`), 'skills list replaces placeholder');
  await click('details summary');
  assert.ok(await evaluate(`document.body.innerText.includes('Identifiers in English')`));
  assert.ok(!(await evaluate(`document.body.innerText`)).includes('Salen por ACP'));
  const sessionsBeforeDraft = newSessions;
  await click('a[href="/c/nuevo"]');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Modelo"]')`), 'cached draft model selector');
  await evaluate(`document.querySelector('button[aria-label="Modelo"]').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(() => evaluate(`!!document.querySelector('[role="menuitem"]')`), 'model menu');
  await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.includes('Model Two')).click()`);
  await wait(() => evaluate(`document.querySelector('button[aria-label="Modelo"]')?.textContent.includes('Model Two')`), 'draft model saved');
  await cdp('Page.reload');
  await wait(() => evaluate(`document.querySelector('button[aria-label="Modelo"]')?.textContent.includes('Model Two')`), 'draft model survives reload');
  assert.equal(newSessions, sessionsBeforeDraft, 'choosing model does not allocate a session');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS: streaming follow, manual scroll, desktop/mobile containment, ACP cancellation, partial reply, next turn, reload stop, endpoint validation, saved history and chats, replay and reload, skills, draft model preference.');
} catch (error) {
  console.error(error); console.error('Page:', await debugPage?.()); console.error('Server:', serverLog.slice(-2500)); console.error('Browser:', browserLog.slice(-1500)); process.exitCode = 1;
} finally {
  socket?.close(); browser.kill(); server.kill(); mock.close(); for (const ws of mock.clients) ws.terminate();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(()=>{});
}
