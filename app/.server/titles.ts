import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

// El agente devuelve `New Chat` para todos los hilos y no manda `session_info_update` con
// título en la caja de prod (ver docs/spec3-revivir.md). Sin título, ocho hilos iguales parecen
// perdidos. Aquí se saca un título del primer mensaje del humano y se guarda en la caja de la UI,
// porque no hay método ACP para ponérselo al agente y `session/list` seguiría diciendo `New Chat`.

const GENERIC = new Set(["", "new chat", "new session", "untitled", "nueva conversación", "sin título"]);
const MAX = 60;

export function isGenericTitle(title: string | null | undefined) {
  return GENERIC.has((title ?? "").trim().toLowerCase());
}

export function titleFromPrompt(text: string) {
  const line = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n")
    .map(l => l.replace(/^[\s#>*\-•\d.)]+/, "").trim())
    .find(Boolean) ?? "";
  const clean = line.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX) return clean;
  const cut = clean.slice(0, MAX);
  const space = cut.lastIndexOf(" ");
  return (space > MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.¿?¡!]+$/, "") + "…";
}

export class TitleStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL);");
  }

  get(sessionId: string): string | undefined {
    const row = this.db.prepare("SELECT title FROM titles WHERE session_id = ?").get(sessionId) as { title: string } | undefined;
    return row?.title;
  }

  set(sessionId: string, title: string) {
    this.db.prepare("INSERT INTO titles (session_id, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at")
      .run(sessionId, title, Date.now());
  }

  close() { this.db.close(); }
}

let store: TitleStore | undefined;
export function titleStore() {
  const path = process.env.ACP_TITLES_DB || ".data/titles.db";
  return store ??= new TitleStore(path === ":memory:" ? path : resolve(path));
}
