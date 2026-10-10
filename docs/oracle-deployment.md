# Oracle Always Free deployment

This deployment deliberately keeps the UI, ACP gateway, and Baileys WhatsApp
connection in one long-lived Node process. It is therefore unlike a Vercel
Function deployment: the process owns the live ACP and WhatsApp WebSockets.

## Before deploying

1. Create an Always Free VM (`VM.Standard.A1.Flex`, Oracle Linux 9). If the
   instance's Networking tab offers **Connect public subnet to internet**, run
   it: the VCN has no internet gateway yet.
2. Assign a **reserved** public IP (VNIC → IP administration → Edit), so the
   address survives stop/start.
3. In the subnet's security list, allow inbound TCP `80,443` from `0.0.0.0/0`.
   Keep SSH (`22`) restricted to your own IP. An empty network security group
   does not block anything: OCI allows traffic that any list or group allows.
4. Point an `A` record at the IP before the first start, so Caddy can obtain its
   certificate. Without a domain, `APP_DOMAIN=<ip-with-dashes>.sslip.io` works.
5. On the VM, open the host firewall and install Docker CE (Oracle Linux ships
   Podman, which Compose does not handle well):

   ```sh
   sudo firewall-cmd --permanent --add-service=http --add-service=https
   sudo firewall-cmd --reload
   sudo dnf install -y git dnf-plugins-core
   sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
   sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
   sudo systemctl enable --now docker
   sudo usermod -aG docker opc   # then log out and back in
   ```

## Deploy

```sh
git clone https://github.com/FrankIsmael/acp-agent-ui.git
cd acp-agent-ui
cp deploy/oracle/.env.example .env
chmod 600 .env
# Edit .env: APP_DOMAIN, ACP_WS_URL, ACP_TOKEN, and WHATSAPP_ADMIN_KEY are required.
deploy/oracle/deploy.sh
docker compose logs -f app caddy
```

The VM never builds: it runs the image that CI publishes to
`ghcr.io/frankismael/acp-agent-ui` (see "Automatic deploys" below).

The `app` container restarts automatically. Caddy terminates HTTPS and renews
certificates automatically. Do not publish port `3000`; only Caddy exposes the
application on ports 80 and 443.

## Persistent data and backups

`./.data` is bind-mounted into the app at `/app/.data`. It currently contains
the SQLite extension store, local titles, and Baileys WhatsApp credentials.
It must survive deployment updates. Back it up before changing hosts:

```sh
tar -C . -czf acp-agent-data-backup.tgz .data
```

The app container runs as the unprivileged `node` user (uid 1000), so
`.data` must be owned by uid 1000. On a new VM create it before the first start;
on a VM that ran the older root image, run this once **before** deploying the
non-root image, or the app fails with `unable to open database file`:

```sh
mkdir -p .data && sudo chown -R 1000:1000 .data
```

Run `sqlite3` against these files as that user (`sudo -u '#1000' sqlite3 …`),
never as root. See `ORACLE-SSH.md`.

Keep that archive private: it includes WhatsApp session credentials. Pair
WhatsApp fresh on the server rather than copying a local session: the same
Baileys session running in two places keeps disconnecting both. Turso is
configured in the environment template for the planned data-layer migration,
but it does not yet replace the local SQLite stores.

## Updates

Pushing to `main` deploys on its own (see "Automatic deploys"). To deploy by
hand (for example after a failed webhook call), run `deploy/oracle/deploy.sh`.

An update restarts the app and briefly disconnects WhatsApp; the persisted
credentials reconnect it automatically. In-flight ACP turns are interrupted.

`deploy.sh` pulls `:main`, and if it moved, fast-forwards this checkout to the
image's commit, pins the image digest in `docker-compose.override.yml` (which
Compose loads on its own, so a manual `docker compose up` keeps that image),
starts it and checks `/healthz`. If the new image fails the health check, it
pins the previous digest again, records the bad one in `.deploy-failed` so the
daily fallback does not retry it, and exits non-zero. Fix forward with a new
push. To run an older build on purpose, pin its tag yourself; until you push
again, nothing replaces it except the daily fallback, so stop that meanwhile:

