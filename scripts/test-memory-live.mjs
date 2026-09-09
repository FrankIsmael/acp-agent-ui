/** Creates only test conversations; kills only its own temporary app process. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { easybitsClient, required } from './lib/easybits.mjs';
const suspend = process.argv.includes('--suspend');
const eb = suspend ? easybitsClient() : null;
const port = 5398;
const origin = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
let conversationId;
let boxSuspended = false;
let logs = '';
async function start() {
 app = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'production', AGENT_BOX_ID: '', AGENT_SNAPSHOT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
 app.stdout.on('data', value => logs += value); app.stderr.on('data', value => logs += value);
 for (let i=0;i<100;i++) { try { if ((await fetch(origin)).ok) return; } catch {} await sleep(100); }
 throw new Error('Temporary app did not start');
}
async function killApp() { if (!app) return; const done=once(app,'exit'); app.kill('SIGKILL'); await done; app=undefined; }
async function openEvents() {
 const controller = new AbortController();
 const response = await fetch(`${origin}/api/conversations/${conversationId}/events`, { signal: controller.signal });
 if (!response.ok) { controller.abort(); throw new Error('Could not subscribe to test session'); }
 return { controller, reader: response.body.getReader(), buffer: '' };
}
async function eventUntil(stream, type) {
 const deadline = Date.now()+90_000;
 while (Date.now()<deadline) {
  let timeout;
  const chunk = await Promise.race([stream.reader.read(), new Promise((_,reject)=>{ timeout=setTimeout(()=>reject(new Error(`No ${type} event before timeout`)),20_000); })]).finally(()=>clearTimeout(timeout));
  if (chunk.done) throw new Error('Event stream ended');
  stream.buffer += new TextDecoder().decode(chunk.value);
  const match = stream.buffer.match(new RegExp(`event: ${type}\\ndata: (.*)`));
  if (match) return JSON.parse(match[1]);
 }
 throw new Error('Event timeout');
}
try {
 await start();
 const created = await fetch(`${origin}/api/conversations`, {method:'POST'});
 if (!created.ok) throw new Error('Could not create test conversation');
 conversationId = (await created.json()).conversationId;
 console.log(JSON.stringify({ phase: 'created', conversationId, mode: suspend ? 'suspend' : 'app-crash' }));
 const stream = await openEvents();
 await eventUntil(stream, 'started');
 const sent = await fetch(`${origin}/api/conversations/${conversationId}/messages`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:'Memory recovery test. Do not use tools or edit files. Write 150 numbered short sentences explaining why durable conversation history matters. Begin immediately.'}) });
 if (!sent.ok) throw new Error('Test prompt was rejected');
 const first = await eventUntil(stream,'chunk');
 console.log(JSON.stringify({phase:'streaming',firstChunkCharacters:first.text.length}));
 if (suspend) {
  await eb.request(`/sandboxes/${encodeURIComponent(required(process.env.AGENT_BOX_ID,'AGENT_BOX_ID'))}/suspend`, {method:'POST'});
  boxSuspended=true;
 }
 await killApp(); stream.controller.abort();
 await sleep(1500);
 if (suspend) { await eb.request(`/sandboxes/${encodeURIComponent(process.env.AGENT_BOX_ID)}/resume`, {method:'POST'}); boxSuspended=false; await sleep(3000); }
 await start();
 const opened=await fetch(`${origin}/c/${encodeURIComponent(conversationId)}`);
 if(!opened.ok) throw new Error('Could not reload test conversation');
 const replay=await openEvents();
 const snapshot=await eventUntil(replay,'snapshot'); replay.controller.abort();
 const result={at:new Date().toISOString(),mode:suspend?'suspend':'app-crash',conversationId,busy:snapshot.busy,messages:snapshot.messages.map(message=>({role:message.role,characters:message.text.length,thoughtCharacters:message.thought?.length??0,tools:message.tools?.length??0})),automaticResubmission:false};
 if(suspend) {
  const box=await eb.request(`/sandboxes/${encodeURIComponent(process.env.AGENT_BOX_ID)}`);
  result.bootstrap={last:box.metadata?.eb_boot_last,exit:box.metadata?.eb_boot_exit};
 }
 await mkdir('.memory-backups',{recursive:true,mode:0o700});
 await writeFile(`.memory-backups/${result.mode}-${Date.now()}.json`,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(result));
} finally {
 if(boxSuspended) await eb.request(`/sandboxes/${encodeURIComponent(process.env.AGENT_BOX_ID)}/resume`,{method:'POST'}).catch(()=>{});
 // Close through the same app connection so the relay releases its slot.
 if(conversationId && app) {
  const closed = await fetch(`${origin}/api/conversations/${conversationId}/close`, { method: 'POST' }).catch(() => null);
  if (!closed?.ok) console.log('Test session cleanup could not be confirmed');
 }
 await killApp();
}
