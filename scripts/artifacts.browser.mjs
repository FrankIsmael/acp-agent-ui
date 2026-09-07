import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Requires a production build and a Chromium-family browser. All agent traffic
// stays on localhost. Clipboard and native sharing are mocked.
const root = fileURLToPath(new URL('../', import.meta.url));
const browserPath = process.env.ARTIFACT_TEST_BROWSER;
if (!browserPath) throw new Error('Set ARTIFACT_TEST_BROWSER to your Chrome, Chromium or Brave executable.');
const require = createRequire(`${root}/package.json`);
const { WebSocketServer } = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'artifact-browser-'));
const mock = new WebSocketServer({ host: '127.0.0.1', port: 5197 });
let lastPrompt;
const app = `<html><head><style>body{font-family:system-ui;background:#0c2424;color:#f5ecd9;padding:40px}h1{font-size:42px}button{padding:14px 24px;background:#edb76d;border:0;border-radius:8px;font-size:20px}small{color:#9fb8b1}</style></head><body><small>YOUR NEXT IDEA STARTS HERE</small><h1>A little space to create.</h1><p>A working app, right beside your conversation.</p><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><p id="security"></p><script>let results={};try{parent.document.body.dataset.compromised='yes';results.parent=false}catch{results.parent=true}try{localStorage.setItem('leak','yes');results.storage=false}catch{results.storage=true}fetch('http://127.0.0.1:5198/should-be-blocked').then(()=>results.network=false).catch(()=>results.network=true).finally(()=>document.getElementById('security').textContent=JSON.stringify(results));</script></body></html>`;
const answer = `Here is your app.\n<artifact identifier="counter" type="text/html" title="Creative counter" language="html">${app}</artifact>\nYou can edit and share it.`;
mock.on('connection', ws => ws.on('message', async raw => {
  for (const line of raw.toString().trim().split('\n')) {
    const m = JSON.parse(line);
    const respond = result => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') respond({ protocolVersion: 1, agentCapabilities: {} });
    else if (m.method === 'session/new') respond({ sessionId: 'mock-session', configOptions: [] });
    else if (m.method === 'session/prompt') {
      lastPrompt = m.params.prompt;
      for (let i = 0; i < answer.length; i += 24) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(i, i + 24) } } } }) + '\n');
        await sleep(45);
      }
      respond({ stopReason: 'end_turn' });
    } else if (m.id !== undefined) respond({});
  }
}));
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
  await fill('textarea', 'Build a counter app');
  await click('button[aria-label="Enviar"]');
  await wait(() => evaluate(`!!document.querySelector('aside[aria-label="Artifacts"]')`), 'automatic artifact panel');
  assert.ok(lastPrompt.some(p => p.text.includes('The chat UI supports an Artifacts side panel.')));
  await click('button[aria-label="Cerrar artifacts"]');
  await sleep(500);
  assert.equal(await evaluate(`!!document.querySelector('aside[aria-label="Artifacts"]')`), false, 'closed panel stays closed while streaming');
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="Enviar"]')`), 'finished stream');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Creative counter'))?.click()`);
  await wait(() => evaluate(`!!document.querySelector('iframe')`), 'reopen via card');
  await sleep(700);
  const frameTarget = (await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='iframe');
  let frameContext = (await cdp('Target.attachToTarget', {targetId:frameTarget.targetId,flatten:true})).sessionId;
  assert.ok(frameContext, 'preview frame context');
  const security = await wait(() => evaluate(`document.getElementById('security')?.textContent`, frameContext), 'security checks');
  assert.deepEqual(JSON.parse(security), { parent: true, storage: true, network: true });
  await evaluate(`document.getElementById('counter').click()`, frameContext);
  assert.equal(await evaluate(`document.getElementById('counter').textContent`, frameContext), '1');
  assert.equal(await evaluate(`document.body.dataset.compromised`), undefined);
  assert.equal(await evaluate(`document.querySelector('iframe').getAttribute('sandbox')`), 'allow-scripts');
  await writeFile(join(tmpdir(), 'artifacts-desktop.png'), Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Código')?.click()`);
  const edited = app.replace('A little space to create.', 'Edited locally.');
  await fill('textarea[aria-label="Editar Creative counter"]', edited);
  await wait(() => evaluate(`JSON.parse(localStorage.getItem('acp-artifacts-v1')).artifacts[0].editedContent?.includes('Edited locally.')`), 'save edit');
  await cdp('Page.reload');
  await wait(() => evaluate(`!!document.querySelector('iframe')`), 'reload and reopen');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Código')?.click()`);
  assert.ok((await evaluate(`document.querySelector('textarea[aria-label="Editar Creative counter"]').value`)).includes('Edited locally.'));
  await click('button[aria-label="Cerrar artifacts"]');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5198/artifacts' });
  await wait(() => evaluate(`document.body.textContent.includes('Creative counter')`), 'local library');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Creative counter'))?.click()`);
  await wait(() => evaluate(`!!document.querySelector('iframe')`), 'library preview');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(() => evaluate(`!!document.querySelector('[role="dialog"]')`), 'mobile drawer');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'no mobile overflow');
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]').contains(document.activeElement)`), true, 'drawer focus');
  await writeFile(join(tmpdir(), 'artifacts-mobile.png'), Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  await click('button[aria-label="Cerrar artifacts"]');
  assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`), false);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Creative counter'))?.click()`);
  await wait(() => evaluate(`!!document.querySelector('iframe')`), 'download preview');
  await cdp('Browser.setDownloadBehavior', {behavior:'allow',downloadPath:profile});
  await click('button[aria-label="Descargar archivo"]');
  await wait(async () => (await readFile(`${profile}/Creative-counter.html`, 'utf8')) === edited, 'downloaded edited HTML');
  await evaluate(`Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false})`);
  await click('button[aria-label="Compartir archivo"]');
  await wait(() => evaluate(`document.body.innerText.includes('Archivo descargado para compartir.')`), 'share download fallback');
  await evaluate(`Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.sharedFile={title:data.title,text:await data.files[0].text()}}})`);
  await click('button[aria-label="Compartir archivo"]');
  await wait(() => evaluate(`!!window.sharedFile`), 'native share payload');
  assert.equal(await evaluate(`window.sharedFile.text`), edited);
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText=text}}})`);
  await click('button[aria-label="Copiar contenido"]');
  await wait(() => evaluate(`document.body.innerText.includes('Copiado')`), 'copy feedback');
  assert.equal(await evaluate(`window.copiedText`), edited);
  await click('button[aria-label="Cerrar artifacts"]');
  const extraArtifacts = [
    {key:'test-markdown',conversationId:'archived',turnIndex:1,updatedAt:2,identifier:'document',title:'Project brief',type:'text/markdown',language:'markdown',content:'# Project brief\n\n**Ready to share.**',complete:true},
    {key:'test-svg',conversationId:'archived',turnIndex:1,updatedAt:3,identifier:'graphic',title:'Local graphic',type:'image/svg+xml',language:'svg',content:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="80" fill="coral"/></svg>',complete:true},
    {key:'test-code',conversationId:'archived',turnIndex:1,updatedAt:4,identifier:'code',title:'Python script',type:'application/vnd.ant.code',language:'python',content:'print("hello")',complete:true}
  ];
  await evaluate(`(()=>{const library=JSON.parse(localStorage.getItem('acp-artifacts-v1'));library.artifacts.push(...${JSON.stringify(extraArtifacts)});localStorage.setItem('acp-artifacts-v1',JSON.stringify(library));})()`);
  await cdp('Page.reload');
  await wait(() => evaluate(`document.body.innerText.includes('Project brief')`), 'archived artifacts restored');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Project brief'))?.click()`);
  await wait(() => evaluate(`document.querySelector('aside h1')?.textContent === 'Project brief'`), 'rendered markdown document');
  await click('button[aria-label="Cerrar artifacts"]');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Local graphic'))?.click()`);
  await wait(() => evaluate(`document.querySelector('iframe')?.getAttribute('sandbox') === ''`), 'SVG without script permission');
  await click('button[aria-label="Cerrar artifacts"]');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Python script'))?.click()`);
  await wait(() => evaluate(`document.querySelector('textarea[aria-label="Editar Python script"]')?.value === 'print("hello")'`), 'editable Python source');
  assert.equal(await evaluate(`!!document.querySelector('iframe')`), false);
  // Storage failure must leave editing and exports available.
  await evaluate(`Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded','QuotaExceededError'); }`);
  await fill('textarea[aria-label="Editar Python script"]', 'print("still editable")');
  await wait(() => evaluate(`document.body.innerText.includes('No se pudo guardar localmente.')`), 'storage quota feedback');
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Editar Python script"]').value`), 'print("still editable")');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS: mock ACP instructions, streaming auto-open, close/reopen, interactive HTML, parent/storage/network isolation, source editing, reload persistence, library, mobile drawer/focus, copy/download/share, Markdown/SVG/code and quota errors.');
  console.log(`Screenshots: ${join(tmpdir(), 'artifacts-desktop.png')} and ${join(tmpdir(), 'artifacts-mobile.png')}`);
} catch (error) {
  console.error(error); console.error('Page:', await debugPage?.()); console.error('Server:', serverLog.slice(-2500)); console.error('Browser:', browserLog.slice(-1500)); process.exitCode = 1;
} finally {
  socket?.close(); browser.kill(); server.kill(); mock.close(); for (const ws of mock.clients) ws.terminate();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(()=>{});
}
