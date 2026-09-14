/**
 * Levanta un agente ghosty-lite con Claude como provider y deja el .env apuntando a él.
 *
 *   EASYBITS_API_KEY=... CLAUDE_CODE_OAUTH_TOKEN=... node scripts/new-ghosty-agent.mjs [nombre]
 *   EASYBITS_API_KEY=... ANTHROPIC_API_KEY=...       node scripts/new-ghosty-agent.mjs [nombre]
 *
 * Es el camino de vuelta cuando la caja desaparece del host (404 "sandbox not found" con el
 * agente en `lost`; pasó el 2 sep y el 12 sep 2026). A diferencia de `new-goose-box.mjs`, aquí no
 * se instala nada: la plantilla `ghosty-lite` ya trae el agente y lee provider, modelo y
 * credenciales de su env al arrancar.
 *
 * Por qué Claude y no DeepSeek: con goose/ghosty sobre cualquier provider "normal", el cliente
 * MCP es rmcp y rechaza el `tools/list` de EasyBits (ver ESTADO.md). Con `claude-acp` el turno lo
 * ejecuta el adaptador de Claude Code, que trae su propio cliente MCP y sí entrega las tools.
 *
 * Variables:
 *   GHOSTY_PROVIDER   default claude-acp (alternativas: claude-code, anthropic)
 *   GHOSTY_MODEL      default sonnet
 *   GOOSE_MODE        default approve — con claude-acp goose pide `bypassPermissions`, que el
 *                     adaptador no ofrece, y cada turno muere con un Internal error mudo.
 *   ACP_AGENT_TOKEN   default: uno aleatorio. Es el `?token=` con el que la web se conecta.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!OAUTH && !API_KEY) throw new Error("falta CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) o ANTHROPIC_API_KEY");

const NAME = process.argv[2] ?? "mi-agente";
const PROVIDER = process.env.GHOSTY_PROVIDER ?? "claude-acp";
const MODEL = process.env.GHOSTY_MODEL ?? "sonnet";
const MODE = process.env.GOOSE_MODE ?? "approve";
const AGENT_TOKEN = process.env.ACP_AGENT_TOKEN ?? `agt_${randomBytes(24).toString("hex")}`;

const { EasybitsClient } = await import("@easybits.cloud/sdk");
const eb = new EasybitsClient({ apiKey: KEY });

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const env = {
  GHOSTY_PROVIDER: PROVIDER,
  GHOSTY_MODEL: MODEL,
  GOOSE_MODE: MODE,
  ACP_AGENT_TOKEN: AGENT_TOKEN,
  EASYBITS_API_KEY: KEY,
  ...(OAUTH ? { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } : { ANTHROPIC_API_KEY: API_KEY }),
};
console.log(`creando ${NAME}: ghosty-lite · ${PROVIDER}/${MODEL} · GOOSE_MODE=${MODE} · auth=${OAUTH ? "oauth" : "api-key"}`);
const created = await eb.createAgent({ template: "ghosty-lite", name: NAME, env, timeoutSeconds: 14400 });
console.log(`agente ${created.agentId} en caja ${created.sandboxId} (${since()})`);

// Lo primero es no perder el token: createAgent devuelve `agentUrl` como `sandbox://…:3000` (un
// marcador, no la URL real) y la URL wss:// sólo aparece después en getAgent. Si algo falla más
// adelante, con esto en .env se retoma a mano; sin esto el token aleatorio se pierde (pasó el
// 12 sep 2026 y hubo que rescatarlo de /etc/ghosty-lite-runtime/.env por exec).
const file = ".env";
let text = existsSync(file) ? readFileSync(file, "utf8") : "";
const set = (name, value) => {
  const line = `${name}=${value}`;
  text = new RegExp(`^${name}=`, "m").test(text) ? text.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
};
set("AGENT_BOX_ID", created.sandboxId);
set("ACP_SECRET", AGENT_TOKEN);
writeFileSync(file, text, { mode: 0o600 });
console.log(".env: AGENT_BOX_ID y ACP_SECRET guardados");

// La URL real y el runtime: getAgent hasta que agentUrl sea wss://, luego el handshake. Sin
// token contesta 401 y con el correcto 406 (quiere Upgrade); 404/502/503 = aún no escucha.
let agentUrl = "";
for (let i = 0; i < 90; i++) {
  if (!agentUrl.startsWith("wss://")) agentUrl = (await eb.getAgent(created.agentId)).agentUrl ?? "";
  if (agentUrl.startsWith("wss://")) {
    const r = await fetch(`${agentUrl.replace(/^wss:/, "https:")}?token=${AGENT_TOKEN}`).catch(() => null);
    if (r && ![404, 502, 503].includes(r.status)) {
      if (r.status === 401) throw new Error("el agente rechaza ACP_AGENT_TOKEN: revisa /etc/ghosty-lite-runtime/.env en la caja");
      console.log(`agente escuchando (HTTP ${r.status}, ${since()})`);
      break;
    }
  }
  if (i === 89) throw new Error(`el agente no levantó en 3 min (AGENT_BOX_ID=${created.sandboxId}; el token ya está en .env)`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
set("ACP_WS_URL", agentUrl);
writeFileSync(file, text, { mode: 0o600 });
console.log(`.env actualizado (ACP_WS_URL, ACP_SECRET, AGENT_BOX_ID) en ${since()} — reinicia npm run dev`);
