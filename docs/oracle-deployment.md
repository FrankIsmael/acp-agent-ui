# Oracle Always Free deployment

This deployment deliberately keeps the UI, ACP gateway, and Baileys WhatsApp
connection in one long-lived Node process. It is therefore unlike a Vercel
Function deployment: the process owns the live ACP and WhatsApp WebSockets.

## Before deploying

1. Create an Oracle Always Free VM and assign it a public IPv4 address.
2. In the VM's OCI security list (or network security group), allow inbound TCP
   ports `80` and `443`. Keep SSH (`22`) restricted to your own IP address.
3. Create an `A` DNS record for your chosen hostname pointing to the VM's public
   IPv4 address. DNS must be live before Caddy can obtain its TLS certificate.
4. Install Docker Engine and the Docker Compose plugin on the VM.

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

Keep that archive private: it includes WhatsApp session credentials. Turso is
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

Repository → Settings → Secrets and variables → Actions, or with `gh`:

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

- **Commands stay `ACCEPTED`:** check
  `/var/log/oracle-cloud-agent/plugins/runcommand/runcommand.log` on the VM.
  After a `404 NotAuthorizedOrNotFound` (for example, a poll made before the
  dynamic group policy existed) the agent stops polling for an hour
  (`circuitbreaker:[pollCommand] is open`). Fix the policy, then
  `sudo systemctl restart oracle-cloud-agent`. A healthy log shows
  `poll command status: 200`.
- **`NotAuthorizedOrNotFound` in the workflow's `command create`:** the
  deployer user's group or policy, or a wrong `OCI_COMPARTMENT_ID` secret. To
  isolate it, run the same `oci instance-agent command create` in Cloud Shell:
  as your admin user it checks the OCIDs; with a profile for the deployer's
  API key (`--profile DEPLOYER --auth api_key`) it checks its permissions.
