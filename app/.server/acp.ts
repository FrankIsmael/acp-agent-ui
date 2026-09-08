/**
 * Motor ACP del lado servidor — portado de web/server.mjs (SPEC-2).
 *
 * Una conversación = una conexión ACP contra el goose que corre dentro de la
 * caja de EasyBits. El navegador nunca habla ACP: consume los eventos por SSE.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { client, type ClientConnection } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import type { ConnectPhase } from "~/hooks/useAcpStream";
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
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS ?? 10);

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


// Un handshake que no responde no debe dejar la UI esperando para siempre:
// un 401 del WSS (secret ausente) o una caja que no contesta se ven así.
const CONNECT_TIMEOUT_MS = Number(process.env.ACP_CONNECT_TIMEOUT_MS ?? 60_000);

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: PromptImage[];
  at: number;
}

/** Lo que espera en la cola: el texto y sus adjuntos, juntos. */
interface QueuedTurn {
  text: string;
  images: PromptImage[];
}

// ---------------------------------------------------------------------------
// GooseSession — una conexión ACP por conversación.
// ---------------------------------------------------------------------------
class GooseSession extends EventEmitter {
  sessionId: string | null = null;
  busy = false;
  ready = false;
  closed = false;
  phase: ConnectPhase = "waking";
  lastError: string | null = null;
  cost = 0;
  tokens = 0;
  contextSize = 0;
  title = "Nueva conversación";
  // Los selectores que expone el agente y si acepta imágenes. Ambos se saben
  // hasta el handshake: antes de eso la UI no pinta ni el clip ni el select.
  configOptions: ConfigOption[] = [];
  imageSupport = false;
  createdAt = Date.now();
  updatedAt = Date.now();
  messages: StoredMessage[] = [];

  private conn: ClientConnection | undefined;
  private session: any = null;
  private queue: QueuedTurn[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private current: string | null = null;

  constructor(
    private wsUrl: string,
    private secret: string,
    private cwd: string
  ) {
    super();
  }

  /**
   * Guarda los selectores del agente y les añade los modelos extra. Pasa por
   * aquí TODO cambio de configOptions —sesión nueva, respuesta a un cambio,
   * aviso del agente— porque cada uno trae la lista completa y volvería a
   * perder lo añadido.
   */
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
  }

  private resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  private setPhase(phase: ConnectPhase) {
    this.phase = phase;
    this.emit("event", { type: "status", phase });
  }

