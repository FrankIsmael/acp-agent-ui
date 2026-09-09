/**
 * Motor ACP del lado servidor — portado de web/server.mjs (SPEC-2).
 *
 * Una conexión ACP compartida; el agente conserva las conversaciones en la
 * caja de EasyBits. El navegador nunca habla ACP: consume los eventos por SSE.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { client, type ClientConnection } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import type { ConnectPhase } from "~/hooks/useAcpStream";
import { parseSkills, replayMetadata } from "./goose-adapter";
import { ARTIFACT_INSTRUCTIONS } from "./artifact-instructions";

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

const isVisionModel = (id: string) =>
  VISION_MODELS.length > 0
    ? VISION_MODELS.includes(id)
    : /vision|-vl\b|-vl-/i.test(id);

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
    throw new Error(
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
  | { type: "snapshot"; messages: StoredMessage[]; busy: boolean }
  | { type: "title"; title: string }
  | { type: "started"; sessionId: string }
  | { type: "busy"; busy: boolean }
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
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

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: PromptImage[];
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
    if (!WS_URL) throw new Error("Falta ACP_WS_URL en el servidor.");
    await ensureAgentBox();
    const target = new URL(WS_URL);
    if (TOKEN && !target.searchParams.has("token")) target.searchParams.set("token", TOKEN);
    const app = client({ name: "acp-web3" } as any);
    app.onNotification("session/update", ({ params }: any) => {
      if (active && params.sessionId === active.sessionId) active.update(params.update);
    });
    app.onRequest("session/request_permission", ({ params }: any) => {
      const allow = (params.options ?? []).find((o: any) => o.kind === "allow_once");
      return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
    });
    const conn = app.connect(createWebSocketStream(target.toString(), {
      WebSocket, headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
    } as any));
    let timer: NodeJS.Timeout | undefined;
    try {
      const init: any = await Promise.race([
        conn.agent.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { configOptions: { boolean: {} } } },
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("El agente no respondió a tiempo.")), CONNECT_TIMEOUT_MS); }),
      ]);
      agentCapabilities = init.agentCapabilities ?? {};
      agentName = init.agentInfo?.name ?? "";
      connection = conn;
      conn.closed.then(() => {
        if (connection !== conn) return;
        connection = undefined;
        if (active && !active.closed) active.disconnected();
      }).catch(() => {});
      return conn;
    } catch {
      conn.close();
      throw new Error("No pude conectar con el agente. Revisa la conexión y la configuración del servidor.");
    } finally { clearTimeout(timer); }
  })().finally(() => { connecting = undefined; });
  return connecting;
}

class GooseSession extends EventEmitter {
  sessionId: string;
  busy = false;
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
  private assistant: StoredMessage | undefined;
  private running: Promise<void> | undefined;
  private replaying = false;
  replayTail: number | undefined;

  constructor(id: string, cwd: string) { super(); this.sessionId = id; this.cwd = cwd; }

  private setConfigOptions(list: ConfigOption[] | undefined | null) {
    const options = list ?? [];
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
      const response: any = load
        ? await conn.agent.request("session/load", { sessionId: this.sessionId, cwd: this.cwd, mcpServers: [], ...replayMetadata(agentName, replayTail) })
        : await conn.agent.request("session/new", { cwd: this.cwd, mcpServers: [] });
      if (!load) this.sessionId = response.sessionId;
      this.setConfigOptions(response.configOptions);
      this.ready = true;
      this.emit("event", { type: "started", sessionId: this.sessionId });
      this.emitConfig();
      remember(this);
    } finally { this.replaying = false; this.assistant = undefined; }
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
    const emit = (event: AcpEvent) => { if (!this.replaying) this.emit("event", event); };
    if (u.sessionUpdate === "user_message_chunk") {
      if (!this.replaying) return;
      // El prompt añade las instrucciones de artifacts como bloque separado.
      // Nunca se muestran esas instrucciones como si las hubiera escrito el humano.
      const content = { ...u.content };
      if (content.type === "text" && content.text.startsWith(ARTIFACT_INSTRUCTIONS)) {
        content.text = content.text.slice(ARTIFACT_INSTRUCTIONS.length).trimStart();
        if (!content.text) return;
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
      const tools = this.answer().tools ??= [];
      const existing = tools.find(t => t.id === event.id);
      if (existing) Object.assign(existing, event); else tools.push(event);
      emit(event);
    } else if (u.sessionUpdate === "config_option_update") {
      this.setConfigOptions(u.configOptions);
      if (!this.replaying) this.emitConfig();
    } else if (u.sessionUpdate === "session_info_update") {
      if (typeof u.title === "string" && u.title.trim()) this.title = u.title;
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
    return { type: "config", options: this.configOptions, imageSupport: this.imageSupport, visionModels: values.filter(isVisionModel) };
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

  ask(text: string, images: PromptImage[] = []) {
    if (!this.ready || this.closed || this.busy) return false;
    this.busy = true;
    this.assistant = undefined;
    this.messages.push({ role: "user", text, images, at: Date.now() });
    this.updatedAt = Date.now();
    this.emit("event", { type: "busy", busy: true });
    remember(this);
    this.running = (async () => {
      try {
        const result: any = await connection!.agent.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: ARTIFACT_INSTRUCTIONS }, { type: "text", text }, ...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))],
        });
        this.emit("event", { type: "done", stopReason: result.stopReason, usage: this.assistant?.usage ?? null });
      } catch {
        this.emit("event", { type: "error", message: "La respuesta se interrumpió. Abre el hilo de nuevo para recuperar lo que guardó el agente." });
      } finally {
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
    if (this.busy && connection) await connection.agent.notify("session/cancel", { sessionId: this.sessionId });
  }

  disconnected() {
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
            rows.push({ id: session.sessionId, title: session.title || old?.title || "Nueva conversación", cwd: session.cwd || CWD,
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
export async function setConversationConfig(id: string, configId: string, value: string | boolean) {
  const s = getConversation(id); if (!s) return false; await s.setConfigOption(configId, value); markActivity(); return true;
}
export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = getConversation(id); if (!s) return null;
  s.on("event", onEvent);
  // Snapshot atómico al suscribir: cubre los tokens entre loader y SSE, y reconexiones.
  onEvent({ type: "snapshot", messages: s.messages, busy: s.busy });
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
