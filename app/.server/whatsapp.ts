/**
 * El canal de WhatsApp — spec 5.
 *
 * La app es un dispositivo vinculado más: `makeWASocket` en este mismo proceso, y el teléfono
 * la ve como otra pestaña de WhatsApp Web. Baileys entrega todo lo que llega al número; aquí
 * se decide dónde contestar (sólo grupos con el interruptor prendido), se juntan las ráfagas
 * en un turno y se devuelve la respuesta por donde entró. El agente no se entera de por dónde
 * le hablaron: sólo ve `askFromChannel`.
 */
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  initAuthCreds,
  isJidGroup,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type AuthenticationCreds,
  type ConnectionState,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type WAVersion,
} from "@whiskeysockets/baileys";
import { askFromChannel, type PromptImage } from "./acp";
import { clientDbPath } from "./extensions";

export type WaPhase = "disconnected" | "connecting" | "qr_pending" | "pairing" | "connected" | "failed";

export interface WaStatus {
  phase: WaPhase;
  /** El QR como data URL. Nunca se guarda: vive en memoria mientras dura el handshake. */
  qr?: string;
  /** El código de 8 caracteres cuando se vincula con el número. */
  pairingCode?: string;
  /** El número vinculado, ya conectado. */
  user?: { id: string; name?: string };
  error?: string;
  since: number;
}

export interface WaGroup { jid: string; subject: string; enabled: boolean; seenAt: number }

export type WaEvent = { type: "status"; status: WaStatus } | { type: "groups"; groups: WaGroup[] };

