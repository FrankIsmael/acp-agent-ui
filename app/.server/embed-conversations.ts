/**
 * Conversaciones abiertas desde el widget del portfolio (`/embed`). Se guardan en la misma
 * base que la demo para que el hilo siga acotado tras reiniciar el servidor o recargar la página.
 */
import type { DatabaseSync } from 'node:sqlite';
import { demoDb } from './demo';

const initialized = new WeakSet<DatabaseSync>();
function db() {
  const database = demoDb();
  if (!initialized.has(database)) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS embed_conversations (conversation TEXT PRIMARY KEY)',
    );
    initialized.add(database);
  }
  return database;
}

export function markEmbedConversation(conversation: string) {
  db()
    .prepare('INSERT OR IGNORE INTO embed_conversations VALUES (?)')
    .run(conversation);
}

export function isEmbedConversation(conversation: string) {
  return !!db()
    .prepare('SELECT 1 FROM embed_conversations WHERE conversation = ?')
    .get(conversation);
}
