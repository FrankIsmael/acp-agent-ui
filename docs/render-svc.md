# Render service (PDF / PNG / slides) on the Oracle VM

The agent's SDK (`/opt/gs-sdk/render.mjs`) does not render on the agent box. It sends
self-contained HTML to a Chromium service, `render-svc`, and gets the bytes back. That is what
powers `pdf()`, `screenshot()`, `inspect()` (the page audit), `slides()` (PDF + editable PPTX)
and `doc()` (the `pdf-doc` skill). Without it every one of those fails.

We run our own copy of `render-svc` on the Oracle VM, next to the app, and point the EasyBits
agent box at it with `GS_RENDER_URL`.

## Why the box needs it

The SDK finds the service in this order:

1. `GS_RENDER_URL` in the environment. `turn-env.mjs` also loads it from the turn's
   `.gs-turn.json`, but only into variables that are not already set.
2. Otherwise the EasyBits service mesh, `${MESH}/render-svc/…`, which only finds a
   `render-svc` box **owned by the same account**.

Agents launched by Ghosty Studio get a filled `.gs-turn.json` with the URL of the platform's
shared render box. Ours is launched from this repo through the EasyBits API: its turn files are
`{}` (2 bytes, one per session under `/data/work/s/<id>/`) and the account has no `render-svc`,
so the mesh answers:

```
render-svc/render/pdf → 503 {"error":"no 'render-svc' running for this account — launch your own"}
```

The warning the SDK prints under that error ("run node from your workspace, not /tmp") assumes
a Studio box. On this box it is wrong: running from the workspace changes nothing.

## What runs on the VM

| Piece | Where | Tracked in git |
|---|---|---|
| Source | `~/render-svc-src` (copy of `templates/render-svc` from `blissito/sandbox-host`) | no |
| Image | `render-svc:local`, built on the VM (arm64, ~3 GB; the mupdf compile takes ~10 min on 1 OCPU) | no |
| Compose service `render` | `~/acp-agent-ui/docker-compose.render.yml` | no (`.git/info/exclude`) |
| Caddy wrapper | `~/acp-agent-ui/deploy/oracle/Caddyfile.render`: imports the tracked `Caddyfile` and adds the render host | no (`.git/info/exclude`) |
| Path secret | `~/acp-agent-ui/.render-secret` (mode 600) | no (`.git/info/exclude`) |
| Compose file list | `COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.render.yml` in `~/acp-agent-ui/.env` | no |
| Egress firewall | `render-egress.service` → `/usr/local/sbin/render-egress.sh` | no |

`COMPOSE_FILE` in `.env` is what keeps it alive across deploys: `deploy.sh` runs
`docker compose up -d --remove-orphans`, which would otherwise remove `render` as an orphan and
put back the plain Caddyfile. Keep `docker-compose.override.yml` in the list; `deploy.sh` pins
the app image there.

None of these files are in the repo, so `git merge --ff-only` in `deploy.sh` still works. If a
commit ever adds a file at one of these paths, that merge fails: move the VM copy aside first.

### Endpoint and access

```
https://render.140-84-190-139.sslip.io/<secret>/render/pdf
```

render-svc has no auth of its own, and the SDK sends no auth header. The SDK builds every call as
`${GS_RENDER_URL}/render/<endpoint>`, so a long random path prefix acts as the token: Caddy
strips it (`handle_path`) and answers 404 to anything else. `sslip.io` resolves the hostname to
the VM's IP, so no DNS record was needed. To use your own name, add an A record (e.g.
`render.ismaelfrancisco.tech` → `140.84.190.139`), change the host in `Caddyfile.render`, and
update `GS_RENDER_URL` on the box.

To rotate the secret: write a new one to `.render-secret`, put it in `Caddyfile.render`,
`docker compose up -d caddy`, then update `GS_RENDER_URL` on the box and restart the agent.

### Isolation

Chromium loads whatever the HTML points at, and render-svc only checks the `url` field against
private addresses, not the resources inside the HTML. So:

- `render` is on its own network (`render`, `172.31.250.0/24`, bridge `br-render`). Caddy joins
  both networks; the app is not on `render`.
- `render-egress.service` drops new connections from that subnet to `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16` (Oracle metadata), `100.64/10`, `127/8`, and to the bridge gateway
  (`172.31.250.1`, the VM itself). Replies to Caddy and the public internet stay allowed.

Checked from inside the container: metadata, `app:3000`, the VM's private IP and the gateway's
SSH all time out; `https://example.com` answers 200.

### Size and speed

