/** Replaceable, single-server public-demo policy. No dependency on the agent or UI. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const demoEnabled = () => process.env.DEMO === 'true';
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}`);
  return value;
};
export const demoLimits = () => ({
  tokens: positive('DEMO_TOKEN_LIMIT', 16000),
  turns: positive('DEMO_TURN_LIMIT', 4),
  globalTokens: positive('DEMO_GLOBAL_TOKEN_LIMIT', 500000),
  users: positive('DEMO_USER_LIMIT', 200),
});
export function demoContact() {
  const value = process.env.DEMO_CONTACT_URL ?? 'mailto:ismaelfcom93@gmail.com';
  return /^(https:\/\/|mailto:)/i.test(value) ? value : null;
}
export const demoMessage = () =>
  `You have reached this demo's limit. Want to learn more or build something like this? Contact the person who shared this app with you.${demoContact() ? ` ${demoContact()}` : ''}`;
export class DemoLimitError extends Error {
  constructor() {
    super(demoMessage());
  }
}
interface Guest {
  id: string;
  conversation: string | null;
  tokens: number;
  turns: number;
}
let database: DatabaseSync | undefined;
export function demoDb() {
  if (database) return database;
  const path = process.env.DEMO_DB ?? '.data/demo.db';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS demo_guests (id TEXT PRIMARY KEY, proof TEXT UNIQUE NOT NULL, conversation TEXT UNIQUE, tokens INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS demo_linked_numbers (number TEXT PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_conversations (conversation TEXT PRIMARY KEY, owner TEXT NOT NULL);
  `);
  // Full-access invites (scripts/demo-invite.mjs) are guests with these columns set.
  const columns = (database.prepare('PRAGMA table_info(demo_guests)').all() as { name: string }[]).map((c) => c.name);
  for (const [name, type] of [['full_access', 'INTEGER NOT NULL DEFAULT 0'], ['label', 'TEXT'], ['expires_at', 'INTEGER']])
    if (!columns.includes(name)) database.exec(`ALTER TABLE demo_guests ADD COLUMN ${name} ${type}`);
  return database;
}
const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const secureRequest = (request: Request) =>
  new URL(request.url).protocol === 'https:' ||
  request.headers.get('x-forwarded-proto') === 'https';
/** An invited guest skips usage limits until its invite expires or is revoked. */
export function isFullAccess(id: string) {
  return !!demoDb()
    .prepare(
      'SELECT 1 FROM demo_guests WHERE id = ? AND full_access = 1 AND (expires_at IS NULL OR expires_at > ?)',
    )
    .get(id, Date.now());
}
/** `?invite=<token>` becomes the guest cookie; the redirect drops the token from the URL. */
export function redeemInvite(request: Request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const token = url.searchParams.get('invite');
  if (token === null) return null;
  url.searchParams.delete('invite');
  const row = /^[a-f0-9]{64}$/.test(token)
    ? (demoDb()
        .prepare(
          'SELECT expires_at FROM demo_guests WHERE proof = ? AND full_access = 1 AND (expires_at IS NULL OR expires_at > ?)',
        )
        .get(hash(token), Date.now()) as { expires_at: number | null } | undefined)
    : undefined;
  if (!row) return null;
  const maxAge = row.expires_at
    ? Math.ceil((row.expires_at - Date.now()) / 1000)
    : 365 * 24 * 3600;
  return {
    location: url.pathname + url.search,
    cookie: `demo_guest=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(request) ? '; Secure' : ''}`,
  };
}
const requests = new WeakMap<Request, string>();
export function demoUser(request: Request): string | undefined {
  if (!demoEnabled()) return undefined;
  if (requests.has(request)) return requests.get(request);
  const token = /(?:^|;\s*)demo_guest=([a-f0-9]{64})(?:;|$)/.exec(
    request.headers.get('cookie') ?? '',
  )?.[1];
  const row = token
    ? (demoDb()
        .prepare('SELECT id FROM demo_guests WHERE proof = ?')
        .get(hash(token)) as { id: string } | undefined)
    : undefined;
  if (!row)
    throw new Response('Open the app to start your demo.', { status: 401 });
  return row.id;
}
export function identifyDemo(
  request: Request,
  beforeCreate: () => void = () => {},
) {
  try {
    return { id: demoUser(request), cookie: undefined };
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 401) throw error;
  }
  if (
    request.method !== 'GET' ||
    new URL(request.url).pathname.startsWith('/api/')
  )
    throw new Response('Open the app to start your demo.', { status: 401 });
  beforeCreate();
  const token = randomBytes(32).toString('hex'),
    id = randomUUID();
  demoDb()
    .prepare('INSERT INTO demo_guests(id, proof) VALUES (?, ?)')
    .run(id, hash(token));
  requests.set(request, id);
  return {
    id,
    cookie: `demo_guest=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureRequest(request) ? '; Secure' : ''}`,
  };
}
export function demoGuest(id: string) {
  return demoDb()
    .prepare(
      'SELECT id, conversation, tokens, turns FROM demo_guests WHERE id = ?',
    )
    .get(id) as unknown as Guest;
}
export function conversationOwner(conversation: string) {
  if (!demoEnabled()) return undefined;
  return (
    demoDb()
      .prepare(
        'SELECT id FROM demo_guests WHERE conversation = ? UNION ALL SELECT owner FROM demo_conversations WHERE conversation = ?',
      )
      .get(conversation, conversation) as { id: string } | undefined
  )?.id;
}
export function assertDemoOwner(id: string, conversation: string) {
  if (conversationOwner(conversation) !== id)
    throw new Response('Conversation not found', { status: 404 });
}
/** The user cap counts guests who started a demo; visits that never chat (crawlers, link previews) don't use it up. */
const startedGuests = () =>
  (
    demoDb()
      .prepare(
        'SELECT count(*) AS n FROM demo_guests WHERE conversation IS NOT NULL AND full_access = 0',
      )
      .get() as { n: number }
  ).n;