```sh
sudo systemctl stop acp-deploy.timer
printf 'services:\n  app:\n    image: ghcr.io/frankismael/acp-agent-ui:sha-<full-sha>\n' > docker-compose.override.yml
docker compose up -d app
```

Edit code only through git. A local change in this checkout makes
`git merge --ff-only` fail and blocks every automatic deploy; `git status` must
be clean.

## Registering MCP extensions

Each `scripts/install-*-mcp.mjs` script adds or updates a row in
`.data/extensions.db`. Some also set up the MCP server itself. The VM has no
Node, and `.dockerignore` leaves `scripts/` and `mcp/` out of the image, so run
these scripts in a one-off container built from the app image, with those two
folders mounted. The container gets the app's `.env`, its `.data` bind mount,
and the `node` user:

```sh
docker compose run --rm --no-deps \
  -v ./scripts:/app/scripts:ro -v ./mcp:/app/mcp:ro \
  app node scripts/install-<name>-mcp.mjs
```

| Script | Extension | What it does | Needs in `.env` |
|---|---|---|---|
| `install-maps-mcp.mjs` | `google-maps` | Registers Google's hosted Maps Grounding Lite MCP (`https://mapstools.googleapis.com/mcp`). It checks the key with a real call first and writes nothing if the key fails. | `GM_MCP_KEY` (server key; a referrer-restricted browser key is rejected), or it falls back to `GM_DEMO_KEY` |
| `install-image-mcp.mjs` | `image` | Copies `mcp/image.ts` to the agent box as the `image.service` systemd unit (its instructions are in `scripts/system-prompt.md`). It registers `http://127.0.0.1:4123/mcp`. | `AGENT_BOX_ID`, `EASYBITS_API_KEY`; optional `IMAGE_PORT` |

`install-image-mcp` also installs on the agent box, which loses it when the box is recreated: see
[agent-box.md](agent-box.md) for the full redo order.

After any of them, open a **new thread**: threads that are already open keep
their old MCP connections. The app does not need a restart. Both scripts are
safe to run again (for example after changing a key or updating `mcp/image.ts`),
because they update the existing row.

Mount the folders; don't `docker compose cp` a single file. `install-image-mcp`
imports `./lib/` and reads `mcp/image.ts`, so copying just the script fails.
(`agent-prompt.mjs` reads `scripts/system-prompt.md` and `public/`, so it has to
run from a full checkout too.) Never run these scripts as root (`docker compose exec -u root`,
plain `docker run`): SQLite would leave root-owned `-wal`/`-shm` files in
`.data`, and the app would fail with `unable to open database file`.

## Automatic deploys

`.github/workflows/deploy.yml` runs on every push to `main`. It typechecks on
`ubuntu-latest` and, in parallel, builds the arm64 image natively on
`ubuntu-24.04-arm` (with the layer cache in GitHub Actions) and pushes it as
`:sha-<commit>`. Once both pass it retags that image `:main`. Pushing to GHCR
uses only the built-in `GITHUB_TOKEN`.

Its last step, `Deploy on the VM`, calls `POST https://<APP_DOMAIN>/_deploy`
with a bearer token. Caddy forwards that path over a unix socket to
`deploy/oracle/deploy-hook.py` (`acp-deploy-hook.service`), which runs
`deploy.sh` and answers with its output: the step prints it and fails unless the
deploy succeeded. The `X-Revision` header carries the pushed commit, so the VM
fails instead of reporting success for some other commit. The token can only
ask for "deploy the current `:main`", not choose an image or run anything else.

`acp-deploy.timer` runs the same `deploy.sh` once a day and after boot, to
catch a push whose webhook call never arrived. When `:main` has not moved it
only prints `already running <sha>`.

### 1. Make the image public (once)