Idle it holds ~250 MB (render-svc closes Chromium after 240 s without requests). A cold PDF
takes ~4 s, a warm one ~0.9 s. The VM has 1 OCPU: parallel renders queue. Oracle's Always Free
Ampere shape allows up to 4 OCPU / 24 GB.

## The agent box side

The agent (`ghosty-lite-runtime.service`) reads `/etc/ghosty-lite-runtime/.env` when it starts.
`GS_RENDER_URL` goes there, and the scripts the agent runs inherit it:

```bash
# boxexec: see CURLS.md / the helper that wraps POST /sandboxes/$AGENT_BOX_ID/exec
S=$(ssh -i ~/.ssh/oracle-app opc@140.84.190.139 'cat ~/acp-agent-ui/.render-secret')
boxexec "f=/etc/ghosty-lite-runtime/.env; cp -p \$f \$f.bak-\$(date +%F-%H%M%S); sed -i '/^GS_RENDER_URL=/d' \$f; echo 'GS_RENDER_URL=https://render.140-84-190-139.sslip.io/$S' >> \$f; grep -c '^GS_RENDER_URL=' \$f"
```

It prints `1`. The file is on the box's root disk: it survives a restart or reboot, **not** a
new box.

### Applying it: restart the agent, do not create a new one

The running agent keeps the environment it started with, so it needs one restart:

```bash
boxexec "systemctl restart ghosty-lite-runtime; sleep 3; systemctl is-active ghosty-lite-runtime"
```

- It cuts a turn in progress and drops the app's ACP connection; the app reconnects on the next
  message. Do it when nobody is mid-turn.
- The start script (`ghosty-lite-start`) rebuilds the prompt copies from `/data/agent/PROMPT.md`
  through `ghosty-prompt-hooks`, so the system prompt is unchanged (see
  [agent-box.md](agent-box.md)). Anything edited by hand in those copies is lost, as always.
- Sandbox exec runs through `sandbox-agent.service`, a separate unit, so the command returns.

A new agent would not help: it starts from the template, without this line, and needs the
rest of [agent-box.md](agent-box.md) redone. If you create one anyway, pass `GS_RENDER_URL` in
the create body's `env` (EasyBits merges it into `/etc/ghosty-lite-runtime/.env`), or run the
command above on the new box and restart it.

### Checking it

**The service, through the SDK the agent uses.** Exec commands do not load the agent's env
file, so this one reads the URL from it. It runs from a session directory, as the agent does:

```bash
boxexec "cd \$(ls -d /data/work/s/*/ | tail -1) && GS_RENDER_URL=\$(sed -n 's/^GS_RENDER_URL=//p' /etc/ghosty-lite-runtime/.env) node --input-type=module -e '
import { pdf } from \"/opt/gs-sdk/render.mjs\";
console.log(\"PDF bytes:\", (await pdf(\"<h1>ok</h1>\")).length);'"
```

**The agent process has it** (after the restart). Prints `1`; `0` means the agent started
before the line was added:

```bash
boxexec "tr '\0' '\n' < /proc/\$(systemctl show -p MainPID --value ghosty-lite-runtime)/environ | grep -c '^GS_RENDER_URL='"
```

Then ask the agent in the app for a short PDF ("Hazme un PDF que diga hola"). A 503 with "no
'render-svc' running for this account" means it is still on the old environment.

## On the VM

```bash
ssh -i ~/.ssh/oracle-app opc@140.84.190.139
cd ~/acp-agent-ui
docker compose ps render                                  # Up
docker compose exec -T caddy wget -qO- http://render:9300/health   # {"ok":true}
docker compose logs --tail 50 render
sudo iptables -S RENDER-EGRESS                            # the drop rules
```

Rebuilding after a template update in `sandbox-host`:

```bash
# from a machine with the sandbox-host checkout
tar -C sandbox-host/templates -czf - render-svc | ssh -i ~/.ssh/oracle-app opc@140.84.190.139 \
  'rm -rf ~/render-svc-src && mkdir ~/render-svc-src && tar -C ~/render-svc-src --strip-components=1 -xzf -'
ssh -i ~/.ssh/oracle-app opc@140.84.190.139 \
  'cd ~/render-svc-src && docker build -t render-svc:local . && cd ~/acp-agent-ui && docker compose up -d render'
```

To remove it: delete the `COMPOSE_FILE` line from `.env`, `docker compose up -d --remove-orphans`
(Caddy goes back to the tracked Caddyfile), `sudo systemctl disable --now render-egress`, and
remove the iptables rules (`sudo iptables -D DOCKER-USER …`, `-D INPUT …`, then flush and delete
the `RENDER-EGRESS` chain). On the box, delete the `GS_RENDER_URL` line and restart the agent.
