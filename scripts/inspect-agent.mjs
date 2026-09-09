import { client } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { WebSocket } from 'ws';
import { easybitsClient, pythonCommand } from './lib/easybits.mjs';
const target = new URL(process.env.ACP_WS_URL);
const token = process.env.ACP_TOKEN ?? process.env.ACP_SECRET;
if (token && !target.searchParams.has('token')) target.searchParams.set('token', token);
const conn = client().connect(createWebSocketStream(target.toString(), { WebSocket, headers: token ? { Authorization: `Bearer ${token}` } : undefined }));
const timer = setTimeout(() => conn.close(), 25_000);
try {
 const init = await conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
 console.log(JSON.stringify({ agentInfo: init.agentInfo, capabilities: init.agentCapabilities }));
 try {
  const sources = await conn.agent.request('_goose/unstable/sources/list', { projectDir: process.env.ACP_CWD ?? '/data/work' });
  console.log(JSON.stringify(sources, (key, value) => ['content','body','text'].includes(key) && typeof value === 'string' ? `[${value.length} chars]` : value));
 } catch (e) { console.log(JSON.stringify({ sourcesError: e.message })); }
} finally { clearTimeout(timer); conn.close(); }
const eb = easybitsClient();
console.log(await eb.exec(process.env.AGENT_BOX_ID, pythonCommand(`import subprocess, pathlib, json
r=subprocess.run(["systemctl","list-unit-files","--type=service","--no-pager","--no-legend"],capture_output=True,text=True)
print("services: "+"\\n".join(line for line in r.stdout.splitlines() if any(s in line for s in ("ghost", "goose", "agent", "supervisor"))))
for root in ("/etc/supervisor/conf.d", "/etc/services.d", "/etc/ghosty-runtime", "/etc/ghosty-lite-runtime"):
 p=pathlib.Path(root)
 if p.exists(): print(json.dumps({"directory":root,"files":[x.name for x in p.iterdir()]}))
for p in pathlib.Path("/proc").glob("[0-9]*/comm"):
 try:
  name=p.read_text().strip()
  if any(s in name for s in ("ghost", "goose", "supervis", "s6-")): print(json.dumps({"pid":p.parent.name,"name":name}))
 except OSError: pass
`)));
