import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Each box numbers its sessions by date (`20261028_1`), so two boxes hand out the same ids and
// a URL with the agent's id can't say which box holds the conversation. The app gives each
// conversation its own id instead (`/c/k7f3q9`), the same on every box, and remembers here where
// it lives. Ids from before (agent ids of the first box, no row here) still open on that box.
export interface ConversationPlace {
  box: string;
  session: string;
}

// Lowercase letters and digits, never `_`: it can't be mistaken for an agent id like `20261028_1`.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function newId() {
  return [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export class ConversationIds {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, box TEXT NOT NULL, session TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (box, session));',
    );
  }

  /** Where an app id lives; undefined for an id this app never gave out. */
  place(id: string): ConversationPlace | undefined {
    return this.db
      .prepare('SELECT box, session FROM conversations WHERE id = ?')
      .get(id) as ConversationPlace | undefined;
  }

  /** The app id of a box's session, if it has one. */
  find(box: string, session: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM conversations WHERE box = ? AND session = ?')
      .get(box, session) as { id: string } | undefined;
    return row?.id;
  }

  /** The app id of a box's session, giving it one the first time. */
  assign(box: string, session: string): string {
    const known = this.find(box, session);
    if (known) return known;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversations (id, box, session, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(newId(), box, session, Date.now());
    return this.find(box, session)!;
  }

  close() {
    this.db.close();
  }
}

let store: ConversationIds | undefined;
export function conversationIds() {
  const path = process.env.ACP_CONVERSATIONS_DB || '.data/conversations.db';
  return (store ??= new ConversationIds(
    path === ':memory:' ? path : resolve(path),
  ));
}
