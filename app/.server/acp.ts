/**
 * Motor ACP del lado servidor — portado de web/server.mjs (SPEC-2).
 *
 * Una conexión ACP compartida; el agente conserva las conversaciones en la
 * caja de EasyBits. El navegador nunca habla ACP: consume los eventos por SSE.
 */
import { demoEnabled, conversationOwner, beginDemoTurn, chargeDemoOutput, estimateTokens, demoMessage, demoConversation } from "./demo";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { client, type ClientConnection } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import type { ConnectPhase } from "~/hooks/useAcpStream";
import { parseSkills, replayMetadata } from "./goose-adapter";
import { ARTIFACT_INSTRUCTIONS, CHANNEL_INSTRUCTIONS } from "./artifact-instructions";
import { PermissionQueue, type PendingPermission } from "./permissions";
import { extensionStore, summarizeExtensions } from "./extensions";
import { isGenericTitle, titleFromPrompt, titleStore } from "./titles";

// Sin URL no se inventa una: un fallback hardcodeado manda la sesión a la caja de otro y el
// fallo se ve como "el agente no responde" en vez de "te falta configurar esto".
const WS_URL = process.env.ACP_WS_URL ?? "";

// El token del agente REMOTO. `ACP_SECRET` se acepta como alias porque es el nombre que ya
// está en los .env de la gente.
//
// 🔴 NO es el `GOOSE_SERVER__SECRET_KEY` de la caja, como decía este archivo: ése es un
// secreto interno que se genera en cada arranque y nunca sale de la microVM. El de aquí es el
// token del agente — su `embedToken`, o el `ACP_AGENT_TOKEN` que le pusieran al crearlo.
const TOKEN = process.env.ACP_TOKEN ?? process.env.ACP_SECRET ?? "";

// `/data/work` es lo que existe en una caja ghosty-lite y lo único que sobrevive al sueño.
const CWD = process.env.ACP_CWD ?? "/data/work";

/**
 * Qué modelos ven imágenes.
 *
 * ACP no lo dice: `promptCapabilities.image` es del AGENTE, no del modelo, y
 * goose lo anuncia en true siempre. Si el modelo elegido no ve, goose sustituye
 * la imagen por `[image omitted: model does not support vision]` y el modelo
 * recibe un texto en lugar de los píxeles — sin error, sin aviso, y el agente
 * se pone a buscar el archivo por el disco. Por eso hay que saberlo aquí.
 *
 * Explícito con `ACP_VISION_MODELS` (ids separados por coma); si no, se cae a
 * mirar el nombre, que acierta con los `…-vision-…` y los `…-vl-…` de turno.
 */
const VISION_MODELS = (process.env.ACP_VISION_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Ids que ven imágenes aunque el nombre no lo diga. `openrouter/free` es un
 * router: enruta a lo que haya libre en OpenRouter, y eso incluye modelos con
 * visión, así que se asume que sí.
 */
const ALWAYS_VISION = new Set(["openrouter/free"]);

const isVisionModel = (id: string) =>
  ALWAYS_VISION.has(id) ||
  (VISION_MODELS.length > 0
    ? VISION_MODELS.includes(id)
    : /vision|-vl\b|-vl-/i.test(id));

/**
 * Modelos que el gateway sirve pero el agente no lista.
 *
 * goose arma su selector con los modelos que conoce de su proveedor, y esa
 * lista se queda corta: el gateway de EasyBits sirve `deepseek-v4-flash-vision-exp`
 * y goose sólo ofrece flash y pro. Medido contra la caja: `session/set_config_option`
 * con un id que no está en la lista SÍ se acepta, y el agente lo añade a la suya.
 * Así que se pueden inyectar aquí.
 *
 * Formato: `id|Nombre visible`, separados por coma. El nombre es opcional.
 */
const EXTRA_MODELS = (process.env.ACP_EXTRA_MODELS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [value, ...name] = entry.split("|");
    return { value: value.trim(), name: name.join("|").trim() || value.trim() };
  });
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Ciclo de vida de la caja del agente (app-owned): se despierta al hablarle y
// se suspende al quedar inactiva.
// ---------------------------------------------------------------------------
// Opcionales, y sin fallback por la misma razón que WS_URL: apuntaban a una caja y un snapshot
// concretos, así que un .env a medias operaba recursos ajenos. Sin ellos esto es un cliente ACP
// normal y el ciclo de vida simplemente no corre.
const AGENT_BOX = process.env.AGENT_BOX_ID ?? "";
const AGENT_SNAPSHOT = process.env.AGENT_SNAPSHOT_ID ?? "";
const EB_KEY =
  process.env.EASYBITS_API_KEY ??
  (() => {
    try {
      return readFileSync("/root/.ebkey", "utf8").trim();
    } catch {
      return null;
    }
  })();

let ebClient: any = null;
async function getEbClient() {
  if (ebClient) return ebClient;
  if (!EB_KEY) return null;
  try {
    // El SDK es opcional: sin él la app funciona, sólo no gestiona la caja.
    // @ts-ignore -- dependencia opcional, puede no estar instalada
    const { EasybitsClient } = await import("@easybits.cloud/sdk");
    ebClient = new EasybitsClient({ apiKey: EB_KEY });
  } catch (e: any) {
    console.warn("[lifecycle] sin SDK/API key:", e.message);
    ebClient = null;
  }
  return ebClient;
}