  async connect() {
    try {
      // Sin URL no se intenta nada: el error dice qué falta, en vez de dejar al usuario
      // mirando un spinner y luego un timeout genérico.
      if (!this.wsUrl) {
        throw new Error(
          "Falta ACP_WS_URL. Es el `agentUrl` del agente (wss://…/acp); ponlo en el .env."
        );
      }
      this.setPhase("waking");
      // El fallo de ciclo de vida SÍ se cuenta: antes iba sólo a console.warn y la UI pintaba
      // "Despertando la caja" en verde aunque no se hubiera despertado nada, así que el
      // siguiente error parecía venir de otro sitio.
      await ensureAgentBox().catch((e) => {
        console.warn("[lifecycle] ensureAgentBox:", e.message);
        this.emit("event", {
          type: "warning",
          message: `No pude despertar la caja (${e.message}). Sigo: puede que ya esté arriba.`,
        });
      });
      this.setPhase("connecting");
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `El agente no respondió en ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s. Revisa que el agente esté vivo y que ACP_WS_URL sea el suyo.`
              )
            ),
          CONNECT_TIMEOUT_MS
        );
        timer.unref?.();
      });
      await Promise.race([this.handshake(), timeout]);
      if (timer) clearTimeout(timer);
    } catch (e) {
      const raw = (e as Error).message;
      // "Unexpected server response: 401" no le dice nada a quien lo ve.
      this.lastError = /\b401\b/.test(raw)
        ? "El agente rechazó la conexión (401): el token no es el suyo. Es el `embedToken` que devolvió al crearlo — salvo que le hayas puesto un `ACP_AGENT_TOKEN` propio en el `env`, y entonces es ése."
        : /\b(404|502|503)\b/.test(raw)
          ? `Esa URL no está sirviendo un agente (${raw}). Comprueba ACP_WS_URL: la da el propio agente en su campo agentUrl.`
          : raw;
      this.emit("event", { type: "error", message: this.lastError });
    }
  }

  private async handshake() {
    // El token va por las DOS vías que acepta un agente ACP, y por eso funciona con cualquiera:
    //   · `?token=` en la URL — lo único que todo cliente sabe pasar (un WebSocket de navegador
    //     no puede poner cabeceras), y lo que espera ghosty-lite.
    //   · `Authorization: Bearer` — lo correcto cuando el cliente es Node, como éste.
    // Antes iba por `X-Secret-Key`, que el front de la caja DESCARTA: 401 garantizado, con un
    // mensaje que además culpaba al secreto interno de goose. Medido: ?token= → 200,
    // X-Secret-Key con el mismo valor → 401.
    // Si la URL ya trae el token, se respeta: quien la copió entera del panel no se queda fuera.
    const target = new URL(this.wsUrl);
    if (this.secret && !target.searchParams.has("token")) {
      target.searchParams.set("token", this.secret);
    }
    const headers = this.secret ? { Authorization: `Bearer ${this.secret}` } : undefined;
    const stream = createWebSocketStream(target.toString(), { WebSocket, headers } as any);

    // El handler de permisos se registra ANTES de conectar.
    const app = client({ name: "acp-web3" } as any);
    app.onRequest("session/request_permission", ({ params }: any) => {
      const options = params.options ?? [];
      const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
      const optionId = allow?.optionId ?? options[0]?.optionId;
      // Se auto-aprueba (tema de la sesión 4), pero la petición se enseña.
      this.emit("event", {
        type: "tool",
        id: params.toolCall?.toolCallId ?? "?",
        title: params.toolCall?.title ?? "herramienta",
        status: "pending",
      });
      return { outcome: { outcome: "selected", optionId } };
    });

    this.conn = app.connect(stream);
    const ctx = this.conn.agent;

    // ACP no tiene un método "elige modelo". Lo que tiene es `configOptions`:
    // el agente declara en `session/new` una lista de selectores —modelo, modo,
    // nivel de razonamiento— cada uno con sus valores y el actual, y el cliente
    // cambia uno con `session/set_config_option`. El de modelo se reconoce por
    // `category: "model"`, que es sólo una pista de UX: el protocolo no fija
    // qué modelos hay ni cómo se llaman, eso lo pone cada agente.
    //
    // El agente sólo manda `configOptions` si el cliente los pide aquí. Sin
    // esta capacidad el select no aparece nunca, y parece que el agente no
    // soporta cambiar de modelo cuando en realidad nadie se lo preguntó.
    const init: any = await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Sin terminal del lado del cliente: el agente corre el shell en su
        // propia caja. Con true, goose pide terminal/create y, como no lo
        // implementamos, cada shell termina en failed.
        terminal: false,
        session: { configOptions: { boolean: {} } },
      },
    });
    // Las imágenes también se piden: `promptCapabilities.image` dice si el
    // agente acepta bloques `image` en el prompt. Mandárselas a uno que no
    // puede es un error del turno entero, así que la UI esconde el clip.
    this.imageSupport = init?.agentCapabilities?.promptCapabilities?.image === true;
    this.setPhase("session");
    this.session = await ctx.buildSession({ cwd: this.cwd, mcpServers: [] }).start();
    this.sessionId = this.session.sessionId;
    this.setConfigOptions(this.session.newSessionResponse?.configOptions);
    this.ready = true;
    this.emit("event", { type: "started", sessionId: this.sessionId });
    this.emitConfig();
    this.resetIdle();
    this.pump();
  }

  /** El evento tal cual, para emitirlo o para repetírselo a uno solo. */
  configEvent(): AcpEvent {
    const model = this.configOptions.find((o) => o.category === "model" || o.id === "model");
    const raw = (model?.options ?? []) as any[];
    const values: string[] = raw.length > 0 && "group" in (raw[0] ?? {})
      ? raw.flatMap((g) => (g.options ?? []).map((v: any) => v.value))
      : raw.map((v) => v.value);
    return {
      type: "config",
      options: this.configOptions,
      imageSupport: this.imageSupport,
      visionModels: values.filter(isVisionModel),
    };
  }

  emitConfig() {
    this.emit("event", this.configEvent());
  }

  /**
   * Cambia un selector de la sesión (el modelo, por ejemplo). La respuesta trae
   * la lista COMPLETA ya actualizada —no sólo el que tocamos—, porque cambiar
   * uno puede mover otros: elegir un modelo sin razonamiento puede hacer
   * desaparecer el selector de nivel de razonamiento.
   */
  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.ready || !this.session) {
      throw new Error("La sesión todavía no está lista");
    }
    const res: any = await this.conn?.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      // El `type` sólo viaja para los booleanos; ausente significa "id de valor",
      // que es lo que usan los selects.
      ...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
    });
    this.setConfigOptions(res?.configOptions ?? this.configOptions);
    this.emitConfig();
    this.resetIdle();
  }

  ask(text: string, images: PromptImage[] = []) {
    if (this.closed) return;
    this.resetIdle();
    this.messages.push({ role: "user", text, images, at: Date.now() });
    if (this.messages.length === 1) this.title = text.slice(0, 60);
    this.updatedAt = Date.now();
    this.queue.push({ text, images });
    this.pump();
  }

  async cancel() {
    this.queue = [];
    if (this.busy && this.conn && this.sessionId) {
      await this.conn.agent.notify("session/cancel", { sessionId: this.sessionId });
    } else {
      this.emit("event", { type: "done", stopReason: "cancelled", usage: null });
    }
  }

  private pump() {
    if (!this.ready || this.busy || this.queue.length === 0) return;
    this.busy = true;
    this.emit("event", { type: "busy", busy: true });
    const turn = this.queue.shift()!;
    let turnUsage: unknown = null;
    let answer = "";

    (async () => {
      // El prompt deja de ser una cadena en cuanto hay adjuntos: ACP manda una
      // lista de bloques, y las imágenes van como `image` con el base64 crudo
      // (sin el `data:…;base64,` del navegador) más su mimeType.
      const content: any[] = [
        { type: "text", text: ARTIFACT_INSTRUCTIONS },
        { type: "text", text: turn.text },
      ];
      for (const img of turn.images) {
        content.push({ type: "image", mimeType: img.mimeType, data: img.data });
      }
      const promptP = this.session.prompt(content);
      while (true) {
        const m = await this.session.nextUpdate();
        if (m.kind === "stop") break;
        if (m.kind !== "session_update") continue;
        const u = m.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk") {
          const t = u.content?.text ?? "";
          if (t) {
            answer += t;
            this.emit("event", { type: "chunk", text: t });
          }
        } else if (u.sessionUpdate === "agent_thought_chunk") {
          const t = u.content?.text ?? "";
          if (t) this.emit("event", { type: "thought", text: t });
        } else if (
          u.sessionUpdate === "tool_call" ||
          u.sessionUpdate === "tool_call_update"
        ) {
          // En el update sólo viajan los campos que cambiaron; los null se omiten.
          const ev: AcpEvent = { type: "tool", id: u.toolCallId };
          if (u.title) ev.title = u.title;
          if (u.kind) ev.kind = u.kind;
          if (u.status) ev.status = u.status;
          const path = u.locations?.[0]?.path;
          if (path) ev.path = path;
          this.emit("event", ev);
        } else if (u.sessionUpdate === "config_option_update") {
          // El agente también los cambia por su cuenta (un `/model` escrito en
          // el chat, por ejemplo); el select tiene que seguirlo.
          this.setConfigOptions(u.configOptions ?? this.configOptions);
          this.emitConfig();
        } else if (u.sessionUpdate === "usage_update") {
          const used = u.used ?? 0;
          const size = u.size ?? 0;
          const cost = u.cost?.amount ?? 0;
          this.tokens = used;
          this.contextSize = size;
          this.cost += cost;
          turnUsage = { used, size, cost };
          this.emit("event", { type: "usage", used, size, cost });
        }
      }
      const r = await promptP;
      this.messages.push({ role: "assistant", text: answer, at: Date.now() });
      this.updatedAt = Date.now();
      this.emit("event", { type: "done", stopReason: r.stopReason, usage: turnUsage });
    })()
      .catch((e) => this.emit("event", { type: "error", message: e.message }))
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      this.session?.dispose();
    } catch {}
    try {
      this.conn?.close?.();
    } catch {}
    this.emit("event", { type: "closed" });
  }
}

