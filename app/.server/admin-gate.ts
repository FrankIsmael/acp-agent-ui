/**
 * Minimum gate for actions that only the owner should operate (currently: the WhatsApp channel).
 *
 * There are no users yet. Until there are, a shared key in `WHATSAPP_ADMIN_KEY`:
 * you enter once with `/whatsapp?key=<key>` and receive an HttpOnly cookie (30 days)
 * with an HMAC of the key — never the key itself. The three channel routes require it.
 *
 * In production, if the variable is NOT set, nothing opens: better a "configure it"
 * than a WhatsApp channel operable by anyone with the link. In development, without
 * the variable, everything passes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// Depending on how the process loads `.env`, the value may arrive with quotes or
// with a trailing `\r`: it gets cleaned before comparing, same for what comes in the URL.
const clean = (value: string) =>
  value
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
const KEY = clean(process.env.WHATSAPP_ADMIN_KEY ?? '');
const PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'wa_admin';
const MAX_AGE = 30 * 24 * 3600;

const proof = () =>
  createHmac('sha256', KEY).update('wa-admin-v1').digest('hex');
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookie(request: Request) {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

export type Gate =
  | { ok: true; setCookie?: string }
  | { ok: false; reason: 'unconfigured' | 'forbidden' };

/** Checks the cookie or the `?key=` param. If the `key` is valid, returns the header to set the cookie. */
export function adminGate(request: Request): Gate {
  if (!KEY) return PROD ? { ok: false, reason: 'unconfigured' } : { ok: true };
  const expected = proof();
  const key = new URL(request.url).searchParams.get('key');
  if (key !== null) {
    if (!same(clean(key), KEY)) return { ok: false, reason: 'forbidden' };
    const secure =
      new URL(request.url).protocol === 'https:' ||
      request.headers.get('x-forwarded-proto') === 'https';
    return {
      ok: true,
      setCookie: `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    };
  }
  return same(cookie(request), expected)
    ? { ok: true }
    : { ok: false, reason: 'forbidden' };
}

/** For API routes: throws an error response instead of returning the verdict. */
export function requireAdmin(request: Request) {
  const gate = adminGate(request);
  if (!gate.ok) {
    throw new Response(
      gate.reason === 'unconfigured'
        ? 'Missing WHATSAPP_ADMIN_KEY in the server'
        : 'Only the owner can operate this channel',
      { status: gate.reason === 'unconfigured' ? 503 : 403 },
    );
  }
  return gate;
}