/**
 * Despierta la caja del agente ANTES de conectar. Es específico de EasyBits y OPCIONAL: sin
 * `EASYBITS_API_KEY` + `AGENT_BOX_ID` esto no corre y el cliente funciona igual contra
 * cualquier agente ACP — sólo que sin despertarlo él (el agente tiene que estar ya arriba).
 */
export async function ensureAgentBox() {
  if (!AGENT_BOX) return null; // cliente ACP genérico: no hay caja que gestionar
  const eb = await getEbClient();
  if (!eb) {
    console.warn("[lifecycle] sin SDK — no gestiono ciclo de vida");
    return null;
  }
  const sb = await eb.sandboxes.get(AGENT_BOX);
  await sb.refresh();
  console.log(`[lifecycle] caja agente status=${sb.status}`);
  if (sb.status === "running") {
    await sb.extend(3600).catch((e: Error) =>
      console.warn("[lifecycle] extend falló:", e.message)
    );
    return sb;
  }
  if (sb.status === "suspended") await sb.resume().catch(() => {});
  try {
    await sb.waitUntilReady(90_000);
    console.log("[lifecycle] caja despierta");
    return sb;
  } catch {
    // caja perdida → self-heal desde snapshot
  }
  // El self-heal desde snapshot creaba una caja NUEVA —con URL nueva— y acto seguido se
  // conectaba a la ACP_WS_URL vieja, así que nunca pudo funcionar: una recuperación que miente
  // es peor que ninguna. Sólo se intenta si hay snapshot configurado, y se avisa de que la URL
  // hay que cambiarla a mano.
  if (!AGENT_SNAPSHOT) {
    throw new AgentError(
      "El agente no despertó y no hay AGENT_SNAPSHOT_ID para recrearlo. Levántalo de nuevo y actualiza ACP_WS_URL."
    );
  }
  console.warn("[lifecycle] caja perdida; self-heal desde snapshot");
  const [child] = await eb.sandboxes.forkFromSnapshot(AGENT_SNAPSHOT, {});
  await child.waitUntilReady(90_000);
  console.warn(
    `[lifecycle] caja recreada (${child.id}) — ⚠️ su URL es otra: actualiza ACP_WS_URL o seguirás hablando con la anterior`
  );
  return child;
}

