export function easybitsClient({ apiKey = process.env.EASYBITS_API_KEY, api = process.env.EASYBITS_API_URL ?? 'https://www.easybits.cloud/api/v2' } = {}) {
  if (!apiKey) throw new Error('Falta EASYBITS_API_KEY. La llave solo se usa fuera de la caja.');
  async function request(path, { method = 'GET', body, timeoutMs = 90_000 } = {}) {
    const response = await fetch(api + path, {
      method, headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`EasyBits ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    return response.status === 204 ? {} : response.json();
  }
  async function exec(id, command, timeoutSeconds = 120) {
    const result = await request(`/sandboxes/${encodeURIComponent(id)}/exec`, { method: 'POST', body: { command, timeoutSeconds }, timeoutMs: (timeoutSeconds + 30) * 1000 });
    if (result.exitCode !== 0) throw new Error(`El comando remoto falló (exit ${result.exitCode}). ${String(result.stderr ?? '').split('\n').filter(line => /^(ERROR:|RuntimeError:|ValueError:|FileExistsError:|FileNotFoundError:)/.test(line)).join(' ').slice(0, 300)}`);
    return result.stdout ?? '';
  }
  return { request, exec };
}
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function pythonCommand(source, args = []) { return `python3 - ${args.map(shellQuote).join(' ')} <<'ACP_MEMORY_PY'\n${source}\nACP_MEMORY_PY`; }
export function required(value, name) { if (!value) throw new Error(`Falta ${name}`); return value; }
