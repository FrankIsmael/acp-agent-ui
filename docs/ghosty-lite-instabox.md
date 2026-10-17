# ghosty-lite on instabox

How Robbie's agent runs on the instabox box `robbie-agent` (`m_agqupf2nhgt5exp4trttq2fdme`):
the `ghosty-lite` Docker image, pulled from GHCR, runs as one container inside the box.
The image is built elsewhere; the box only pulls and runs it.

```
app ──wss + token──▶ https://3100-agqupf2nhgt5exp4trttq2fdme.instabox.tech/acp
    (instabox port) ──▶ box 127.0.0.1:3100 ──▶ container `gl` :3000 (front) ──▶ ghosty serve ──▶ Claude Code
```

## 1. The image

| | |
|---|---|
| Image | `ghcr.io/frankismael/ghosty-lite:0699447-amd64` (private) |
| Built from | sandbox-host `0699447` (`fix/claude-skills-per-conversation`) + ghosty-lite fork `3006831cb` |
| Binary only | `ghcr.io/frankismael/ghosty-bin:3006831cb-amd64` (only needed to build the image) |
| Arch | **amd64 only.** instabox boxes are x86_64; Mac and Oracle Ampere need an arm64 build |

To build a new one, follow `sandbox-host/docs/ghosty-lite-local-e2e.md` steps 1–2 on an
**x86_64** machine (for `ghosty-bin`, keep the fork's `x86_64` target and only lighten the
cargo profile). Then tag and push:

```bash
docker tag ghosty-lite-local:test ghcr.io/frankismael/ghosty-lite:<sbh-sha>-amd64
docker push ghcr.io/frankismael/ghosty-lite:<sbh-sha>-amd64   # gh token needs write:packages
```

## 2. One-time box setup

The box uses the `agent-browser` template, which comes with Docker. On this box Docker 29 keeps images in
containerd's store on the 16 GB root disk, and the first build filled it. Move both stores to `/data`:

```bash
echo '{"data-root":"/data/docker"}' | sudo tee /etc/docker/daemon.json
sudo systemctl stop docker docker.socket containerd
sudo cp -a /var/lib/containerd /data/containerd && sudo rm -rf /var/lib/containerd
sudo ln -s /data/containerd /var/lib/containerd
sudo systemctl start containerd docker
```