// ---------------------------------------------------------------------------
// Registro de conversaciones. Vive en el módulo, así que sobrevive entre
// peticiones — pero no entre reinicios del server (el POC no persiste).
// ---------------------------------------------------------------------------
const conversations = new Map<string, GooseSession>();

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens: number;
  contextSize: number;
  cost: number;
  busy: boolean;
  closed: boolean;
}

const summarize = (id: string, s: GooseSession): ConversationSummary => ({
  id,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  messageCount: s.messages.length,
  tokens: s.tokens,
  contextSize: s.contextSize,
  cost: s.cost,
  busy: s.busy,
  closed: s.closed,
});

export async function createConversation() {
  if (conversations.size >= MAX_CONVERSATIONS) {
    throw new Error("too many conversations");
  }
  // La caja se despierta DENTRO de connect(): así el navegador aterriza en la
  // conversación al instante y ve las fases, en vez de esperar el POST a ciegas.
  const id = randomUUID();
  const s = new GooseSession(WS_URL, TOKEN, CWD);
  void s.connect();
  conversations.set(id, s);
  s.on("event", (e: AcpEvent) => {
    if (e.type === "closed" && conversations.get(id) === s) conversations.delete(id);
  });
  return id;
}

export function getConversation(id: string) {
  return conversations.get(id) ?? null;
}