async function suspendAgentBox() {
  if (!AGENT_BOX) return;
  const eb = await getEbClient();
  if (!eb) return;
  try {
    const sb = await eb.sandboxes.get(AGENT_BOX);
    await sb.refresh();
    if (sb.status === "running") {
      await sb.suspend();
      console.log("[lifecycle] caja suspendida (idle)");
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Tipos de los eventos que viajan al navegador
// ---------------------------------------------------------------------------
/** Una imagen adjunta a un turno, ya en base64 (sin el prefijo `data:`). */
export interface PromptImage {
  mimeType: string;
  data: string;
  name?: string;
}

/**
 * Un selector que el agente expone para su sesión. ACP no tiene un
 * `session/set_model`: el modelo es una `SessionConfigOption` más, con
 * `category: "model"`. Ver el comentario largo en `handshake()`.
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type?: "select" | "boolean";
  currentValue?: string | boolean;
  options?: unknown;
}

export type AcpEvent =
  | { type: "snapshot"; messages: StoredMessage[]; busy: boolean; permissions: PendingPermission[] }
  | { type: "permissions"; permissions: PendingPermission[] }
  | { type: "title"; title: string }
  | { type: "started"; sessionId: string }
  | { type: "busy"; busy: boolean }
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
  // Un turno que entró por otro canal (WhatsApp…): el navegador no lo mandó, así que hay
  // que pintárselo. Los del propio navegador no se emiten: él ya los tiene.
  | { type: "user"; text: string; images?: PromptImage[]; via: string; from?: string }
  // Una imagen que devolvió una herramienta MCP dentro del turno; se cuelga del mensaje
  // del agente que está en curso.
  | { type: "image"; mimeType: string; data: string }
  | {
      // Una herramienta del agente: tool_call la crea, tool_call_update la
      // avanza. El mismo id llega varias veces; el navegador hace upsert.
      type: "tool";
      id: string;
      title?: string;
      kind?: string;
      status?: string;
      path?: string;
    }
  | { type: "usage"; used: number; size: number; cost: number }
  // Los selectores de la sesión (modelo, modo, nivel de razonamiento…) y si
  // el agente acepta imágenes en el prompt. Se manda al conectar y cada vez
  // que cambian, vengan de aquí o del propio agente.
  | {
      type: "config";
      options: ConfigOption[];
      imageSupport: boolean;
      /** Cuáles de los modelos del selector ven imágenes de verdad. */
      visionModels: string[];
    }
  | { type: "done"; stopReason: string; usage: unknown }
  | { type: "error"; message: string }
  // Por dónde va la conexión, para que la UI no diga "Conectando…" a secas
  // durante los ~15s que tarda despertar una caja dormida.
  | { type: "status"; phase: ConnectPhase }
  | { type: "closed" };


const CONNECT_TIMEOUT_MS = Number(process.env.ACP_CONNECT_TIMEOUT_MS ?? 60_000);
// session/new y session/load esperan a que arranquen las extensiones MCP de la sesión: un
// servidor que no contesta (URL mala, credencial mal puesta) dejaba la petición colgada para
// siempre y con ella cualquier intento de abrir una conversación.
const SESSION_TIMEOUT_MS = Number(process.env.ACP_SESSION_TIMEOUT_MS ?? 60_000);

/** Un fallo con mensaje pensado para el usuario: las rutas lo devuelven tal cual. */
export class AgentError extends Error {}

// ghosty no entrega la respuesta del permiso con claude-acp (`No task waiting for confirmation`)
// y la herramienta se queda colgada para siempre. Hasta que lo arreglen, el hilo se pone en este
// modo al abrirse. Vacío = no tocar el modo del agente.
const ACP_MODE = process.env.ACP_MODE ?? "auto";

/** Lo que un canal externo (WhatsApp…) necesita saber de un turno que él mismo pidió. */
export interface ChannelTurn {
  via: string;
  from?: string;
  onAnswer?: (answer: string, error: string | null, images: PromptImage[]) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: PromptImage[];
  /** Por qué canal entró el turno (`whatsapp`…). Sin valor: el chat web. */
  via?: string;
  /** Quién lo escribió en ese canal, tal como lo enseña el canal. */
  from?: string;
  thought?: string;
  tools?: { id: string; title?: string; kind?: string; status?: string; path?: string }[];
  usage?: { used: number; size: number; cost: number };
  at: number;
}

interface Capabilities {
  loadSession?: boolean;
  sessionCapabilities?: { list?: unknown; close?: unknown };
  promptCapabilities?: { image?: boolean };
}

let connection: ClientConnection | undefined;
let connecting: Promise<ClientConnection> | undefined;
let agentCapabilities: Capabilities = {};
let agentName = "";
let active: GooseSession | undefined;
let lastConfigOptions: ConfigOption[] = [];
let history: ConversationSummary[] = [];
let historyAt = 0;
let historyError: string | null = null;
let refreshing: Promise<void> | undefined;
let transition = Promise.resolve();

// Serializa cambios de hilo, sin bloquear session/cancel detrás de un prompt.
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = transition.then(operation);
  transition = result.then(() => {}, () => {});
  return result;
}

async function connectAgent(): Promise<ClientConnection> {
  if (connection && !connection.signal.aborted) return connection;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!WS_URL) throw new AgentError("Falta ACP_WS_URL en el servidor.");
    await ensureAgentBox();
    const target = new URL(WS_URL);
    if (TOKEN && !target.searchParams.has("token")) target.searchParams.set("token", TOKEN);
    const app = client({ name: "acp-web3" } as any);
    app.onNotification("session/update", ({ params }: any) => {
      if (active && params.sessionId === active.sessionId) active.update(params.update);
    });
    app.onRequest("session/request_permission", ({ params }: any) => {
      if (!active || active.closed || !active.busy || active.cancelling || params.sessionId !== active.sessionId) {
        return { outcome: { outcome: "cancelled" } };
      }
      active.update({ ...params.toolCall, sessionUpdate: "tool_call_update", status: "pending" });
      return active.permissions.request(params.toolCall, params.options ?? []);
    });
    // La caja puede rechazar la conexión (tope de conversaciones, token malo) con un error
    // JSON-RPC de `id: null` y cerrar el socket. El SDK lo descarta ("response to unknown
    // request null") y `initialize` se quedaba colgado hasta el timeout sin decir por qué.
    // Se captura el motivo del socket crudo y se corta la espera en cuanto cierra.
    let rejection = "";
    let socketClosed!: Promise<never>;
    class ObservedWebSocket extends WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        socketClosed = new Promise((_, reject) => {
          this.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.id === null && msg.error?.message) rejection = msg.error.message;
            } catch {}
          });
          this.on("close", () => reject(new AgentError(rejection || "El agente cerró la conexión antes de responder.")));
        });
        socketClosed.catch(() => {});
      }
    }
    const conn = app.connect(createWebSocketStream(target.toString(), {
      WebSocket: ObservedWebSocket, headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
    } as any));
    try {
      const init: any = await withTimeout(
        Promise.race([
          conn.agent.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { configOptions: { boolean: {} } } },
          }),
          socketClosed,
        ]),
        CONNECT_TIMEOUT_MS, "El agente no respondió a tiempo.",
      );
      agentCapabilities = init.agentCapabilities ?? {};
      agentName = init.agentInfo?.name ?? "";
      connection = conn;
      conn.closed.then(() => {
        if (connection !== conn) return;
        connection = undefined;
        if (active && !active.closed) active.disconnected();
      }).catch(() => {});
      return conn;
    } catch (error) {
      conn.close();
      throw error instanceof AgentError ? error : new AgentError("No pude conectar con el agente. Revisa la conexión y la configuración del servidor.");
    }
  })().finally(() => { connecting = undefined; });
  return connecting;
}

class GooseSession extends EventEmitter {
  sessionId: string;
  busy = false;
  cancelling = false;
  configuringExtensions = false;
  ready = false;
  closed = false;
  phase: ConnectPhase = "session";
  lastError: string | null = null;
  cost = 0;
  tokens = 0;
  contextSize = 0;
  title = "Nueva conversación";
  cwd: string;
  configOptions: ConfigOption[] = [];
  imageSupport = false;
  createdAt = Date.now();
  updatedAt = Date.now();
  messages: StoredMessage[] = [];
  permissions = new PermissionQueue(permissions => this.emit("event", { type: "permissions", permissions }));
  private assistant: StoredMessage | undefined;
  private running: Promise<void> | undefined;
  private replaying = false;
  private demoOwner: string | undefined;
  private demoStopped = false;
  replayTail: number | undefined;

