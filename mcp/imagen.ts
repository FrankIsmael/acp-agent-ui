/**
 * MCP `imagen` — spec 5. Una sola herramienta, `generar_imagen(prompt)`, que pide la imagen a
 * un generador por HTTP y la devuelve como bloque `image` de MCP. Sin dependencias ni llave.
 *
 * Corre por stdio (`node --experimental-strip-types mcp/imagen.ts`) o como Streamable HTTP
 * (`--http 4123`), porque el adaptador `claude-acp` sólo monta MCPs http. El agente no sabe de
 * WhatsApp ni de la web: devuelve la imagen por el protocolo y cada canal decide cómo entregarla.
 *
 * Generador: https://image.pollinations.ai/prompt/<prompt>?width=&height= (`IMAGEN_URL` lo cambia).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";

const GENERATOR = process.env.IMAGEN_URL ?? "https://image.pollinations.ai/prompt/";
const TIMEOUT_MS = Number(process.env.IMAGEN_TIMEOUT_MS ?? 90_000);

type Json = Record<string, unknown>;
interface Request { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Json }

const TOOLS = [{
  name: "generar_imagen",
  description: "Genera una imagen a partir de una descripción en texto y la devuelve como imagen. Úsala cuando te pidan una foto, ilustración, dibujo o imagen de cualquier cosa.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Qué debe verse en la imagen, en inglés o español, con detalle." },
      width: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
      height: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
    },
    required: ["prompt"],
  },
}];

async function generar(args: Json) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("Falta el prompt");
  const clamp = (v: unknown, d: number) => Math.min(2048, Math.max(256, Number(v) || d));
  const url = new URL(GENERATOR + encodeURIComponent(prompt));
  url.searchParams.set("width", String(clamp(args.width, 1024)));
  url.searchParams.set("height", String(clamp(args.height, 1024)));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("seed", String(Math.floor(Math.random() * 1e9)));
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`El generador contestó ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  if (!mimeType.startsWith("image/")) throw new Error(`El generador no devolvió una imagen (${mimeType})`);
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: `Imagen generada para: "${prompt}". Ya se la entregué al usuario; no hace falta describirla ni volver a mandarla.` },
    ],
  };
}

async function handle(request: Request): Promise<Json | undefined> {
  const { id, method, params = {} } = request;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined) return undefined; // notificación: no se contesta
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "imagen", version: "1.0.0" },
      });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      if (params.name !== "generar_imagen") return fail(-32602, `Herramienta desconocida: ${String(params.name)}`);
      try { return reply(await generar((params.arguments ?? {}) as Json)); }
      catch (error) { return reply({ content: [{ type: "text", text: `No pude generar la imagen: ${(error as Error).message}` }], isError: true }); }
    }
    default: return fail(-32601, `Método no soportado: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Transportes
// ---------------------------------------------------------------------------
function stdio() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async line => {
    if (!line.trim()) return;
    let request: Request;
    try { request = JSON.parse(line); } catch { return; }
    const response = await handle(request);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}

function http(port: number) {
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/mcp") { res.writeHead(404).end(); return; }
    // GET → stream SSE abierto con latido: el cliente lo usa para mensajes servidor→cliente.
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => clearInterval(beat));
      return;
    }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let payload: Request | Request[];
    try { payload = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } })); return; }
    const batch = Array.isArray(payload) ? payload : [payload];
    const responses = (await Promise.all(batch.map(handle))).filter(Boolean);
    // Sólo notificaciones (sin id) → 202 sin cuerpo.
    if (!responses.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  });
  server.listen(port, "127.0.0.1", () => console.error(`[imagen] MCP http en http://127.0.0.1:${port}/mcp`));
}

const flag = process.argv.indexOf("--http");
if (flag !== -1) http(Number(process.argv[flag + 1] ?? 4123));
else stdio();
