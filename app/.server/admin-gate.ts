/**
 * Puerta mínima para lo que sólo debe operar el dueño (hoy: el canal de WhatsApp).
 *
 * No hay usuarios todavía. Mientras llegan, una llave compartida en `WHATSAPP_ADMIN_KEY`:
 * se entra una vez con `/whatsapp?key=<llave>` y queda una cookie HttpOnly (30 días) con un
 * HMAC de la llave —nunca la llave misma—. Las tres rutas del canal la exigen.
 *
 * En producción, sin la variable NO se abre nada: mejor un "configúralo" que un canal de
 * WhatsApp operable por quien tenga el link. En desarrollo, sin variable, pasa todo.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// Según cómo cargue el `.env` quien arranca el proceso, el valor puede llegar con comillas o
// con un `\r` al final: se limpia antes de comparar, y lo mismo con lo que venga en la URL.
const clean = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
const KEY = clean(process.env.WHATSAPP_ADMIN_KEY ?? "");
const PROD = process.env.NODE_ENV === "production";
const COOKIE = "wa_admin";
const MAX_AGE = 30 * 24 * 3600;

const proof = () => createHmac("sha256", KEY).update("wa-admin-v1").digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookie(request: Request) {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return "";
}

export type Gate =
  | { ok: true; setCookie?: string }
  | { ok: false; reason: "unconfigured" | "forbidden" };

/** Comprueba la cookie o la `?key=`. Si la `key` es buena, devuelve la cabecera para sembrar la cookie. */
export function adminGate(request: Request): Gate {
  if (!KEY) return PROD ? { ok: false, reason: "unconfigured" } : { ok: true };
  const expected = proof();
  const key = new URL(request.url).searchParams.get("key");
  if (key !== null) {
    if (!same(clean(key), KEY)) return { ok: false, reason: "forbidden" };
    const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    return { ok: true, setCookie: `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}` };
  }
  return same(cookie(request), expected) ? { ok: true } : { ok: false, reason: "forbidden" };
}

/** Para las rutas de API: lanza la respuesta de error en vez de devolver el veredicto. */
export function requireAdmin(request: Request) {
  const gate = adminGate(request);
  if (!gate.ok) {
    throw new Response(gate.reason === "unconfigured" ? "Falta WHATSAPP_ADMIN_KEY en el servidor" : "Sólo el dueño opera este canal", { status: gate.reason === "unconfigured" ? 503 : 403 });
  }
  return gate;
}