The first workflow run creates the package as private. On GitHub: your profile
→ Packages → `acp-agent-ui` → Package settings → Change visibility → Public.
The VM then pulls without credentials.

### 2. Create the deploy token

```sh
openssl rand -hex 32   # on any machine; use the same value in both places below
```

On the VM, outside the app's `.env` so the app container never sees it:

```sh
echo 'DEPLOY_TOKEN=<token>' | sudo tee /etc/acp-deploy.env >/dev/null
sudo chmod 600 /etc/acp-deploy.env
```

In GitHub (with `gh repo set-default FrankIsmael/acp-agent-ui` first in a clone
that also has the upstream remote):

```sh
gh secret set DEPLOY_TOKEN
gh variable set DEPLOY_URL --body https://<APP_DOMAIN>/_deploy
```

To rotate it, change both and `sudo systemctl restart acp-deploy-hook`.

### 3. Install the units on the VM

```sh
sudo cp deploy/oracle/acp-deploy.service deploy/oracle/acp-deploy.timer \
  deploy/oracle/acp-deploy-hook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now acp-deploy-hook.service acp-deploy.timer
# Caddy needs the new Caddyfile and the socket mount: recreate it.
docker compose up -d --force-recreate caddy
```

Check the whole path from outside: a wrong token must answer `401`.

```sh
curl -si -X POST https://<APP_DOMAIN>/_deploy | head -1
```

The units are copies: after changing them in git, copy them again, run
`daemon-reload`, and restart the hook. `deploy.sh` changes apply on the next
deploy on their own; `deploy-hook.py` changes only after
`sudo systemctl restart acp-deploy-hook`.

A deploy that changes the `caddy` service in `docker-compose.yml` recreates
Caddy, which cuts the webhook's own connection: that run shows as failed while
the deploy carries on. Check `journalctl -u acp-deploy-hook` and rerun the
workflow; it answers `already running <sha>` once it is done.

### Moving from the Run Command setup

The workflow no longer uses OCI Run Command, so all of that can go:

```sh
sudo rm /etc/sudoers.d/90-ocarun-deploy
docker image rm acp-agent-ui-app:latest acp-agent-ui-app:previous   # old local builds
docker builder prune -af                                            # their build cache
```

Then delete the `OCI_*` repository secrets (`gh secret delete OCI_CLI_USER`,
and so on), the `github-deployer` user, its group and API key, the
`acp-agent-vm` dynamic group and its policy, and disable the **Compute Instance
Run Command** plugin.

### Troubleshooting

- **Every visitor hits the demo limit ("This network has reached the limit"):**
  `DEMO_TRUSTED_PROXIES=uniquelocal` is missing from `.env`, so all requests
  count as Caddy's IP. Add it, `docker compose up -d --force-recreate app`, and
  clear the shared bucket with
  `sudo -u '#1000' sqlite3 .data/demo.db "DELETE FROM demo_ip_limits;"`.
- **App returns 500 / logs `unable to open database file`:** something in
  `.data` is not owned by uid 1000 (e.g. a `-wal` file created by root
  `sqlite3`). Fix with `sudo chown -R 1000:1000 .data` and
  `docker compose restart app`.
- **`Deploy on the VM` fails:** the step prints `deploy.sh`'s output. With no
  output: HTTP `401` is a token mismatch between the GitHub secret and
  `/etc/acp-deploy.env`; `502` means Caddy cannot reach the hook
  (`systemctl status acp-deploy-hook`, and recreate Caddy if it started before
  the hook created `/run/acp-deploy`); no response at all means the VM or Caddy
  is down, or `DEPLOY_URL` is wrong.
- **`denied` or `unauthorized` from `docker pull`:** the package is still
  private (step 1).
- **`Not possible to fast-forward`:** someone edited this checkout. `git status`,
  then discard or commit the change through git.
- **A fixed image is not picked up:** `.deploy-failed` holds a digest only until
  `:main` moves, so a new push clears it. To retry the same image, `rm .deploy-failed`.