export function bindDemoConversation(id: string, conversation: string) {
  const result = demoDb()
    .prepare(
      `UPDATE demo_guests SET conversation = ? WHERE id = ? AND conversation IS NULL
    AND (SELECT count(*) FROM demo_guests WHERE conversation IS NOT NULL AND full_access = 0) < ?`,
    )
    .run(conversation, id, demoLimits().users);
  if (!result.changes) throw new DemoLimitError();
}
// Invited guests' usage is tracked but never counts toward the public demo's budget.
const publicTokens = () =>
  (
    demoDb()
      .prepare(
        'SELECT coalesce(sum(tokens), 0) AS n FROM demo_guests WHERE full_access = 0',
      )
      .get() as { n: number }
  ).n;
export function demoStatus(id: string) {
  const guest = demoGuest(id),
    limits = demoLimits(),
    fullAccess = isFullAccess(id);
  const total = { n: publicTokens() };
  return {
    enabled: true as const,
    fullAccess,
    tokens: guest.tokens,
    turns: guest.turns,
    tokenLimit: limits.tokens,
    turnLimit: limits.turns,
    exhausted:
      !fullAccess &&
      (guest.tokens >= limits.tokens ||
      guest.turns >= limits.turns ||
      total.n >= limits.globalTokens ||
      (!guest.conversation && startedGuests() >= limits.users)),
    conversationId: guest.conversation,
    contactUrl: demoContact(),
    message: demoMessage(),
  };
}
/** An atomic reservation also works across workers. A failed/interrupted turn stays charged. */
export function beginDemoTurn(id: string, inputTokens: number) {
  const db = demoDb(),
    limits = demoLimits();
  if (isFullAccess(id)) {
    db.prepare(
      'UPDATE demo_guests SET tokens = tokens + ?, turns = turns + 1 WHERE id = ?',
    ).run(inputTokens, id);
    return;
  }
  const result = db
    .prepare(
      `UPDATE demo_guests SET tokens = tokens + ?, turns = turns + 1
    WHERE id = ? AND turns < ? AND tokens + ? <= ?
    AND (SELECT coalesce(sum(tokens),0) FROM demo_guests WHERE full_access = 0) + ? <= ?`,
    )
    .run(
      inputTokens,
      id,
      limits.turns,
      inputTokens,
      limits.tokens,
      inputTokens,
      limits.globalTokens,
    );
  if (!result.changes) throw new DemoLimitError();
}
export const estimateTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
export function chargeDemoOutput(id: string, tokens: number) {
  demoDb()
    .prepare('UPDATE demo_guests SET tokens = tokens + ? WHERE id = ?')
    .run(tokens, id);
  if (isFullAccess(id)) return false;
  const status = demoStatus(id);
  return (
    status.tokens >= status.tokenLimit ||
    publicTokens() >= demoLimits().globalTokens
  );
}
/** A WhatsApp number cannot be relinked under fresh cookies to reset its allowance. */
export function claimDemoNumber(id: string, number: string) {
  demoDb()
    .prepare(
      'INSERT OR IGNORE INTO demo_linked_numbers(number, owner) VALUES (?, ?)',
    )
    .run(hash(number), id);
  const row = demoDb()
    .prepare('SELECT owner FROM demo_linked_numbers WHERE number = ?')
    .get(hash(number)) as { owner: string };
  return row.owner === id;
}
const creating = new Map<string, Promise<string>>();
export function demoConversation(id: string, create: () => Promise<string>) {
  // Invited guests open as many conversations as they like.
  if (isFullAccess(id))
    return create().then((conversation) => {
      demoDb()
        .prepare('INSERT INTO demo_conversations(conversation, owner) VALUES (?, ?)')
        .run(conversation, id);
      return conversation;
    });
  const existing = demoGuest(id).conversation;
  if (existing) return Promise.resolve(existing);
  const pending = creating.get(id);
  if (pending) return pending;
  if (demoStatus(id).exhausted) throw new DemoLimitError();
  const result = create()
    .then((conversation) => {
      bindDemoConversation(id, conversation);
      return conversation;
    })
    .finally(() => creating.delete(id));
  creating.set(id, result);
  return result;
}