  constructor(id: string, cwd: string) { super(); this.sessionId = id; this.cwd = cwd; }

  private setConfigOptions(list: ConfigOption[] | undefined | null) {
    // El provider (claude-acp, openai…) es decisión de quien levanta la caja, no de quien chatea:
    // cambiarlo a media conversación deja al agente sin credenciales. No se ofrece en el selector.
    const options = (list ?? []).filter((o) => o.id !== "provider" && o.category !== "provider");
    if (EXTRA_MODELS.length > 0) {
      const model = options.find((o) => o.category === "model" || o.id === "model");
      const raw = model?.options;
      if (Array.isArray(raw)) {
        // Las opciones vienen planas o agrupadas; sólo se sabe mirando el
        // primer elemento. En agrupadas los extra van a su propio grupo.
        const grouped = raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "group" in (raw[0] as object);
        const known = new Set(
          grouped
            ? (raw as any[]).flatMap((g) => (g.options ?? []).map((v: any) => v.value))
            : (raw as any[]).map((v) => v.value)
        );
        const missing = EXTRA_MODELS.filter((m) => !known.has(m.value));
        if (missing.length > 0) {
          model!.options = grouped
            ? [...(raw as any[]), { group: "extra", name: "Añadidos", options: missing }]
            : [...missing, ...(raw as any[])];
        }
      }
    }
    this.configOptions = options;
    lastConfigOptions = structuredClone(options);
  }


  async initialize(load: boolean, replayTail?: number) {
    const conn = await connectAgent();
    this.imageSupport = agentCapabilities.promptCapabilities?.image === true;
    this.replaying = load;
    this.replayTail = load && replayMetadata(agentName, replayTail)._meta ? replayTail : undefined;
    try {
      const mcpServers = extensionStore().servers();
      console.log(`[acp] mcpServers: ${mcpServers.map(s => s.name).join(", ") || "(ninguno)"}`);
      const response: any = await withTimeout(
        load
          ? conn.agent.request("session/load", { sessionId: this.sessionId, cwd: this.cwd, mcpServers, ...replayMetadata(agentName, replayTail) })
          : conn.agent.request("session/new", { cwd: this.cwd, mcpServers }),
        SESSION_TIMEOUT_MS,
        `El agente no abrió la sesión a tiempo${mcpServers.length ? ` (revisa las extensiones activas: ${mcpServers.map(s => s.name).join(", ")})` : ""}.`,
      );
      if (!load) this.sessionId = response.sessionId;
      this.setConfigOptions(response.configOptions);
      await this.forceMode(conn, response.modes);
      this.ready = true;
      if (load) this.entitle(this.messages.find(m => m.role === "user")?.text ?? "");
      this.emit("event", { type: "started", sessionId: this.sessionId });
      this.emitConfig();
      remember(this);
    } finally { this.replaying = false; this.assistant = undefined; }
  }

  // Ver ACP_MODE: sin `auto`, con claude-acp toda herramienta que pide permiso se cuelga.
  private async forceMode(conn: ClientConnection, modes: { currentModeId?: string; availableModes?: { id: string }[] } | undefined) {
    if (!ACP_MODE || !modes || modes.currentModeId === ACP_MODE) return;
    if (modes.availableModes && !modes.availableModes.some(m => m.id === ACP_MODE)) return;
    try {
      await conn.agent.request("session/set_mode", { sessionId: this.sessionId, modeId: ACP_MODE });
    } catch (error) {
      console.warn(`[acp] no pude poner el modo ${ACP_MODE}:`, (error as Error).message);
    }
  }

  // Si el agente no bautizó el hilo, el primer mensaje del humano hace de título.
  // Un título de verdad del agente (`session_info_update`) siempre lo pisa.
  private entitle(text: string) {
    if (!isGenericTitle(this.title)) return;
    const title = titleStore().get(this.sessionId) || titleFromPrompt(text);
    if (!title) return;
    this.title = title;
    titleStore().set(this.sessionId, title);
    if (!this.replaying) this.emit("event", { type: "title", title });
  }

  private answer() {
    if (!this.assistant) {
      this.assistant = { role: "assistant", text: "", at: Date.now() };
      this.messages.push(this.assistant);
    }
    return this.assistant;
  }

