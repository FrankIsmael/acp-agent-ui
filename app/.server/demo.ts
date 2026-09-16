/** Replaceable, single-server public-demo policy. No dependency on the agent or UI. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const demoEnabled = () => process.env.PUBLIC_DEMO === "true";
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
};
export const demoLimits = () => ({ tokens: positive("DEMO_TOKEN_LIMIT", 16000), turns: positive("DEMO_TURN_LIMIT", 4), globalTokens: positive("DEMO_GLOBAL_TOKEN_LIMIT", 500000), users: positive("DEMO_USER_LIMIT", 200) });
export function demoContact() {
  const value = process.env.DEMO_CONTACT_URL ?? "mailto:ismaelfcom93@gmail.com";
  return /^(https:\/\/|mailto:)/i.test(value) ? value : null;
}
export const demoMessage = () => `Llegaste al límite de esta demo. ¿Quieres conocer más o construir algo así? Contacta a quien te compartió esta app.${demoContact() ? ` ${demoContact()}` : ""}`;
export class DemoLimitError extends Error { constructor() { super(demoMessage()); } }
interface Guest { id: string; conversation: string | null; tokens: number; turns: number }
let database: DatabaseSync | undefined;
export function demoDb() {
  if (database) return database;
  const path = process.env.DEMO_DB ?? ".data/demo.db";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS demo_guests (id TEXT PRIMARY KEY, proof TEXT UNIQUE NOT NULL, conversation TEXT UNIQUE, tokens INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS demo_linked_numbers (number TEXT PRIMARY KEY, owner TEXT NOT NULL);
  `);
  return database;
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const requests = new WeakMap<Request, string>();
export function demoUser(request: Request): string | undefined {
  if (!demoEnabled()) return undefined;
  if (requests.has(request)) return requests.get(request);
  const token = /(?:^|;\s*)demo_guest=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const row = token ? demoDb().prepare("SELECT id FROM demo_guests WHERE proof = ?").get(hash(token)) as { id: string } | undefined : undefined;
  if (!row) throw new Response("Abre la app para iniciar tu demo.", { status: 401 });
  return row.id;
}
export function identifyDemo(request: Request, beforeCreate: () => void = () => {}) {
  try { return { id: demoUser(request), cookie: undefined }; } catch (error) {
    if (!(error instanceof Response) || error.status !== 401) throw error;
  }
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) throw new Response("Abre la app para iniciar tu demo.", { status: 401 });
  const count = demoDb().prepare("SELECT count(*) AS n FROM demo_guests").get() as { n: number };
  if (count.n >= demoLimits().users) throw new DemoLimitError();
  beforeCreate();
  const token = randomBytes(32).toString("hex"), id = randomUUID();
  demoDb().prepare("INSERT INTO demo_guests(id, proof) VALUES (?, ?)").run(id, hash(token));
  requests.set(request, id);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return { id, cookie: `demo_guest=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` };
}
export function demoGuest(id: string) { return demoDb().prepare("SELECT id, conversation, tokens, turns FROM demo_guests WHERE id = ?").get(id) as unknown as Guest; }
export function conversationOwner(conversation: string) {
  if (!demoEnabled()) return undefined;
  return (demoDb().prepare("SELECT id FROM demo_guests WHERE conversation = ?").get(conversation) as { id: string } | undefined)?.id;
}
export function assertDemoOwner(id: string, conversation: string) {
  if (conversationOwner(conversation) !== id) throw new Response("Conversación no encontrada", { status: 404 });
}
export function bindDemoConversation(id: string, conversation: string) {
  const result = demoDb().prepare("UPDATE demo_guests SET conversation = ? WHERE id = ? AND conversation IS NULL").run(conversation, id);
  if (!result.changes) throw new DemoLimitError();
}
export function demoStatus(id: string) {
  const guest = demoGuest(id), limits = demoLimits();
  const total = demoDb().prepare("SELECT coalesce(sum(tokens), 0) AS n FROM demo_guests").get() as { n: number };
  return { enabled: true as const, tokens: guest.tokens, turns: guest.turns, tokenLimit: limits.tokens, turnLimit: limits.turns,
    exhausted: guest.tokens >= limits.tokens || guest.turns >= limits.turns || total.n >= limits.globalTokens,
    conversationId: guest.conversation, contactUrl: demoContact(), message: demoMessage() };
}
/** An atomic reservation also works across workers. A failed/interrupted turn stays charged. */
export function beginDemoTurn(id: string, inputTokens: number) {
  const db = demoDb(), limits = demoLimits();
  const result = db.prepare(`UPDATE demo_guests SET tokens = tokens + ?, turns = turns + 1
    WHERE id = ? AND turns < ? AND tokens + ? <= ?
    AND (SELECT coalesce(sum(tokens),0) FROM demo_guests) + ? <= ?`).run(inputTokens, id, limits.turns, inputTokens, limits.tokens, inputTokens, limits.globalTokens);
  if (!result.changes) throw new DemoLimitError();
}
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
export function chargeDemoOutput(id: string, tokens: number) {
  demoDb().prepare("UPDATE demo_guests SET tokens = tokens + ? WHERE id = ?").run(tokens, id);
  const status = demoStatus(id);
  return status.tokens >= status.tokenLimit || (demoDb().prepare("SELECT sum(tokens) AS n FROM demo_guests").get() as { n: number }).n >= demoLimits().globalTokens;
}
/** A WhatsApp number cannot be relinked under fresh cookies to reset its allowance. */
export function claimDemoNumber(id: string, number: string) {
  demoDb().prepare("INSERT OR IGNORE INTO demo_linked_numbers(number, owner) VALUES (?, ?)").run(hash(number), id);
  const row = demoDb().prepare("SELECT owner FROM demo_linked_numbers WHERE number = ?").get(hash(number)) as { owner: string };
  return row.owner === id;
}
const creating = new Map<string, Promise<string>>();
export function demoConversation(id: string, create: () => Promise<string>) {
  const existing = demoGuest(id).conversation;
  if (existing) return Promise.resolve(existing);
  const pending = creating.get(id);
  if (pending) return pending;
  if (demoStatus(id).exhausted) throw new DemoLimitError();
  const result = create().then(conversation => { bindDemoConversation(id, conversation); return conversation; }).finally(() => creating.delete(id));
  creating.set(id, result);
  return result;
}