export function listConversations(): ConversationSummary[] {
  return [...conversations.entries()]
    .map(([id, s]) => summarize(id, s))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMessages(id: string): StoredMessage[] {
  return conversations.get(id)?.messages ?? [];
}

export function closeConversation(id: string) {
  const s = conversations.get(id);
  if (!s) return false;
  s.close();
  conversations.delete(id);
  return true;
}

export function askConversation(id: string, text: string, images: PromptImage[] = []) {
  const s = conversations.get(id);
  if (!s) return false;
  s.ask(text, images);
  markActivity();
  return true;
}

export async function setConversationConfig(
  id: string,
  configId: string,
  value: string | boolean
) {
  const s = conversations.get(id);
  if (!s) return false;
  await s.setConfigOption(configId, value);
  markActivity();
  return true;
}

/** Suscribe a los eventos de una conversación; devuelve la baja. */
export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = conversations.get(id);
  if (!s) return null;
  const handler = (e: AcpEvent) => onEvent(e);
  s.on("event", handler);
  // Quien llega tarde (recarga, segunda pestaña) no vio el started original:
  // se le repite para que el input no se quede en "Conectando…".
  if (s.ready && s.sessionId && !s.closed) {
    onEvent({ type: "started", sessionId: s.sessionId });
    onEvent(s.configEvent());
    onEvent({ type: "busy", busy: s.busy });
  } else if (!s.closed) {
    onEvent({ type: "status", phase: s.phase });
    if (s.lastError) onEvent({ type: "error", message: s.lastError });
  }
  return () => s.off("event", handler);
}

export const config = { wsUrl: WS_URL, cwd: CWD, agentBox: AGENT_BOX, idleMs: IDLE_MS };

// ---------------------------------------------------------------------------
// Suspend al idle: sin sockets SSE ni turnos en vuelo durante IDLE_MS.
// ---------------------------------------------------------------------------
let lastActivity = Date.now();
let activeSse = 0;
export const markActivity = () => (lastActivity = Date.now());
export const openSse = () => {
  activeSse++;
  markActivity();
};
export const closeSse = () => {
  activeSse = Math.max(0, activeSse - 1);
};

setInterval(() => {
  const busy = [...conversations.values()].some((s) => s.busy);
  if (activeSse === 0 && !busy && Date.now() - lastActivity > IDLE_MS) {
    suspendAgentBox().catch(() => {});
    lastActivity = Date.now();
  }
}, 30_000).unref?.();
