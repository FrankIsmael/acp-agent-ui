// OAuth2 Client (authorization_code + PKCE) for the Ghosty Studio API.
// Usage: GHOSTY_CLIENT_ID=… node scripts/ghosty-oauth.ts login | me
// The redirect_uri must be registered exactly as is in Ghosty (exact match).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'https://www.ghosty.studio';
const CLIENT_ID = process.env.GHOSTY_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GHOSTY_CLIENT_SECRET; // confidential clients only
const REDIRECT_URI =
  process.env.GHOSTY_REDIRECT_URI ?? 'http://127.0.0.1:8787/callback';
const SCOPE = process.env.GHOSTY_SCOPE ?? 'profile agents:read agents:write';
const STORE = process.env.GHOSTY_TOKEN_STORE ?? '.data/ghosty-oauth.json';

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
};

const b64url = (buf: Buffer) => buf.toString('base64url');

async function load(): Promise<Tokens | null> {
  try {
    return JSON.parse(await readFile(STORE, 'utf8'));
  } catch {
    return null;
  }
}

// Atomic write: refresh token rotates each use and losing the new one leaves the session revoked.
async function save(t: Tokens) {
  await mkdir(dirname(STORE), { recursive: true });
  const tmp = `${STORE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(t, null, 1), { mode: 0o600 });
  await rename(tmp, STORE);
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params });
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
  const res = await fetch(`${BASE}/oauth2/token`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `oauth2/token ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim(),
    );
  const t = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    scope: json.scope,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  await save(t);
  return t;
}

export async function login(): Promise<Tokens> {
  if (!CLIENT_ID) throw new Error('missing GHOSTY_CLIENT_ID');
  const verifier = b64url(randomBytes(48)); // 64 characters
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const redirect = new URL(REDIRECT_URI);
  const authorize = new URL(`${BASE}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const ok =
        !err &&
        url.searchParams.get('state') === state &&
        url.searchParams.get('code');
      res
        .writeHead(ok ? 200 : 400, {
          'Content-Type': 'text/plain; charset=utf-8',
        })
        .end(ok ? 'Done, you can now close this tab.' : 'Login failed.');
      server.close();
      clearTimeout(timer);
      ok
        ? resolve(ok)
        : reject(new Error(err ? `authorize: ${err}` : 'state does not match'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timeout waiting for login'));
    }, 5 * 60_000);
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.error(`Open this link to log in:\n${authorize}`);
      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      spawn(opener, [authorize.toString()], { stdio: 'ignore', detached: true })
        .on('error', () => {})
        .unref();
    });
  });
  // The code is valid for 60 s: it is exchanged as soon as it arrives.
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

// Only one refresh in flight: two in parallel would reuse an already rotated refresh, and Ghosty would revoke the whole family.
let refreshing: Promise<Tokens> | null = null;
function refresh(t: Tokens) {
  refreshing ??= tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function getAccessToken(force = false): Promise<string> {
  const t = await load();
  if (!t)
    throw new Error('not logged in: run `node scripts/ghosty-oauth.ts login`');
  if (!force && t.expires_at - 60_000 > Date.now()) return t.access_token;
  return (await refresh(t)).access_token;
}

// fetch against /api/v2 with Bearer; on 401 refreshes and retries once (403 = missing scope, do not retry).
export async function ghostyFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const call = async (token: string) =>
    fetch(new URL(path, BASE), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  const res = await call(await getAccessToken());
  return res.status === 401 ? call(await getAccessToken(true)) : res;
}

export async function logout() {
  const t = await load();
  if (!t) return;
  const body = new URLSearchParams({
    token: t.refresh_token,
    token_type_hint: 'refresh_token',
    client_id: CLIENT_ID,
  });
  await fetch(`${BASE}/oauth2/revoke`, { method: 'POST', body });
  await rm(STORE, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'login') {
    const t = await login();
    console.log(JSON.stringify({ ok: true, scope: t.scope, store: STORE }));
  } else if (cmd === 'me') {
    const res = await ghostyFetch('/api/v2/me/agents');
    console.log(res.status, JSON.stringify(await res.json(), null, 1));
  } else if (cmd === 'logout') {
    await logout();
    console.log(JSON.stringify({ ok: true }));
  } else {
    console.error('usage: node scripts/ghosty-oauth.ts login | me | logout');
    process.exit(2);
  }
}