Pull the image with a token that only has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u FrankIsmael --password-stdin
docker pull ghcr.io/frankismael/ghosty-lite:0699447-amd64
```

## 3. The folder: `/data/workspace/ghosty-lite/`

| File | What |
|---|---|
| `run.sh` | Recreates the container. Run it after any change below |
| `lite.env` (0600) | Container env. Read only at create time |
| `data/` | The container's `/data`: prompt, conversations, skills, repo. Survives recreating the container |
| `data/agent/PROMPT.md` + `PROMPT.mode` | Robbie's prompt (`scripts/system-prompt.md` without its leading comment), mode `replace` |
| `data/work/robbie.png` | Icon (`public/favicon.png`) |
| `ghosty-prompt-hooks` | The template's hooks with their `HINT` paragraph removed, mounted read-only over the image's copy |
| `image.ts` | Copy of `mcp/image.ts`, served inside the container on `127.0.0.1:4123` |
| `update-skills.sh` | Clones or pulls `SKILLS_REPO_URL` into `data/repo` and links each `.agents/skills/*` into `data/agent/skills` |
| `say` | Test helper: `./say "hola" [sessionId]` (talks to `localhost:3100/message`) |

`lite.env`:

```bash
CLAUDE_CODE_OAUTH_TOKEN=...      # claude setup-token
GHOSTY_PROVIDER=claude-acp
GHOSTY_MODEL=haiku
GOOSE_MODE=approve
ACP_AGENT_TOKEN=agt_...          # = the app's ACP_SECRET
GS_RENDER_URL=...                # PDF / PNG / slides
TIGRIS_ACCESS_KEY_ID=...         # file delivery (Oracle bucket)
TIGRIS_SECRET_ACCESS_KEY=...
STORAGE_ENDPOINT=...
STORAGE_BUCKET=...
STORAGE_REGION=...
GHOSTY_SANDBOX_READ=/data/repo   # lets conversations read the linked project skills
```

What `run.sh` does:

```bash
sudo ./update-skills.sh
docker rm -f gl
docker run -d --name gl --privileged --restart unless-stopped --env-file lite.env \
  -v "$PWD/data:/data" \
  -v "$PWD/ghosty-prompt-hooks:/usr/local/bin/ghosty-prompt-hooks:ro" \
  -v "$PWD/image.ts:/opt/robbie/image.ts:ro" \
  -p 127.0.0.1:3100:3000 \
  "$IMAGE" sh -c '(while :; do node --experimental-strip-types /opt/robbie/image.ts --http 4123; sleep 2; done) & exec ghosty-lite-start'
```

- `--privileged`: the launcher remounts `/proc` and gives each conversation its own uid.
- `127.0.0.1:3100` + instabox port, **not** `--network host`: the front skips the token for
  loopback clients, and with host networking the instabox proxy would look like one.
- The image MCP runs in the same container so `127.0.0.1:4123` (the app's `image` extension
  row) points at it.
- `robbie-skills.service` (systemd, enabled) runs `update-skills.sh` at each boot. Resuming from a pause doesn't
  run it. Run `sudo ./update-skills.sh` by hand after pushing a skill; it appears in the next conversation.

## 4. Publish and connect the app

```bash
instabox port publish robbie-agent 3100   # → https://3100-agqupf2nhgt5exp4trttq2fdme.instabox.tech
```

App `.env`:

```bash
ACP_WS_URL=wss://3100-agqupf2nhgt5exp4trttq2fdme.instabox.tech/acp
ACP_SECRET=<ACP_AGENT_TOKEN from lite.env>
AGENT_BOX_ID=m_agqupf2nhgt5exp4trttq2fdme
ACP_CWD=/data/work
INSTABOX_API_KEY=ibk_...          # machines:read + machines:write
ACP_IDLE_MS=600000                # the app sets the box's idle pause to this on every connect
```

With `INSTABOX_API_KEY` set, the app resumes the box before connecting (`ensureInstabox` in
`app/.server/acp.ts`).

Check: no token → `401` on `/acp`, `/message`, `/adjunto`; with the token, `initialize`
answers `ghosty-lite 1.51.0`.

## 5. Pausing

- The box pauses after 10 min idle (`instabox auto-suspend robbie-agent 10m`). Paused = memory and processes kept.
- An open dashboard Terminal tab probably counts as activity. Close it.
- Measured: a manual `instabox resume` took ~6 s. The first app conversation after a pause took ~33 s.
- After a **manual** `instabox suspend`, `exec` and `wake` fail; use `instabox resume`.
- The desktop is started only by the Computer tab or the computer-use MCP. Stop it with
  `pkill -u user -x xfce4-session; pkill -u user -x Xvnc`.

## 6. Updating

| Change | Do |
|---|---|
| New image | `docker pull …:<tag>` then `IMAGE=ghcr.io/frankismael/ghosty-lite:<tag> ./run.sh` |
| Env var | Edit `lite.env`, `./run.sh` |
| Prompt | Replace `data/agent/PROMPT.md` (keep `PROMPT.mode` = `replace`), `./run.sh`, new thread |
| Image MCP | Copy `mcp/image.ts` to `image.ts`, `./run.sh` |
| Project skill | Push to `main`, `sudo ./update-skills.sh` |

## Gotchas

- `instabox exec --stdin` caps input at 1 MB; send files with `instabox ssh <box> -- 'cat > file' < file`.
- Recreating the container keeps conversations because they live in `data/`. A container started without that mount keeps them inside itself, and `docker rm` deletes them.
- Not set up here (EasyBits had them): the `translate-skills.mjs` English descriptions.
