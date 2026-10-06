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