  update(u: any) {
    if (this.closed) return;
    if (this.demoOwner && this.busy && !this.replaying && !this.demoStopped) {
      const text = ["agent_message_chunk", "agent_thought_chunk"].includes(u.sessionUpdate) ? (u.content?.text ?? "") : "";
      // Tool activity has a fixed allowance too, including image generation outside model tokens.
      const charge = estimateTokens(text) + (u.sessionUpdate === "tool_call" ? 1024 : 0);
      if (charge && chargeDemoOutput(this.demoOwner, charge)) this.stopDemo();
    }
    const emit = (event: AcpEvent) => { if (!this.replaying) this.emit("event", event); };
    if (u.sessionUpdate === "user_message_chunk") {
      if (!this.replaying) return;
      // El prompt añade las instrucciones de artifacts como bloque separado.
      // Nunca se muestran esas instrucciones como si las hubiera escrito el humano.
      const content = { ...u.content };
      for (const prefix of [ARTIFACT_INSTRUCTIONS, CHANNEL_INSTRUCTIONS]) {
        if (content.type === "text" && content.text.startsWith(prefix)) {
          content.text = content.text.slice(prefix.length).trimStart();
          if (!content.text) return;
        }
      }
      this.assistant = undefined;
      let message = this.messages.at(-1);
      if (message?.role !== "user") {
        message = { role: "user", text: "", at: Date.now() };
        this.messages.push(message);
      }
      if (content?.type === "text") message.text += content.text;
      if (content?.type === "image") (message.images ??= []).push({ mimeType: content.mimeType, data: content.data });
    } else if (u.sessionUpdate === "agent_message_chunk") {
      const text = u.content?.text ?? "";
      this.answer().text += text;
      emit({ type: "chunk", text });
    } else if (u.sessionUpdate === "agent_thought_chunk") {
      const text = u.content?.text ?? "";
      const answer = this.answer();
      answer.thought = (answer.thought ?? "") + text;
      emit({ type: "thought", text });
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const event: Extract<AcpEvent, { type: "tool" }> = { type: "tool", id: u.toolCallId };
      for (const key of ["title", "kind", "status"] as const) if (u[key] != null) event[key] = u[key];
      if (u.locations?.[0]?.path) event.path = u.locations[0].path;
      const answer = this.answer();
      const tools = answer.tools ??= [];
      const existing = tools.find(t => t.id === event.id);
      if (existing) Object.assign(existing, event); else tools.push(event);
      emit(event);
      // Las imágenes viajan en `content[]` del update. Sólo cuentan las de extensiones (`mcp:`):
      // un `Read` de un PNG también devuelve imagen, pero ésa la leyó el agente, no la produjo.
      const title = existing?.title ?? event.title ?? "";
      if (u.sessionUpdate === "tool_call_update" && Array.isArray(u.content) && /^mcp:/i.test(title)) {
        for (const block of u.content) {
          const content = block?.type === "content" ? block.content : undefined;
          if (content?.type !== "image" || typeof content.data !== "string" || !content.data) continue;
          const image: PromptImage = { mimeType: content.mimeType || "image/png", data: content.data };
          (answer.images ??= []).push(image);
          emit({ type: "image", ...image });
        }
      }
    } else if (u.sessionUpdate === "config_option_update") {
      this.setConfigOptions(u.configOptions);
      if (!this.replaying) this.emitConfig();
    } else if (u.sessionUpdate === "session_info_update") {
      if (typeof u.title === "string" && !isGenericTitle(u.title)) this.title = u.title;
      if (u.updatedAt && Number.isFinite(Date.parse(u.updatedAt))) this.updatedAt = Date.parse(u.updatedAt);
      remember(this);
      emit({ type: "title", title: this.title });
    } else if (u.sessionUpdate === "usage_update") {
      const usage = { used: u.used ?? 0, size: u.size ?? 0, cost: u.cost?.amount ?? 0 };
      this.tokens = usage.used; this.contextSize = usage.size; this.cost = usage.cost;
      if (this.assistant) this.assistant.usage = usage;
      emit({ type: "usage", ...usage });
    }
  }

