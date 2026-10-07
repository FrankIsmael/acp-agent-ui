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
docker compose up -d --build
docker compose logs -f app caddy
```

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

```sh
git pull --ff-only
docker compose up -d --build
```

An update restarts the app and briefly disconnects WhatsApp; the persisted
credentials reconnect it automatically. In-flight ACP turns are interrupted.

`deploy/oracle/deploy.sh` does the same (plus a health check and image prune)
and is what the automatic deploy below runs.

## Automatic deploys (OCI Run Command)

`.github/workflows/deploy.yml` deploys every push to `main`. It never opens an
SSH connection: with an OCI API key it creates a Run Command, and the Oracle
Cloud Agent on the VM runs `deploy.sh` as `opc`. SSH can stay restricted to your
own IP. The agent polls for commands about every 4 minutes, so a deploy can
take that long to start.

### 1. Enable the plugin

Instance → **Oracle Cloud Agent** (Management tab) → enable **Compute Instance
Run Command**. After a few minutes the agent creates the `ocarun` user
(`id ocarun` on the VM).

### 2. Let the agent run only the deploy script as `opc`

```sh
echo 'ocarun ALL=(opc) NOPASSWD: /home/opc/acp-agent-ui/deploy/oracle/deploy.sh' \
  | sudo tee /etc/sudoers.d/90-ocarun-deploy
sudo chmod 440 /etc/sudoers.d/90-ocarun-deploy
sudo visudo -cf /etc/sudoers.d/90-ocarun-deploy
# Dry run of exactly what the workflow will execute:
sudo -u ocarun sudo -n -u opc /home/opc/acp-agent-ui/deploy/oracle/deploy.sh
```

### 3. IAM (Identity & Security → Domains → Default domain)

1. **Dynamic group** `acp-agent-vm` with the rule
   `instance.id = '<instance OCID>'`.
2. **Group** `github-deployers`, and a **user** `github-deployer` in it (no
   console password needed).
3. On that user: **API keys → Add API key → Generate key pair**. Download the
   private key and keep the configuration preview it shows (user, fingerprint,
   tenancy, region).
4. **Policy** in the root compartment:

   ```
   Allow dynamic-group 'Default'/'acp-agent-vm' to use instance-agent-command-execution-family in tenancy where request.instance.id = target.instance.id
   Allow group 'Default'/'github-deployers' to manage instance-agent-command-family in tenancy
   Allow group 'Default'/'github-deployers' to read instance-agent-command-execution-family in tenancy
   Allow group 'Default'/'github-deployers' to read instance-family in tenancy
   ```

   Without the two `read` lines the deploy still runs, but the workflow cannot
   read its result and times out.

   This lets the key run commands on any instance in the tenancy, which is
   fine while this VM is the only one. Move the VM to its own compartment and
   scope the second statement to it if that changes.

### 4. GitHub secrets

Repository → Settings → Secrets and variables → Actions, or with `gh`. In a
clone that also has the upstream remote, `gh` targets upstream by default, so
run `gh repo set-default FrankIsmael/acp-agent-ui` first.

```sh
gh secret set OCI_CLI_USER          # user OCID from the configuration preview
gh secret set OCI_CLI_TENANCY       # tenancy OCID
gh secret set OCI_CLI_FINGERPRINT   # API key fingerprint
gh secret set OCI_CLI_REGION --body mx-queretaro-1
gh secret set OCI_CLI_KEY_CONTENT < ~/Downloads/<private-key>.pem
gh secret set OCI_INSTANCE_ID       # instance OCID
gh secret set OCI_COMPARTMENT_ID    # tenancy OCID while the VM is in root
```

Run the workflow once from the Actions tab (**Run workflow**) to check the
setup. Its log shows the tail of `deploy.sh` output from the VM.

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
- **Commands stay `ACCEPTED`:** check
  `/var/log/oracle-cloud-agent/plugins/runcommand/runcommand.log` on the VM.
  After a `404 NotAuthorizedOrNotFound` (for example, a poll made before the
  dynamic group policy existed) the agent stops polling for an hour
  (`circuitbreaker:[pollCommand] is open`). Fix the policy, then
  `sudo systemctl restart oracle-cloud-agent`. A healthy log shows
  `poll command status: 200`.
- **Workflow times out after `no execution yet: NotAuthorizedOrNotFound`:**
  the deploy ran but the deployer cannot read its result; add the two `read`
  policy lines above.
- **`NotAuthorizedOrNotFound` in the workflow's `command create`:** the
  deployer user's group or policy, or a wrong `OCI_COMPARTMENT_ID` secret. To
  isolate it, run the same `oci instance-agent command create` in Cloud Shell:
  as your admin user it checks the OCIDs; with a profile for the deployer's
  API key (`--profile DEPLOYER --auth api_key`) it checks its permissions.
