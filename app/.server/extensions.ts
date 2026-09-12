import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ExtensionSummary {
  key: string | null;
  name: string;
  type: string;
  enabled: boolean;
  description: string;
}

export function summarizeExtensions(response: unknown): ExtensionSummary[] {
  const entries = (response as { extensions?: unknown[] } | null)?.extensions;
  if (!Array.isArray(entries)) throw new Error("Respuesta de extensiones inválida");
  return entries.map(item => {
    const entry = item as { configKey?: string | null; enabled: boolean; extension: {
      type: string; name?: string; description?: string; server?: { name: string; type?: string };
    } };
    if (!entry?.extension || typeof entry.enabled !== "boolean") throw new Error("Extensión inválida");
    const extension = entry.extension;
    return {
      key: typeof entry.configKey === "string" ? entry.configKey : null,
      name: extension.server?.name ?? extension.name ?? "Extensión",
      type: extension.type === "mcp" ? extension.server?.type ?? "stdio" : extension.type,
      enabled: entry.enabled, description: extension.description ?? "",
    };
  });
}

function field(form: FormData, key: string, max = 2048, trim = true) {
  const value = form.get(key);
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`Campo inválido: ${key}`);
  return trim ? value.trim() : value;
}

function pairs(source: string, header = false) {
  if (!source) return [];
  const names = new Set<string>();
  return source.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (separator < 1 || !(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(name) || /[\r\n\0]/.test(value)) {
      throw new Error("Usa una variable por línea con el formato NOMBRE=valor");
    }
    const identity = header ? name.toLowerCase() : name;
    if (names.has(identity)) throw new Error("Hay nombres repetidos en la configuración");
    names.add(identity);
    return { name, value };
  });
}

export function parseExtension(form: FormData) {
  const name = field(form, "name", 80);
  if (!name) throw new Error("Escribe un nombre para el servidor");
  const description = field(form, "description", 500);
  const transport = field(form, "transport", 10);
  if (transport === "http") {
    const url = field(form, "url");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Escribe una URL válida"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Usa una URL HTTP o HTTPS sin credenciales ni fragmentos");
    }
    return { type: "mcp" as const, description, server: { type: "http" as const, name, url, headers: pairs(field(form, "headers", 16000, false), true) } };
  }
  if (transport !== "stdio") throw new Error("Transporte no compatible");
  const command = field(form, "command");
  if (!command || /[\r\n]/.test(command)) throw new Error("Escribe el ejecutable del servidor MCP");
  // Quien lanza el proceso es el agente, en su caja, y no hereda ningún PATH: `node` o `npx`
  // a secas fallan allá sin decir nada. Ruta absoluta, siempre.
  if (!command.startsWith("/")) throw new Error("El comando va con ruta absoluta, por ejemplo /usr/local/bin/node");
  const args = field(form, "args", 16000, false).split(/\r?\n/).filter(Boolean);
  return { type: "mcp" as const, description, server: { name, command, args, env: pairs(field(form, "env", 16000, false)) } };
}

type Extension = ReturnType<typeof parseExtension>;
type Row = {
  id: string; name: string; transport: "stdio" | "http"; command: string | null; args: string;
  url: string | null; headers: string; env: string; enabled: number; created_at: number; description: string | null;
};

/**
 * Misma tabla que la rama `sesion-4-mcp`: una columna por campo, `id` UUID, `name` único.
 * Así el archivo que escribe una rama lo lee la otra. `args`, `env` y `headers` van como
 * JSON en texto: se leen y escriben enteros, nunca se busca dentro. `description` es la
 * única columna de más; se añade con ALTER si el archivo viene de la rama.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS extensions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    transport  TEXT NOT NULL,
    command    TEXT,
    args       TEXT NOT NULL DEFAULT '[]',
    url        TEXT,
    headers    TEXT NOT NULL DEFAULT '[]',
    env        TEXT NOT NULL DEFAULT '[]',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`;

function toExtension(row: Row): Extension {
  const description = row.description ?? "";
  return row.transport === "http"
    ? { type: "mcp", description, server: { type: "http", name: row.name, url: row.url ?? "", headers: JSON.parse(row.headers) } }
    : { type: "mcp", description, server: { name: row.name, command: row.command ?? "", args: JSON.parse(row.args), env: JSON.parse(row.env) } };
}

export class ExtensionStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private columns() {
    return (this.db.prepare("PRAGMA table_info(extensions)").all() as { name: string }[]).map(c => c.name);
  }

  // Hubo una versión intermedia que guardaba todo en una columna `configuration` (JSON). Si
  // el archivo viene de ahí se vuelca a la tabla por columnas para no perder lo dado de alta.
  private migrate() {
    const columns = this.columns();
    if (columns.includes("configuration")) {
      const rows = this.db.prepare("SELECT id, enabled, configuration FROM extensions").all() as unknown as { id: string; enabled: number; configuration: string }[];
      this.db.exec("BEGIN; DROP TABLE extensions;");
      try {
        this.db.exec(SCHEMA + "ALTER TABLE extensions ADD COLUMN description TEXT NOT NULL DEFAULT '';");
        for (const row of rows) this.insert(JSON.parse(row.configuration) as Extension, row.enabled === 1);
        this.db.exec("COMMIT;");
      } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
      return;
    }
    this.db.exec(SCHEMA);
    if (!this.columns().includes("description")) this.db.exec("ALTER TABLE extensions ADD COLUMN description TEXT NOT NULL DEFAULT '';");
  }

  private insert(extension: Extension, enabled: boolean) {
    const { server } = extension;
    const id: string = randomUUID();
    const columns = server.type === "http"
      ? { transport: "http", command: null, args: "[]", url: server.url, headers: JSON.stringify(server.headers), env: "[]" }
      : { transport: "stdio", command: server.command, args: JSON.stringify(server.args), url: null, headers: "[]", env: JSON.stringify(server.env) };
    this.db.prepare(
      `INSERT INTO extensions (id, name, transport, command, args, url, headers, env, enabled, created_at, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, server.name, columns.transport, columns.command, columns.args, columns.url, columns.headers, columns.env, Number(enabled), Date.now(), extension.description ?? "");
    return id;
  }

  list() {
    return (this.db.prepare("SELECT * FROM extensions ORDER BY created_at, id").all() as unknown as Row[])
      .map(row => ({ configKey: row.id, enabled: row.enabled === 1, extension: toExtension(row) }));
  }

  get(id: string): Extension | null {
    const row = this.db.prepare("SELECT * FROM extensions WHERE id = ?").get(id) as Row | undefined;
    return row ? toExtension(row) : null;
  }

  add(extension: Extension, enabled = true) {
    try {
      return this.insert(extension, enabled);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Response("Ya existe una extensión con ese nombre", { status: 409 });
      throw error;
    }
  }

  setEnabled(id: string, enabled: boolean) {
    return this.db.prepare("UPDATE extensions SET enabled = ? WHERE id = ?").run(Number(enabled), id).changes !== 0;
  }

  remove(id: string) {
    return this.db.prepare("DELETE FROM extensions WHERE id = ?").run(id).changes !== 0;
  }

  servers() { return this.list().filter(entry => entry.enabled).map(entry => entry.extension.server); }
  close() { this.db.close(); }
}

let store: ExtensionStore | undefined;
export function extensionStore() {
  // Misma variable y misma ruta por omisión que la rama `sesion-4-mcp`.
  const path = process.env.ACP_EXTENSIONS_DB || ".data/extensions.db";
  return store ??= new ExtensionStore(path === ":memory:" ? path : resolve(path));
}
