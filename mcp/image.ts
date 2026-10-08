/**
 * MCP `image` — spec 5. A single tool, `generate_image(prompt)`, that requests the image from
 * a generator over HTTP and returns it as an MCP `image` block. No dependencies, no key.
 *
 * Runs over stdio (`node --experimental-strip-types mcp/image.ts`) or as Streamable HTTP
 * (`--http 4123`), because the `claude-acp` adapter only mounts http MCPs. The agent knows nothing
 * about WhatsApp or the web: it returns the image through the protocol and each channel decides
 * how to deliver it.
 *
 * Generator: https://image.pollinations.ai/prompt/<prompt>?width=&height= (`IMAGE_URL` overrides it).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";

const GENERATOR = process.env.IMAGE_URL ?? "https://image.pollinations.ai/prompt/";
const TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 90_000);

type Json = Record<string, unknown>;
interface Request { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Json }

const TOOLS = [{
  name: "generate_image",
  description: "Generates an image from a text description and returns it as an image. Use it when asked for a photo, illustration, drawing or image of anything.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the image should show, in English or Spanish, in detail." },
      width: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
      height: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
    },
    required: ["prompt"],
  },
}];

async function generate(args: Json) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("Missing prompt");
  const clamp = (v: unknown, d: number) => Math.min(2048, Math.max(256, Number(v) || d));
  const url = new URL(GENERATOR + encodeURIComponent(prompt));
  url.searchParams.set("width", String(clamp(args.width, 1024)));
  url.searchParams.set("height", String(clamp(args.height, 1024)));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("seed", String(Math.floor(Math.random() * 1e9)));
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The generator responded ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  if (!mimeType.startsWith("image/")) throw new Error(`The generator did not return an image (${mimeType})`);
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: `Image generated for: "${prompt}". It has already been delivered to the user; no need to describe it or send it again.` },
    ],
  };
}

async function handle(request: Request): Promise<Json | undefined> {
  const { id, method, params = {} } = request;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined) return undefined; // notification: no reply
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "image", version: "1.0.0" },
      });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      // `generar_imagen` is the pre-rename name: threads opened before keep calling it.
      if (params.name !== "generate_image" && params.name !== "generar_imagen") return fail(-32602, `Unknown tool: ${String(params.name)}`);
      try { return reply(await generate((params.arguments ?? {}) as Json)); }
      catch (error) { return reply({ content: [{ type: "text", text: `Could not generate the image: ${(error as Error).message}` }], isError: true }); }
    }
    default: return fail(-32601, `Unsupported method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Transports
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
    // GET → open SSE stream with heartbeat: the client uses it for server→client messages.
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
    try { payload = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } })); return; }
    const batch = Array.isArray(payload) ? payload : [payload];
    const responses = (await Promise.all(batch.map(handle))).filter(Boolean);
    // Only notifications (no id) → 202 with no body.
    if (!responses.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  });
  server.listen(port, "127.0.0.1", () => console.error(`[image] MCP http on http://127.0.0.1:${port}/mcp`));
}

const flag = process.argv.indexOf("--http");
if (flag !== -1) http(Number(process.argv[flag + 1] ?? 4123));
else stdio();
