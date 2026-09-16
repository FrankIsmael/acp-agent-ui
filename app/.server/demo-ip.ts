/** Persistent demo rate limits. The server adapter overwrites x-demo-client-ip. */
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";

type Bucket = "guests" | "chat" | "whatsapp" | "api";
const policies: Record<Bucket, [string, number, number]> = {
  guests: ["DEMO_IP_GUEST_LIMIT", 3, 86400],
  chat: ["DEMO_IP_CHAT_LIMIT", 10, 60],
  whatsapp: ["DEMO_IP_WHATSAPP_LIMIT", 5, 3600],
  api: ["DEMO_IP_API_LIMIT", 120, 60],
};
const initialized = new WeakSet<DatabaseSync>();
function initialize(db: DatabaseSync) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS demo_ip_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_ip_limits (
      ip_key TEXT NOT NULL, bucket TEXT NOT NULL, hits INTEGER NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY (ip_key, bucket)
    ); CREATE INDEX IF NOT EXISTS demo_ip_expiry ON demo_ip_limits(expires);`);
  db.prepare("INSERT OR IGNORE INTO demo_ip_meta VALUES ('salt', ?)").run(randomBytes(32).toString("hex"));
  initialized.add(db);
}

/** IPv4-mapped addresses share IPv4 limits; IPv6 uses /64 to cover privacy-address rotation. */
export function normalizeDemoIp(value: string) {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes("%")) throw new Response("No pude identificar la conexión.", { status: 503 });
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const parts = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left).map(x => parseInt(x, 16));
  if (parts.slice(0, 5).every(x => x === 0) && parts[5] === 65535) return [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255].join(".");
  return parts.slice(0, 4).map(x => x.toString(16)).join(":") + "::/64";
}

export function consumeDemoIp(db: DatabaseSync, request: Request, bucket: Bucket, now = Date.now()) {
  const ip = normalizeDemoIp(request.headers.get("x-demo-client-ip") ?? "");
  const [name, fallback, seconds] = policies[bucket];
  const limit = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid ${name}`);
  initialize(db);
  const salt = (db.prepare("SELECT value FROM demo_ip_meta WHERE key = 'salt'").get() as { value: string }).value;
  const key = createHmac("sha256", salt).update(ip).digest("hex");
  // Atomic fixed window beginning with the first accepted request; no midnight boundary burst.
  const row = db.prepare(`INSERT INTO demo_ip_limits(ip_key, bucket, hits, expires) VALUES (?, ?, 1, ?)
    ON CONFLICT(ip_key, bucket) DO UPDATE SET
      hits = CASE WHEN expires <= ? THEN 1 ELSE hits + 1 END,
      expires = CASE WHEN expires <= ? THEN excluded.expires ELSE expires END
    WHERE expires <= ? OR hits < ? RETURNING expires`).get(key, bucket, now + seconds * 1000, now, now, now, limit);
  if (row) {
    db.prepare("DELETE FROM demo_ip_limits WHERE expires <= ?").run(now);
    return;
  }
  const denied = db.prepare("SELECT expires FROM demo_ip_limits WHERE ip_key = ? AND bucket = ?").get(key, bucket) as { expires: number };
  const retry = Math.max(1, Math.ceil((denied.expires - now) / 1000));
  const message = bucket === "guests"
    ? "Esta red llegó al límite de demos nuevas. Intenta más tarde o contacta a Ismael: ismaelfcom93@gmail.com."
    : "Hay demasiadas solicitudes desde esta red. Intenta más tarde o contacta a Ismael: ismaelfcom93@gmail.com.";
  const headers = { "Retry-After": String(retry), "Cache-Control": "private, no-store" };
  if (request.headers.get("accept")?.includes("text/html")) {
    throw new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Límite de demo</title><main><h1>Límite de demo</h1><p>${message}</p><p>Puedes volver a intentarlo en ${Math.ceil(retry / 60)} minutos.</p><a href="mailto:ismaelfcom93@gmail.com">Contactar a Ismael</a></main></html>`, { status: 429, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  throw Response.json({ error: message, code: "DEMO_IP_LIMIT", retryAfter: retry }, { status: 429, headers });
}