  configEvent(): AcpEvent {
    const model = this.configOptions.find(o => o.category === "model" || o.id === "model");
    const raw = (model?.options ?? []) as any[];
    const values: string[] = raw.length && "group" in (raw[0] ?? {})
      ? raw.flatMap(g => (g.options ?? []).map((v: any) => v.value)) : raw.map(v => v.value);
    return { type: "config", options: demoEnabled() ? [] : this.configOptions, imageSupport: this.imageSupport, visionModels: values.filter(isVisionModel) };
  }
  emitConfig() { this.emit("event", this.configEvent()); }

  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.ready || this.closed || this.busy) throw new Error("La sesión no está disponible para cambiar la configuración.");
    const response: any = await connection!.agent.request("session/set_config_option", {
      sessionId: this.sessionId, configId, ...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
    });
    this.setConfigOptions(response.configOptions ?? this.configOptions);
    this.emitConfig();
  }

  private stopDemo() {
    if (this.demoStopped) return;
    this.demoStopped = true;
    this.emit("event", { type: "error", message: demoMessage() });
    void this.cancel().catch(() => {});
  }

  /** El turno terminó, con o sin error. Un canal externo espera aquí su respuesta. */
  whenIdle() { return (this.running ?? Promise.resolve()).catch(() => {}); }

  ask(text: string, images: PromptImage[] = [], channel?: ChannelTurn) {
    if (!this.ready || this.closed || this.busy || this.configuringExtensions) return false;
    this.demoOwner = conversationOwner(this.sessionId);
    this.demoStopped = false;
    if (demoEnabled() && !this.demoOwner) throw new Error("Demo conversation has no owner");
    if (this.demoOwner) {
      // Context is billed again on each prompt; include it and a fixed instructions/tool overhead.
      const context = this.messages.reduce((sum, m) => sum + estimateTokens(m.text + (m.thought ?? "")) + (m.images?.length ?? 0) * 2048, 0);
      beginDemoTurn(this.demoOwner, 2048 + context + estimateTokens(text) + images.length * 2048);
    }
    this.busy = true;
    this.cancelling = false;
    this.assistant = undefined;
    const message: StoredMessage = { role: "user", text, images, at: Date.now() };
    if (channel) { message.via = channel.via; if (channel.from) message.from = channel.from; }
    this.messages.push(message);
    this.updatedAt = Date.now();
    if (channel) this.emit("event", { type: "user", text, images, via: channel.via, from: channel.from });
    this.emit("event", { type: "busy", busy: true });
    this.entitle(text);
    remember(this);
    this.running = (async () => {
      let error: string | null = null;
      const demoTimer = this.demoOwner ? setTimeout(() => this.stopDemo(), 120_000) : undefined;
      try {
        const result: any = await connection!.agent.request("session/prompt", {
          sessionId: this.sessionId,
          // Por un canal de mensajería no hay panel de artifacts: se le dice otra cosa al agente.
          prompt: [{ type: "text", text: channel ? CHANNEL_INSTRUCTIONS : ARTIFACT_INSTRUCTIONS }, { type: "text", text }, ...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
        });
        this.emit("event", { type: "done", stopReason: result.stopReason, usage: this.assistant?.usage ?? null });
        if (result.stopReason === "cancelled") error = "El turno se detuvo antes de terminar.";
      } catch {
        error = "La respuesta se interrumpió. Abre el hilo de nuevo para recuperar lo que guardó el agente.";
        this.emit("event", { type: "error", message: error });
      } finally {
        clearTimeout(demoTimer);
        // El canal se entera antes de que se suelte `busy`, con el mensaje del agente entero.
        try { channel?.onAnswer?.((this.assistant?.text ?? "") + (this.demoStopped ? `\n\n${demoMessage()}` : ""), error, this.assistant?.images ?? []); } catch {}
        this.permissions.cancel();
        this.busy = false;
        this.assistant = undefined;
        this.updatedAt = Date.now();
        remember(this);
        historyAt = 0;
        this.emit("event", { type: "busy", busy: false });
      }
    })();
    return true;
  }

  async cancel() {
    this.cancelling = true;
    this.permissions.cancel();
    if (this.busy && connection) await connection.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  disconnected() {
    this.permissions.cancel();
    this.closed = true; this.ready = false; this.busy = false;
    this.emit("event", { type: "closed" });
  }

  async close() {
    if (this.closed) return;
    if (this.busy) {
      await this.cancel();
      // Un agente que ignora cancel no debe bloquear para siempre el cambio de hilo.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("El agente no confirmó la cancelación.")), 10_000); })]);
      } finally { clearTimeout(timer); }
    }
    if (agentCapabilities.sessionCapabilities?.close != null && connection) {
      await connection.agent.request("session/close", { sessionId: this.sessionId });
    } else {
      const conn = connection; connection = undefined; conn?.close();
    }
    remember(this);
    this.disconnected();
  }
}

export interface ConversationSummary {
  id: string; title: string; cwd: string; createdAt: number; updatedAt: number;
  messageCount: number; tokens: number; contextSize: number; cost: number;
  busy: boolean; closed: boolean; canOpen: boolean;
}