// Baileys habla por pino. Por omisión no queremos su log en el nuestro; con `WHATSAPP_LOG`
// (`info`, `debug`, `trace`) se vuelca a la consola para depurar un handshake que no cierra.
const LEVELS = ["trace", "debug", "info", "warn", "error"];
const LOG_LEVEL = process.env.WHATSAPP_LOG?.toLowerCase() ?? "";
function makeLogger(level: string, bindings: Record<string, unknown> = {}) {
  const threshold = LEVELS.indexOf(level);
  const log = (name: string) => (obj: unknown, msg?: string) => {
    if (threshold < 0 || LEVELS.indexOf(name) < threshold) return;
    const extra = typeof obj === "object" && obj !== null ? { ...bindings, ...(obj as object) } : { ...bindings, value: obj };
    if ((extra as { err?: unknown }).err instanceof Error) (extra as { err: unknown }).err = String((extra as { err: Error }).err.stack ?? extra);
    console.log(`[whatsapp:${name}] ${msg ?? (typeof obj === "string" ? obj : "")} ${Object.keys(extra).length ? JSON.stringify(extra).slice(0, 2000) : ""}`);
  };
  const logger = {
    level: threshold < 0 ? "silent" : level,
    child(extra: Record<string, unknown>) { return makeLogger(level, { ...bindings, ...extra }); },
    trace: log("trace"), debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"),
  };
  return logger;
}
const silent = makeLogger(LOG_LEVEL);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS whatsapp_auth (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_groups (
    jid     TEXT PRIMARY KEY,
    subject TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    seen_at INTEGER NOT NULL
  );
`;

/** Cuánto se espera a que dejen de llegar mensajes seguidos antes de abrir el turno. */
const BURST_MS = 1500;
/** Las llaves de señal llegan a ráfagas en el pairing: se escriben juntas, o el handshake se rompe. */
const AUTH_FLUSH_MS = 600;
const MAX_RECONNECTS = 5;
const GROUPS_TTL_MS = 60_000;
/** Un pie de foto largo lo rechaza WhatsApp; el resto va como texto aparte. */
const CAPTION_MAX = 1024;

// ---------------------------------------------------------------------------
// Persistencia: credenciales y allowlist de grupos, en la misma base que las extensiones.
// ---------------------------------------------------------------------------
class WhatsAppStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /**
   * El estado de autenticación de Baileys sobre sqlite. Todo vive en memoria (las lecturas del
   * handshake son muchas y síncronas en la práctica) y se vuelca a la base con debounce.
   */
  authState() {
    const cache = new Map<string, unknown>();
    for (const row of this.db.prepare("SELECT key, value FROM whatsapp_auth").all() as { key: string; value: string }[]) {
      cache.set(row.key, JSON.parse(row.value, BufferJSON.reviver));
    }
    const creds = (cache.get("creds") as AuthenticationCreds | undefined) ?? initAuthCreds();
    cache.set("creds", creds);
    const dirty = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const upsert = this.db.prepare("INSERT INTO whatsapp_auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const remove = this.db.prepare("DELETE FROM whatsapp_auth WHERE key = ?");
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      if (!dirty.size) return;
      this.db.exec("BEGIN");
      try {
        for (const key of dirty) {
          if (cache.has(key)) upsert.run(key, JSON.stringify(cache.get(key), BufferJSON.replacer));
          else remove.run(key);
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      dirty.clear();
    };
    const mark = (key: string) => { dirty.add(key); timer ??= setTimeout(flush, AUTH_FLUSH_MS); };
    const keys: SignalKeyStore = {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = cache.get(`${type}:${id}`);
          if (value === undefined || value === null) continue;
          if (type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: (data) => {
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          for (const [id, value] of Object.entries(data[category] ?? {})) {
            const key = `${category}:${id}`;
            if (value) cache.set(key, value); else cache.delete(key);
            mark(key);
          }
        }
      },
    };
    return {
      creds, keys,
      saveCreds: () => mark("creds"),
      flush,
      clear: () => {
        clearTimeout(timer); timer = undefined;
        cache.clear(); dirty.clear();
        this.db.exec("DELETE FROM whatsapp_auth");
      },
    };
  }

  /** ¿Hay un número vinculado? Se mira antes de reconectar solo al arrancar. */
  registered() {
    const row = this.db.prepare("SELECT value FROM whatsapp_auth WHERE key = 'creds'").get() as { value: string } | undefined;
    if (!row) return false;
    try { return JSON.parse(row.value).registered === true; } catch { return false; }
  }

  listGroups(): WaGroup[] {
    return (this.db.prepare("SELECT jid, subject, enabled, seen_at FROM whatsapp_groups ORDER BY enabled DESC, seen_at DESC").all() as
      { jid: string; subject: string; enabled: number; seen_at: number }[])
      .map(row => ({ jid: row.jid, subject: row.subject, enabled: row.enabled === 1, seenAt: row.seen_at }));
  }

  /** Anota un grupo visto; si ya está, sólo refresca fecha (y nombre, si llegó). Devuelve si es nuevo. */
  touchGroup(jid: string, subject?: string) {
    const known = this.db.prepare("SELECT subject FROM whatsapp_groups WHERE jid = ?").get(jid) as { subject: string } | undefined;
    this.db.prepare(
      `INSERT INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(jid) DO UPDATE SET seen_at = excluded.seen_at, subject = CASE WHEN excluded.subject = '' THEN subject ELSE excluded.subject END`,
    ).run(jid, subject ?? "", Date.now());
    return !known || (!!subject && known.subject !== subject);
  }

  enabled(jid: string) {
    const row = this.db.prepare("SELECT enabled FROM whatsapp_groups WHERE jid = ?").get(jid) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  setEnabled(jid: string, enabled: boolean) {
    return this.db.prepare("UPDATE whatsapp_groups SET enabled = ? WHERE jid = ?").run(Number(enabled), jid).changes !== 0;
  }
}

// ---------------------------------------------------------------------------
// El canal
// ---------------------------------------------------------------------------
interface Incoming { from: string; text: string; images: PromptImage[]; key: WAMessageKey }

const SINGLE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:[️⃣]|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}[️]?)*$/u;

function unwrap(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  if (!message) return undefined;
  // Mensajes efímeros y de "ver una vez" envuelven el de verdad.
  return unwrap(
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.documentWithCaptionMessage?.message,
  ) ?? message;
}

/**
 * El texto del agente tal como lo entiende WhatsApp. Un `<artifact>` que se le escapó (a pesar
 * de las instrucciones) se sustituye por una nota: el archivo se ve en el chat web, donde el
 * mismo turno lo pintó. Del markdown se traduce lo mínimo: negritas, encabezados y fences.
 */
export function paraWhatsApp(text: string) {
  return text
    .replace(/<artifact\b[^>]*?\btitle\s*=\s*"([^"]*)"[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi, (_, title) => `📎 _${title || "Archivo"}_ (se ve en el chat web)`)
    .replace(/<artifact\b[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi, "📎 _Archivo_ (se ve en el chat web)")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^```[^\n]*\n([\s\S]*?)```$/gm, "```$1```")
    .trim();
}

class WhatsAppChannel extends EventEmitter {
  status: WaStatus = { phase: "disconnected", since: Date.now() };
  private store: WhatsAppStore;
  private auth: ReturnType<WhatsAppStore["authState"]> | undefined;
  private sock: WASocket | undefined;
  private generation = 0;
  private wanted = false;
  private attempts = 0;
  private pairPhone: string | undefined;
  private retry: NodeJS.Timeout | undefined;
  /** Ids de lo que mandamos: para no contestarnos y para saber a qué reaccionan. */
  private ownIds = new Set<string>();
  private buffers = new Map<string, { items: Incoming[]; timer: NodeJS.Timeout }>();
  private groupsAt = 0;

  constructor(store: WhatsAppStore) { super(); this.store = store; }

  private setStatus(patch: Partial<WaStatus> & { phase: WaPhase }) {
    this.status = { ...patch, since: Date.now() };
    this.emit("event", { type: "status", status: this.status } satisfies WaEvent);
  }

  snapshot() { return { status: this.status, groups: this.store.listGroups() }; }

  /** Reconecta al primer request si hay credenciales de otra vida. */
  rehidratar() {
    if (this.sock || this.wanted || !this.store.registered()) return;
    void this.connect();
  }

  /**
   * Abre el socket. Con `phone` se pide el código de 8 caracteres en vez de QR. Son el mismo
   * handshake: pedir uno cancela al otro.
   */
  async connect(phone?: string) {
    this.teardown();
    const gen = ++this.generation;
    this.wanted = true;
    this.pairPhone = phone;
    this.setStatus({ phase: "connecting" });
    try {
      this.auth ??= this.store.authState();
      const { creds, keys, saveCreds } = this.auth;
      // La versión de WhatsApp Web que anuncia el socket: la última si el fetch contesta en 5 s,
      // la que trae Baileys si no.
      const version = await Promise.race([
        fetchLatestWaWebVersion({}).then(v => v.version as WAVersion, () => undefined),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (gen !== this.generation) return;
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds, keys: makeCacheableSignalKeyStore(keys, silent) },
        logger: silent,
        browser: Browsers.macOS("Chrome"),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", update => void this.onConnection(gen, update));
      sock.ev.on("messages.upsert", event => void this.onMessages(gen, event));
      if (phone && !creds.registered) {
        setTimeout(async () => {
          if (gen !== this.generation) return;
          try {
            const code = await sock.requestPairingCode(phone);
            if (gen === this.generation) this.setStatus({ phase: "pairing", pairingCode: code });
          } catch (error) {
            if (gen === this.generation) this.setStatus({ phase: "failed", error: `No pude pedir el código: ${(error as Error).message}` });
          }
        }, 1500);
      }
    } catch (error) {
      if (gen === this.generation) this.setStatus({ phase: "failed", error: (error as Error).message });
    }
  }

  /** Cierra el socket. Con `logout` además desvincula el dispositivo y borra las credenciales. */
  async disconnect(logout = false) {
    this.wanted = false;
    const sock = this.sock;
    this.teardown();
    if (logout) {
      try { await sock?.logout(); } catch {}
      this.auth?.clear();
      this.auth = undefined;
    } else {
      this.auth?.flush();
    }
    this.setStatus({ phase: "disconnected" });
  }

  private teardown() {
    clearTimeout(this.retry); this.retry = undefined;
    this.generation++;
    const sock = this.sock;
    this.sock = undefined;
    if (sock) { try { sock.ev.removeAllListeners("connection.update"); sock.ev.removeAllListeners("messages.upsert"); sock.end(undefined); } catch {} }
  }

  private async onConnection(gen: number, update: Partial<ConnectionState>) {
    if (gen !== this.generation) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr && !this.pairPhone) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (gen === this.generation) this.setStatus({ phase: "qr_pending", qr: dataUrl });
    }
    if (connection === "open") {
      this.attempts = 0;
      this.pairPhone = undefined;
      this.auth?.flush();
      const me = this.sock?.user;
      this.setStatus({ phase: "connected", user: me ? { id: me.id.split(":")[0].split("@")[0], name: me.name } : undefined });
      // Con la caché de 60 s intacta: reconectar varias veces seguidas no debe pedir la lista
      // cada vez (WhatsApp contesta `rate-overlimit`).
      void this.groups(true);
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      this.sock = undefined;
      if (code === DisconnectReason.loggedOut) {
        this.wanted = false;
        this.auth?.clear();
        this.auth = undefined;
        this.setStatus({ phase: "disconnected", error: "El teléfono cerró la sesión. Vincula de nuevo." });
        return;
      }
      if (!this.wanted) return;
      // 515 es rutina tras vincular: WhatsApp pide reabrir el socket. No cuenta como fallo.
      if (code === DisconnectReason.restartRequired) {
        this.setStatus({ phase: "connecting" });
        this.retry = setTimeout(() => void this.connect(this.pairPhone), 500);
        return;
      }
      this.attempts++;
      if (this.attempts > MAX_RECONNECTS) {
        this.wanted = false;
        this.setStatus({ phase: "failed", error: `Se perdió la conexión (${code ?? "sin código"}) y no volvió tras ${MAX_RECONNECTS} intentos.` });
        return;
      }
      const wait = Math.min(30_000, 2 ** this.attempts * 1000);
      this.setStatus({ phase: "connecting", error: `Conexión perdida (${code ?? "sin código"}); reintento ${this.attempts} en ${wait / 1000} s.` });
      this.retry = setTimeout(() => void this.connect(this.pairPhone), wait);
    }
  }

  /** Los grupos donde está el número. `groupFetchAllParticipating` se cachea 60 s y nunca corre en el poll. */
  async groups(refresh = false): Promise<WaGroup[]> {
    const sock = this.sock;
    if (refresh && sock && this.status.phase === "connected" && Date.now() - this.groupsAt > GROUPS_TTL_MS) {
      this.groupsAt = Date.now();
      try {
        const all = await sock.groupFetchAllParticipating();
        let changed = false;
        for (const [jid, meta] of Object.entries(all)) changed = this.store.touchGroup(jid, meta.subject) || changed;
        if (changed) this.emit("event", { type: "groups", groups: this.store.listGroups() } satisfies WaEvent);
      } catch (error) {
        console.warn("[whatsapp] no pude listar los grupos:", (error as Error).message);
      }
    }
    return this.store.listGroups();
  }

  setGroup(jid: string, enabled: boolean) {
    if (!isJidGroup(jid)) return false;
    const ok = this.store.setEnabled(jid, enabled);
    if (ok) this.emit("event", { type: "groups", groups: this.store.listGroups() } satisfies WaEvent);
    return ok;
  }

  private grupoActivo(jid: string) { return isJidGroup(jid) && this.store.enabled(jid); }

  private async onMessages(gen: number, event: { type: string; messages: WAMessage[] }) {
    if (gen !== this.generation || event.type !== "notify") return;
    for (const m of event.messages) {
      const jid = m.key.remoteJid ?? "";
      if (!isJidGroup(jid)) continue;
      // Lo que mandó ESTE proceso (respuestas del agente) se reconoce por id. Lo que escribe
      // el dueño del número desde su teléfono también llega como `fromMe`, y ése sí cuenta:
      // si no, quien vincula su propio número no puede hablarle al agente.
      if (m.key.id && this.ownIds.has(m.key.id)) continue;
      // Un grupo nuevo aparece en la lista cuando alguien escribe en él.
      if (this.store.touchGroup(jid)) this.emit("event", { type: "groups", groups: this.store.listGroups() } satisfies WaEvent);
      if (!this.grupoActivo(jid)) continue;
      const msg = unwrap(m.message);
      if (!msg) continue;
      const from = m.pushName || (m.key.fromMe ? this.status.user?.name : undefined) || (m.key.participant ?? "").split("@")[0] || "alguien";
      if (msg.reactionMessage) {
        const target = msg.reactionMessage.key?.id;
        const emoji = msg.reactionMessage.text;
        // Sólo las reacciones a lo que mandamos nosotros; quitar la reacción llega con texto vacío.
        if (!target || !this.ownIds.has(target) || !emoji) continue;
        this.enqueue(jid, { from, text: `${from} reaccionó con ${emoji} a un mensaje del agente.`, images: [], key: m.key });
        continue;
      }
      let text = msg.conversation ?? msg.extendedTextMessage?.text ?? "";
      const images: PromptImage[] = [];
      if (msg.imageMessage) {
        try {
          const buffer = await downloadMediaMessage(m, "buffer", {});
          images.push({ mimeType: msg.imageMessage.mimetype || "image/jpeg", data: buffer.toString("base64") });
        } catch (error) {
          console.warn("[whatsapp] no pude descargar la foto:", (error as Error).message);
        }
        text = msg.imageMessage.caption || text;
      }
      if (!text && !images.length) continue;
      this.enqueue(jid, { from, text, images, key: m.key });
    }
  }

  // Varios mensajes seguidos son UN turno: se juntan 1.5 s y va una sola petición.
  private enqueue(jid: string, item: Incoming) {
    const pending = this.buffers.get(jid);
    if (pending) clearTimeout(pending.timer);
    const items = pending?.items ?? [];
    items.push(item);
    this.buffers.set(jid, { items, timer: setTimeout(() => { this.buffers.delete(jid); void this.turn(jid, items); }, BURST_MS) });
  }

  private async react(key: WAMessageKey, text: string) {
    try { await this.sock?.sendMessage(key.remoteJid!, { react: { text, key } }); } catch {}
  }

  private async turn(jid: string, items: Incoming[]) {
    const sock = this.sock;
    if (!sock) return;
    const last = items[items.length - 1];
    void this.react(last.key, "👀");
    const composing = () => sock.sendPresenceUpdate("composing", jid).catch(() => {});
    void composing();
    const typing = setInterval(composing, 8000);
    const text = items.map(i => `${i.from}: ${i.text}`.trim()).join("\n");
    const images = items.flatMap(i => i.images);
    const from = [...new Set(items.map(i => i.from))].join(", ");
    try {
      const answer = await askFromChannel(text, "whatsapp", from, images);
      clearInterval(typing);
      void this.sock?.sendPresenceUpdate("paused", jid).catch(() => {});
      // El turno pudo tardar minutos: `send` usa el socket que haya ahora, no el de entonces.
      await this.deliver(jid, last.key, answer);
      void this.react(last.key, "✅");
    } catch (error) {
      clearInterval(typing);
      console.warn("[whatsapp] el turno falló:", (error as Error).message);
      await this.send(jid, { text: `⚠️ ${(error as Error).message || "No pude contestar."}` });
      void this.react(last.key, "❌");
    }
  }

  private async deliver(jid: string, replyTo: WAMessageKey, answer: { text: string; images: PromptImage[] }) {
    const text = paraWhatsApp(answer.text);
    // Si el agente contesta con un solo emoji, va como reacción.
    if (!answer.images.length && text && SINGLE_EMOJI.test(text)) {
      await this.react(replyTo, text);
      return;
    }
    if (!answer.images.length) {
      await this.send(jid, { text: text || "(sin respuesta)" });
      return;
    }
    // Las imágenes de las herramientas salen como foto con el texto de pie (en la primera).
    let caption = text;
    let rest = "";
    if (caption.length > CAPTION_MAX) { rest = caption; caption = ""; }
    for (const [index, image] of answer.images.entries()) {
      await this.send(jid, { image: Buffer.from(image.data, "base64"), mimetype: image.mimeType, ...(index === 0 && caption ? { caption } : {}) });
    }
    if (rest) await this.send(jid, { text: rest });
  }

  private async send(jid: string, content: Parameters<WASocket["sendMessage"]>[1]) {
    const sent = await this.sock?.sendMessage(jid, content);
    if (sent?.key.id) {
      this.ownIds.add(sent.key.id);
      // Con tope: los ids sólo sirven para reconocer reacciones recientes.
      if (this.ownIds.size > 500) this.ownIds.delete(this.ownIds.values().next().value!);
    }
    return sent;
  }
}

// El singleton vive en `globalThis`: en desarrollo Vite re-evalúa este módulo con cada edición
// y un `let` de módulo daría un segundo canal con las mismas credenciales. Dos sockets con el
// mismo número se expulsan mutuamente (conflicto 440) y el estado oscila conectado/conectando.
// Precio: en dev, un cambio en esta clase pide reiniciar el servidor para aplicarse.
const GLOBAL_KEY = Symbol.for("acp-agent-ui.whatsapp");
export function whatsappChannel(): WhatsAppChannel {
  const globals = globalThis as { [GLOBAL_KEY]?: WhatsAppChannel };
  if (!globals[GLOBAL_KEY]) {
    const channel = new WhatsAppChannel(new WhatsAppStore(clientDbPath()));
    channel.setMaxListeners(100);
    channel.rehidratar();
    globals[GLOBAL_KEY] = channel;
  }
  return globals[GLOBAL_KEY];
}
