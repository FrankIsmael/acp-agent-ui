/**
 * Instala el MCP de imagen (`mcp/imagen.ts`) en la caja del agente como unidad de systemd
 * (`imagen.service`, `Restart=always`, arranca con la caja), deja un `CLAUDE.md` en `/data/work`
 * para que el agente use la tool a la primera, y da de alta la extensión http en la base de
 * este cliente (`http://127.0.0.1:4123/mcp`). Después: **hilo nuevo** — el hilo abierto se
 * queda con la conexión MCP vieja.
 *
 *   node --env-file=.env scripts/install-imagen-mcp.mjs
 *
 * Variables: EASYBITS_API_KEY, AGENT_BOX_ID, ACP_EXTENSIONS_DB (opcional), IMAGEN_PORT (4123).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { easybitsClient, required } from "./lib/easybits.mjs";

const BOX = required(process.env.AGENT_BOX_ID, "AGENT_BOX_ID");
const PORT = Number(process.env.IMAGEN_PORT ?? 4123);
const REMOTE = "/data/workspace/imagen.ts";
const eb = easybitsClient();

const source = readFileSync(new URL("../mcp/imagen.ts", import.meta.url), "utf8");
const unit = `[Unit]
Description=MCP imagen (generar_imagen) por HTTP
After=network-online.target

[Service]
Type=simple
ExecStart=__NODE__ --experimental-strip-types ${REMOTE} --http ${PORT}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
const claudeMd = `# Herramientas de este agente

- Para cualquier imagen, foto, ilustración o dibujo que te pidan, llama a la tool
  \`generar_imagen\` (servidor MCP \`imagen\`) con un prompt detallado. No busques SDKs ni
  escribas código para generar imágenes: la tool ya la devuelve lista y el cliente se la
  enseña al usuario. Después de llamarla, contesta con una línea breve; no describas la imagen.
`;

// Sin `ps`/`pgrep` en /exec, y `pkill -f` mata al propio shell: systemd se encarga del proceso.
const script = `
set -e
NODE=$(command -v node || ls /usr/local/bin/node 2>/dev/null | head -1)
[ -n "$NODE" ] || { echo "ERROR: no hay node en la caja"; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22&&b<6)) { console.error("ERROR: node "+process.versions.node+" no quita tipos (hace falta ≥ 22.6)"); process.exit(1) }'
mkdir -p /data/workspace /data/work
cat > ${REMOTE} <<'IMAGEN_TS'
${source}
IMAGEN_TS
cat > /etc/systemd/system/imagen.service <<UNIT
${unit.replace("__NODE__", "$NODE")}UNIT
if [ ! -f /data/work/CLAUDE.md ] || ! grep -q generar_imagen /data/work/CLAUDE.md; then
  cat >> /data/work/CLAUDE.md <<'CLAUDE_MD'
${claudeMd}CLAUDE_MD
fi
systemctl daemon-reload
systemctl enable --now imagen.service
systemctl restart imagen.service
sleep 2
systemctl is-active imagen.service
curl -s -X POST http://127.0.0.1:${PORT}/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
echo
`;

console.log(`[imagen] instalando en ${BOX}…`);
const out = await eb.exec(BOX, script, 180);
console.log(out.trim());
if (!out.includes("generar_imagen")) {
  console.error("[imagen] la unidad arrancó pero el MCP no contesta en la caja. Revisa: journalctl -u imagen.service");
  process.exit(1);
}

// Alta en la base local, con el mismo esquema que `app/.server/extensions.ts`.
const dbPath = process.env.ACP_EXTENSIONS_DB || ".data/extensions.db";
const db = new DatabaseSync(resolve(dbPath));
db.exec("PRAGMA busy_timeout = 5000;");
const exists = db.prepare("SELECT id FROM extensions WHERE name = ?").get("imagen");
if (exists) {
  db.prepare("UPDATE extensions SET transport = 'http', url = ?, enabled = 1 WHERE name = 'imagen'").run(`http://127.0.0.1:${PORT}/mcp`);
  console.log("[imagen] extensión `imagen` actualizada en", dbPath);
} else {
  db.prepare(`INSERT INTO extensions (id, name, transport, command, args, url, headers, env, enabled, created_at, description)
    VALUES (?, 'imagen', 'http', NULL, '[]', ?, '[]', '[]', 1, ?, ?)`)
    .run(randomUUID(), `http://127.0.0.1:${PORT}/mcp`, Date.now(), "Genera imágenes (generar_imagen)");
  console.log("[imagen] extensión `imagen` dada de alta en", dbPath);
}
db.close();
console.log("[imagen] listo. Abre un HILO NUEVO: el abierto se queda con la conexión MCP vieja.");
