#!/usr/bin/env node
/**
 * Full-access invites for the public demo: guests without usage limits.
 *
 *   node scripts/demo-invite.mjs create <label> [--days N] [--url https://domain]
 *   node scripts/demo-invite.mjs list
 *   node scripts/demo-invite.mjs revoke <label|id>
 *
 * The link is printed once; only the token's sha256 is stored (same as any guest).
 * Schema must match `demoDb()` in app/.server/demo.ts.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const path = process.env.DEMO_DB ?? '.data/demo.db';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS demo_guests (id TEXT PRIMARY KEY, proof TEXT UNIQUE NOT NULL, conversation TEXT UNIQUE, tokens INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS demo_conversations (conversation TEXT PRIMARY KEY, owner TEXT NOT NULL);
`);
const columns = db.prepare('PRAGMA table_info(demo_guests)').all().map((c) => c.name);
for (const [name, type] of [['full_access', 'INTEGER NOT NULL DEFAULT 0'], ['label', 'TEXT'], ['expires_at', 'INTEGER']])
  if (!columns.includes(name)) db.exec(`ALTER TABLE demo_guests ADD COLUMN ${name} ${type}`);

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const [value] = args.splice(i, 2).slice(1);
  if (value === undefined) fail(`--${name} needs a value`);
  return value;
};
function fail(message) {
  console.error(message);
  process.exit(1);
}

if (command === 'create') {
  const days = flag('days');
  const base = flag('url') ?? (process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : 'http://localhost:5173');
  const label = args.join(' ').trim();
  if (!label) fail('Usage: create <label> [--days N] [--url https://domain]');
  if (days !== undefined && !(Number(days) > 0)) fail('--days must be a positive number');
  const token = randomBytes(32).toString('hex');
  const expires = days ? Date.now() + Number(days) * 86_400_000 : null;
  db.prepare('INSERT INTO demo_guests(id, proof, full_access, label, expires_at) VALUES (?, ?, 1, ?, ?)')
    .run(randomUUID(), createHash('sha256').update(token).digest('hex'), label, expires);
  const url = new URL(base);
  url.searchParams.set('invite', token);
  console.log(`Invite for "${label}"${expires ? ` (expires ${new Date(expires).toISOString().slice(0, 10)})` : ' (no expiry)'}:\n${url}`);
} else if (command === 'list') {
  const rows = db.prepare(`SELECT g.id, g.label, g.full_access, g.expires_at, g.tokens, g.turns,
      (SELECT count(*) FROM demo_conversations c WHERE c.owner = g.id) AS conversations
    FROM demo_guests g WHERE g.label IS NOT NULL ORDER BY g.rowid`).all();
  if (!rows.length) console.log('No invites yet.');
  console.table(rows.map((r) => ({
    label: r.label,
    status: !r.full_access ? 'revoked' : r.expires_at && r.expires_at <= Date.now() ? 'expired' : 'active',
    expires: r.expires_at ? new Date(r.expires_at).toISOString().slice(0, 10) : '-',
    conversations: r.conversations,
    turns: r.turns,
    tokens: r.tokens,
    id: r.id,
  })));
} else if (command === 'revoke') {
  const target = args.join(' ').trim();
  if (!target) fail('Usage: revoke <label|id>');
  const { changes } = db.prepare('UPDATE demo_guests SET full_access = 0 WHERE label IS NOT NULL AND (id = ? OR label = ?)').run(target, target);
  if (!changes) fail(`No invite matches "${target}"`);
  console.log(`Revoked ${changes} invite(s).`);
} else {
  fail('Usage: demo-invite.mjs create <label> [--days N] [--url https://domain] | list | revoke <label|id>');
}
