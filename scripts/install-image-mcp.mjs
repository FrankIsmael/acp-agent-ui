/**
 * Installs the image MCP (`mcp/image.ts`) on the agent box as a systemd unit
 * (`image.service`, `Restart=always`, starts with the box), appends the tool instructions to the
 * box hints so the agent uses it, and registers the http extension in this client's database
 * (`http://127.0.0.1:4123/mcp`).
 *
 * The hints go into the same three files as `install-hints.mjs`, baked copy included:
 * `ghosty-lite-start` copies `/opt/goose/goosehints.md` over the other two on every boot, so a
 * block written only to `CLAUDE.md` is gone after the next restart. Afterwards: **new thread** — the open thread keeps
 * the old MCP connection.
 *
 * Run it after `install-hints.mjs` on a new box: docs/agent-box.md.
 *
 * Also cleans up the pre-rename install (`imagen.service`, `/data/workspace/imagen.ts`, the
 * `imagen` extension row, and the `generar_imagen` / `imagen` names in the hints).
 *
 *   node --env-file=.env scripts/install-image-mcp.mjs
 *
 * Variables: EASYBITS_API_KEY, AGENT_BOX_ID, ACP_CWD (/data/work), ACP_EXTENSIONS_DB (optional),
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
const BAKED = '/opt/goose/goosehints.md';
const HINTS = [
  BAKED,
  `${process.env.ACP_CWD ?? '/data/work'}/CLAUDE.md`,
  '/data/ghosty/config/.goosehints',
];
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
const claudeMd = `
# Tools available to this agent

- For any image, photo, illustration, or drawing that is requested, use the
  \`generate_image\` tool (MCP server \`image\`) with a detailed prompt. Do not search for SDKs or
  write code to generate images: the tool already returns it ready, and the client will show it
  to the user. After using it, respond with a brief line; do not describe the image.
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
# Back up the baked hints once, as install-hints.mjs does.
cp -n ${BAKED} ${BAKED}.bak 2>/dev/null || true
for f in ${HINTS.join(' ')}; do
  mkdir -p "$(dirname "$f")"
  # Boxes installed before the rename still reference the old tool name.
  [ -f "$f" ] && sed -i -e 's/generar_imagen/generate_image/g' -e 's/\\(MCP server .\\)imagen\\(.\\)/\\1image\\2/g' "$f"
  if grep -qs generate_image "$f"; then echo "hints already there: $f"; else
    cat >> "$f" <<'CLAUDE_MD'
${claudeMd}CLAUDE_MD
    echo "hints written: $f"
  fi
done
# Newer templates rebuild every copy (incl. /data/work/.goosehints) from the baked file.
[ -x /usr/local/bin/ghosty-prompt-hooks ] && /usr/local/bin/ghosty-prompt-hooks
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
