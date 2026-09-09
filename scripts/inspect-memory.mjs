import { easybitsClient, pythonCommand, required } from './lib/easybits.mjs';
const eb = easybitsClient();
const id = required(process.env.AGENT_BOX_ID, 'AGENT_BOX_ID');
const box = await eb.request(`/sandboxes/${encodeURIComponent(id)}`);
console.log(JSON.stringify({ status: box.status, template: box.template, bootConfigured: !!box.metadata?.eb_boot, bootLast: box.metadata?.eb_boot_last, bootExit: box.metadata?.eb_boot_exit }));
console.log(await eb.exec(id, pythonCommand(`import os, pathlib, json, subprocess, sqlite3
paths = ["/data/ghosty/data/sessions/sessions.db", "/data/state/goose/sessions/sessions.db", "/root/.local/share/goose/sessions/sessions.db"]
for name in paths:
 p=pathlib.Path(name)
 if p.exists():
  with sqlite3.connect(f"file:{p}?mode=ro", uri=True) as c:
   print(json.dumps({"path":name,"sessions":c.execute("select count(*) from sessions").fetchone()[0],"messages":c.execute("select count(*) from messages").fetchone()[0]}))
for name in ("ghosty-lite.service", "ghosty.service", "goose-acp.service", "goose.service"):
 r=subprocess.run(["systemctl","show",name,"--property=LoadState,ActiveState,FragmentPath"],capture_output=True,text=True)
 if "LoadState=loaded" in r.stdout: print(name+" "+r.stdout.replace("\\n"," "))
for directory in ("/data/work/.agents/skills", "/data/work/.goose/skills", "/data/repo"):
 p=pathlib.Path(directory)
 print(json.dumps({"directory":directory,"exists":p.exists(),"symlink":p.is_symlink(),"target":str(p.resolve())}))
`)));
