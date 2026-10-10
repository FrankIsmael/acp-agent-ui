/**
 * Conversaciones abiertas desde el widget del portfolio (`/embed`). Se guardan en la misma
 * base que la demo para que el hilo siga acotado tras reiniciar el servidor o recargar la página.
 * `profiled` marca si el agente ya recibió el perfil de Ismael (`portfolio-profile.ts`).
 */
import type { DatabaseSync } from 'node:sqlite';
import { demoDb } from './demo';

const initialized = new WeakSet<DatabaseSync>();
function db() {
  const database = demoDb();
  if (!initialized.has(database)) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS embed_conversations (conversation TEXT PRIMARY KEY, profiled INTEGER NOT NULL DEFAULT 0)',
    );
    // Bases creadas antes de `profiled`.
    const columns = database
      .prepare('PRAGMA table_info(embed_conversations)')
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === 'profiled'))
      database.exec(
        'ALTER TABLE embed_conversations ADD COLUMN profiled INTEGER NOT NULL DEFAULT 0',
      );
    initialized.add(database);
  }
  return database;
}

export function markEmbedConversation(conversation: string) {
  db()
    .prepare(
      'INSERT OR IGNORE INTO embed_conversations (conversation) VALUES (?)',
    )
    .run(conversation);
}

/** `null` si no es del widget; si lo es, si el agente ya tiene el perfil. */
export function embedConversation(conversation: string) {
  const row = db()
    .prepare('SELECT profiled FROM embed_conversations WHERE conversation = ?')
    .get(conversation) as { profiled: number } | undefined;
  return row ? { profiled: !!row.profiled } : null;
}

export function markProfiled(conversation: string) {
  db()
    .prepare(
      'UPDATE embed_conversations SET profiled = 1 WHERE conversation = ?',
    )
    .run(conversation);
}
