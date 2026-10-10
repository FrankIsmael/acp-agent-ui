/**
 * Installs the image MCP (`mcp/image.ts`) on the agent box as a systemd unit
 * (`image.service`, `Restart=always`, starts with the box) and registers the http extension in
 * this client's database (`http://127.0.0.1:4123/mcp`). The instructions that tell the agent to
 * use `generate_image` are in its system prompt (scripts/system-prompt.md, "Generating images").
 * Afterwards: **new thread** — the open thread keeps the old MCP connection.
 *
 * Runbook for a new box: docs/agent-box.md.
 *
 * Also cleans up the pre-rename install (`imagen.service`, `/data/workspace/imagen.ts` and the
 * `imagen` extension row).
 *
 *   node --env-file=.env scripts/install-image-mcp.mjs
 *
 * Variables: EASYBITS_API_KEY, AGENT_BOX_ID, ACP_EXTENSIONS_DB (optional),
 * IMAGE_PORT (4123).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { easybitsClient, required } from './lib/easybits.mjs';

const BOX = required(process.env.AGENT_BOX_ID, 'AGENT_BOX_ID');
const PORT = Number(process.env.IMAGE_PORT ?? 4123);
const REMOTE = '/data/workspace/image.ts';
const eb = easybitsClient();

const source = readFileSync(
  new URL('../mcp/image.ts', import.meta.url),
  'utf8',
);
const unit = `[Unit]
Description=MCP image (generate_image) over HTTP
After=network-online.target

[Service]
Type=simple
ExecStart=__NODE__ --experimental-strip-types ${REMOTE} --http ${PORT}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
// Without \`ps\`/\`pgrep\` in /exec, and \`pkill -f\` kills the shell itself: systemd manages the process.
const script = `
set -e
NODE=$(command -v node || ls /usr/local/bin/node 2>/dev/null | head -1)
[ -n "$NODE" ] || { echo "ERROR: node is not installed on the box"; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22&&b<6)) { console.error("ERROR: node "+process.versions.node+" does not support type stripping (need ≥ 22.6)"); process.exit(1) }'
mkdir -p /data/workspace /data/work
cat > ${REMOTE} <<'IMAGE_TS'
${source}
IMAGE_TS
# Pre-rename install: free port and unit before starting the new one.
if [ -f /etc/systemd/system/imagen.service ]; then
  systemctl disable --now imagen.service || true
  rm -f /etc/systemd/system/imagen.service
fi
rm -f /data/workspace/imagen.ts
cat > /etc/systemd/system/image.service <<UNIT
${unit.replace('__NODE__', '$NODE')}UNIT
systemctl daemon-reload
systemctl enable --now image.service
systemctl restart image.service
sleep 2
systemctl is-active image.service
curl -s -X POST http://127.0.0.1:${PORT}/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
echo
`;

console.log(`[image] installing on ${BOX}…`);
const out = await eb.exec(BOX, script, 180);
console.log(out.trim());
if (!out.includes('generate_image')) {
  console.error(
    '[image] the unit started but the MCP is not responding on the box. Check: journalctl -u image.service',
  );
  process.exit(1);
}

// Register in the local database, using the same schema as `app/.server/extensions.ts`.
const DESCRIPTION = 'Generates images (generate_image)';
const dbPath = process.env.ACP_EXTENSIONS_DB || '.data/extensions.db';
const db = new DatabaseSync(resolve(dbPath));
db.exec('PRAGMA busy_timeout = 5000;');
const byName = (name) =>
  db.prepare('SELECT id FROM extensions WHERE name = ?').get(name);
// Pre-rename row: rename it in place (keeps its id), or drop it if `image` already exists.
if (byName('imagen')) {
  if (byName('image')) db.prepare("DELETE FROM extensions WHERE name = 'imagen'").run();
  else db.prepare("UPDATE extensions SET name = 'image' WHERE name = 'imagen'").run();
  console.log('[image] migrated old extension `imagen` in', dbPath);
}
const exists = byName('image');
if (exists) {
  db.prepare(
    "UPDATE extensions SET transport = 'http', url = ?, enabled = 1, description = ? WHERE name = 'image'",
  ).run(`http://127.0.0.1:${PORT}/mcp`, DESCRIPTION);
  console.log('[image] extension `image` updated in', dbPath);
} else {
  db.prepare(
    `INSERT INTO extensions (id, name, transport, command, args, url, headers, env, enabled, created_at, description)
    VALUES (?, 'image', 'http', NULL, '[]', ?, '[]', '[]', 1, ?, ?)`,
  ).run(
    randomUUID(),
    `http://127.0.0.1:${PORT}/mcp`,
    Date.now(),
    DESCRIPTION,
  );
  console.log('[image] extension `image` registered in', dbPath);
}
db.close();
console.log(
  '[image] done. Open a NEW THREAD: the open one keeps the old MCP connection.',
);