function summarize(s: GooseSession): ConversationSummary {
  return { id: s.sessionId, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt,
    messageCount: s.messages.length, tokens: s.tokens, contextSize: s.contextSize, cost: s.cost,
    busy: s.busy, closed: s.closed, canOpen: !s.closed || !!agentCapabilities.loadSession };
}
function remember(s: GooseSession) {
  const row = summarize(s);
  history = [row, ...history.filter(c => c.id !== row.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getHistorySnapshot() {
  const conversations = history.map(c => ({ ...c,
    busy: active?.sessionId === c.id && !active.closed ? active.busy : false,
    canOpen: !!agentCapabilities.loadSession || (active?.sessionId === c.id && !active.closed),
  }));
  return { conversations, error: historyError, loaded: historyAt > 0, persistent: !!agentCapabilities.sessionCapabilities?.list };
}

export async function listConversations() {
  if (Date.now() - historyAt < 10_000) return getHistorySnapshot();
  if (!refreshing) refreshing = (async () => {
    try {
      const conn = await connectAgent();
      if (agentCapabilities.sessionCapabilities?.list == null) {
        history = active && !active.closed ? [summarize(active)] : [];
      } else {
        const rows: ConversationSummary[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page: any = await conn.agent.request("session/list", { ...(cursor ? { cursor } : {}) });
          for (const session of page.sessions ?? []) {
            const old = history.find(c => c.id === session.sessionId);
            const updatedAt = Date.parse(session.updatedAt) || old?.updatedAt || 0;
            const title = [session.title, titleStore().get(session.sessionId), old?.title].find(t => !isGenericTitle(t)) || "Nueva conversación";
            rows.push({ id: session.sessionId, title, cwd: session.cwd || CWD,
              createdAt: old?.createdAt ?? updatedAt, updatedAt, messageCount: session._meta?.messageCount ?? old?.messageCount ?? 0,
              tokens: old?.tokens ?? 0, contextSize: old?.contextSize ?? 0, cost: old?.cost ?? 0, busy: false, closed: true, canOpen: !!agentCapabilities.loadSession });
          }
          cursor = page.nextCursor || undefined;
          if (cursor && seen.has(cursor)) throw new Error("Repeated session list cursor");
          if (cursor) seen.add(cursor);
        } while (cursor);
        history = [...new Map(rows.map(row => [row.id, row])).values()];
        if (active && !active.closed) remember(active);
      }
      history.sort((a, b) => b.updatedAt - a.updatedAt);
      historyError = null;
      historyAt = Date.now();
    } catch {
      historyError = "No pude actualizar el historial. Se muestra la última lista disponible.";
    }
  })().finally(() => { refreshing = undefined; });
  await refreshing;
  return getHistorySnapshot();
}

export function createConversation(model?: string | null) {
  return exclusive(async () => {
    if (demoEnabled() && active?.busy) throw new Response("El agente está atendiendo otra demo. Inténtalo en un momento.", { status: 409 });
    await active?.close();
    await connectAgent();
    const session = new GooseSession("nuevo", CWD);
    active = session;
    try { await session.initialize(false); } catch (error) {
      const conn = connection; connection = undefined; conn?.close();
      session.disconnected(); throw error;
    }
    if (model) {
      const option = session.configOptions.find(option => option.category === "model" || option.id === "model");
      if (option) {
        try { await session.setConfigOption(option.id, model); } catch { /* Catálogo cambiado: conserva el modelo confirmado por el agente. */ }
      }
    }
    historyAt = 0;
    markActivity();
    return session.sessionId;
  });
}

export function loadConversation(id: string, options: { replayTail?: number; reload?: boolean } = {}) {
  return exclusive(async () => {
    if (active?.sessionId === id && !active.closed && !options.reload && active.replayTail === (replayMetadata(agentName, options.replayTail)._meta ? options.replayTail : undefined)) { markActivity(); return active; }
    if (demoEnabled() && active?.busy && active.sessionId !== id) throw new Response("El agente está atendiendo otra demo. Inténtalo en un momento.", { status: 409 });
    await connectAgent();
    if (!agentCapabilities.loadSession) throw new Response("El agente no permite reabrir conversaciones guardadas.", { status: 409 });
    await active?.close();
    await connectAgent();
    if (!history.some(c => c.id === id)) await listConversations();
    const row = history.find(c => c.id === id);
    const session = new GooseSession(id, row?.cwd ?? CWD);
    if (row) { session.title = row.title; session.createdAt = row.createdAt; session.updatedAt = row.updatedAt; }
    active = session;
    try { await session.initialize(true, options.replayTail); } catch (error) {
      // load puede haber reservado una ranura antes de fallar.
      const conn = connection; connection = undefined; conn?.close();
      session.disconnected();
      throw new Response("No pude recuperar esta conversación del agente.", { status: 502 });
    }
    markActivity();
    return session;
  });
}
export function getConversation(id: string) { return active?.sessionId === id && !active.closed ? active : null; }
export function getMessages(id: string): StoredMessage[] { return getConversation(id)?.messages ?? []; }
export function closeConversation(id: string) { return exclusive(async () => { const s = getConversation(id); if (!s) return false; await s.close(); return true; }); }
export function askConversation(id: string, text: string, images: PromptImage[] = []) {
  const s = getConversation(id); if (!s) return false; markActivity(); return s.ask(text, images);
}
/**
 * Un turno pedido desde fuera del navegador (WhatsApp…). Va al hilo abierto, o abre uno si no
 * lo hay: una sola sesión viva, dos clientes, una conversación. Los canales se turnan: si el
 * agente está contestando (al chat web o a otro grupo), el siguiente espera a que acabe.
 * Resuelve con el texto entero del agente y las imágenes que devolvieron sus herramientas.
 */
let channelQueue = Promise.resolve();
export function askFromChannel(text: string, via: string, from?: string, images: PromptImage[] = [], owner?: string) {
  const turn = channelQueue.then(async (): Promise<{ text: string; images: PromptImage[] }> => {
    if (demoEnabled() && !owner) throw new AgentError("Falta el dueño del canal de demo.");
    let session: GooseSession | undefined;
    if (owner) {
      const id = await demoConversation(owner, () => createConversation());
      session = await loadConversation(id);
    } else { session = active && !active.closed && active.ready ? active : undefined; }
    if (!session) { await createConversation(); session = active; }
    if (!session || session.closed) throw new AgentError("No hay un hilo abierto con el agente.");
    // Cola simple: espera a que suelte el turno en curso y, si otro se coló, reintenta.
    for (let attempt = 0; attempt < 20; attempt++) {
      await session.whenIdle();
      while (session.configuringExtensions) await new Promise(r => setTimeout(r, 250));
      if (session.closed) throw new AgentError("El hilo se cerró mientras esperaba el turno.");
      const answer = new Promise<{ text: string; images: PromptImage[] }>((resolve, reject) => {
        const ok = session!.ask(text, images, {
          via, from,
          onAnswer: (answer, error, images) => error && !answer ? reject(new AgentError(error)) : resolve({ text: answer, images }),
        });
        if (!ok) reject(new Error("busy"));
      });
      try { markActivity(); return await answer; }
      catch (error) {
        if ((error as Error).message === "busy") continue;
        // La caja se durmió y el WebSocket cayó con el turno dentro: el hilo quedó cerrado.
        // Se reabre uno (eso despierta la caja) y se reintenta una sola vez.
        if (!owner && session.closed && attempt === 0) {
          await createConversation();
          session = active;
          if (!session || session.closed) throw error;
          continue;
        }
        throw error;
      }
    }
    throw new AgentError("El agente no se desocupó a tiempo.");
  });
  channelQueue = turn.then(() => {}, () => {});
  return turn;
}
export async function setConversationConfig(id: string, configId: string, value: string | boolean) {
  const s = getConversation(id); if (!s) return false; await s.setConfigOption(configId, value); markActivity(); return true;
}
export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = getConversation(id); if (!s) return null;
  s.on("event", onEvent);
  // Snapshot atómico al suscribir: cubre los tokens entre loader y SSE, y reconexiones.
  onEvent({ type: "snapshot", messages: s.messages, busy: s.busy, permissions: s.permissions.snapshot() });
  onEvent({ type: "started", sessionId: s.sessionId });
  onEvent(s.configEvent());
  onEvent({ type: "busy", busy: s.busy });
  return () => s.off("event", onEvent);
}
export function getLastConfigOptions() { return lastConfigOptions; }
// La URL visible nunca incluye credenciales del agente.
const publicWsUrl = (() => { try { const url = new URL(WS_URL); url.search = ""; url.username = ""; url.password = ""; return url.toString(); } catch { return ""; } })();
export const config = { wsUrl: publicWsUrl, cwd: CWD, agentBox: AGENT_BOX, idleMs: IDLE_MS };
let lastActivity = Date.now();
let activeSse = 0;
export const markActivity = () => (lastActivity = Date.now());
export const openSse = () => { activeSse++; markActivity(); };
export const closeSse = () => { activeSse = Math.max(0, activeSse - 1); };
setInterval(() => {
  if (activeSse === 0 && !active?.busy && Date.now() - lastActivity > IDLE_MS) {
    lastActivity = Date.now();
    void exclusive(async () => {
      if (activeSse || active?.busy) return;
      await active?.close();
      const conn = connection; connection = undefined; conn?.close();
      await suspendAgentBox();
    }).catch(() => {});
  }
}, 30_000).unref?.();

/** No abre una sesión para descubrir skills. Agentes sin la extensión degradan a vacío. */
export async function listAgentSkills() {
  try {
    const conn = await connectAgent();
    const result = await conn.agent.request("_goose/unstable/sources/list", { projectDir: CWD });
    return { skills: parseSkills(result), supported: true, error: null };
  } catch (error) {
    if ((error as { code?: number }).code === -32601) return { skills: [], supported: false, error: null };
    return { skills: [], supported: true, error: "No pude cargar las habilidades. Inténtalo de nuevo." };
  }
}

export async function listClientExtensions() {
  try {
    return { extensions: summarizeExtensions({ extensions: extensionStore().list() }), error: null };
  } catch {
    return { extensions: [], error: "No pude leer las extensiones guardadas en este cliente." };
  }
}

export async function listSessionExtensions() {
  const session = active;
  if (!session || session.closed || !session.ready) return null;
  try {
    const conn = await connectAgent();
    // goose devuelve cada extensión de la sesión plana (sin envoltorio ni clave): se identifica
    // por su nombre, que es también lo que pide `extensions/remove` (`name`, no `extensionKey`).
    // Se acepta también la forma envuelta `{ extensionKey, extension }` por si cambia.
    type SessionExtension = { name?: string; server?: { name?: string } };
    const response = await conn.agent.request("_goose/unstable/session/extensions/list", { sessionId: session.sessionId }) as {
      extensions: (SessionExtension & { extensionKey?: string; extension?: SessionExtension })[];
    };
    const extensions = summarizeExtensions({ extensions: response.extensions.map(entry => {
      const extension = entry.extension ?? entry;
      return { configKey: entry.extensionKey ?? extension.server?.name ?? extension.name ?? null, enabled: true, extension };
    }) });
    return { id: session.sessionId, title: session.title, busy: session.busy || session.configuringExtensions, extensions, error: null };
  } catch (error) {
    return { id: session.sessionId, title: session.title, busy: session.busy, extensions: [],
      error: (error as { code?: number }).code === -32601 ? "El agente no permite gestionar extensiones de esta conversación." : "No pude consultar las herramientas de la conversación." };
  }
}

export function changeSessionExtension(id: string, operation: "add" | "remove", key: string) {
  return exclusive(async () => {
    const session = getConversation(id);
    if (!session || !session.ready) throw new Response("La conversación activa cambió. Actualiza la página.", { status: 409 });
    if (session.busy) throw new Response("Espera a que termine el turno o detenlo antes de cambiar herramientas.", { status: 409 });
    session.configuringExtensions = true;
    try {
      const conn = await connectAgent();
      if (operation === "add") {
        const extension = extensionStore().get(key);
        if (!extension) throw new Response("La extensión ya no existe", { status: 404 });
        await conn.agent.request("_goose/unstable/session/extensions/add", { sessionId: id, extension });
      } else {
        // goose quita por nombre; el navegador puede mandar el id del cliente (UUID) o el nombre.
        const name = extensionStore().get(key)?.server.name ?? key;
        await conn.agent.request("_goose/unstable/session/extensions/remove", { sessionId: id, name });
      }
      markActivity();
    } finally { session.configuringExtensions = false; }
  });
}
