#!/usr/bin/env node
/**
 * Operate the app's EasyBits box in place. Never creates a new machine.
 *
 *   npm run redeploy                          full deploy: git + build + release + restart
 *   npm run redeploy -- --restart             restart only (no new code)
 *   npm run redeploy -- --secret FOO=bar      set/add an env var (restarts by itself)
 *   npm run redeploy -- --secret FOO          take the value from this shell's env / .env
 *   npm run redeploy -- --unset FOO           stop injecting an env var
 *   npm run redeploy -- --secrets             list the env var NAMES the box uses
 *   add --dry-run to any of them
 *
 * Which one do you need?
 *   code changed ................ full deploy. A restart alone does not bring new code.
 *   only an env var ............. --secret. No git, no build, no deploy_machine.
 *   changed nothing, stuck app .. --restart.
 *
 * `set_machine_secrets` stores the value in the account vault, wires the NAME into the
 * machine runspec (so a brand-new variable needs no extra step) and restarts the process by
 * itself — seconds, no build. Values can never be read back, so `--secrets` lists names only.
 *
 * ⚠️ `launch_app` with `repo` is NOT used: it creates a new machine on every deploy, and the
 * live domain is mapped to this one. Skipping `npm ci` makes a commit that adds packages boot
 * with ERR_MODULE_NOT_FOUND (15 sep).
 *
 * Env: EASYBITS_API_KEY (required), APP_BOX_ID and APP_URL override the defaults below.
 */
import { easybitsClient, required, shellQuote } from './lib/easybits.mjs';

const URL_APP = 'https://acp-agent.ismaelfrancisco.tech';
const BASE = (process.env.EASYBITS_BASE_URL ?? 'https://www.easybits.cloud').replace(/\/+$/, '');
const MCP = `${BASE}/api/mcp?tools=sandbox,hosting,fleet`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] ?? true) : fallback;
};
const has = name => argv.includes(`--${name}`);
/** Every --name occurrence, so --secret can be repeated. */
const all = name => argv.flatMap((token, i) => (token === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));

const box = required(flag('box', process.env.APP_BOX_ID ?? ''), 'APP_BOX_ID (or --box <id>)');
const url = process.env.APP_URL ?? URL_APP;
const dry = has('dry-run');
const apiKey = required(process.env.EASYBITS_API_KEY, 'EASYBITS_API_KEY');
const eb = easybitsClient({ apiKey });

let step = 0;
const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = text => console.log(`[${String(++step).padStart(2, '0')}] ${text}`);

/** Streamable HTTP MCP in one shot: these tools need no session, the reply is one SSE frame. */
async function mcp(name, args, secret = false) {
  if (dry) return console.log(`     (dry-run) ${name} ${secret ? '{…redacted…}' : JSON.stringify(args)}`), {};
  const response = await fetch(MCP, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`MCP ${name}: HTTP ${response.status}`);
  const body = await response.text();
  const frame = body.split('\n').filter(l => l.startsWith('data: ')).pop();
  const payload = JSON.parse((frame ?? body).replace(/^data: /, ''));
  if (payload.error) throw new Error(`MCP ${name}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  const result = payload.result ?? {};
  if (result.isError) throw new Error(`MCP ${name}: ${result.content?.map(c => c.text).join(' ') ?? 'tool reported an error'}`);
  const text = result.content?.map(c => c.text).join('\n') ?? '';
  try { return JSON.parse(text); } catch { return { text }; }
}

const run = async (command, seconds) => (dry ? console.log(`     (dry-run) ${command}`) || '' : eb.exec(box, command, seconds));

/** The box answers before the service does, so never trust the restart call alone. */
async function waitForApp(budgetMs = 120_000) {
  say(`waiting for ${url}`);
  if (dry) return;
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const probe = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (probe.status < 500) return console.log(`     HTTP ${probe.status} after ${since()}`);
      if (Date.now() > deadline) throw new Error(`still HTTP ${probe.status}`);
    } catch (error) {
      if (Date.now() > deadline) {
        console.error(`\n✗ ${url} did not come back: ${error.message}`);
        console.error(`  logs:     node --env-file=.env -e "import('./scripts/lib/easybits.mjs').then(m => m.easybitsClient().exec(${shellQuote(box)}, 'tail -50 /var/log/easybits-app.log').then(console.log))"`);
        console.error('  rollback: MCP rollback_machine { sandboxId, releaseId } — list_machine_releases has the ids');
        process.exit(1);
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(2000 * attempt, 8000)));
  }
}

const secrets = all('secret');
const unsets = all('unset');
const mode = has('secrets') ? 'list-secrets' : secrets.length || unsets.length ? 'secrets' : has('restart') ? 'restart' : 'deploy';

console.log(`${mode} · ${box}\n${' '.repeat(mode.length)}   ${url}${dry ? '   (dry run: nothing is changed)' : ''}\n`);

if (mode === 'list-secrets') {
  // Names only: a stored value is never readable again, not even by its owner.
  const result = await mcp('list_machine_secrets', { sandboxId: box });
  console.log(`injected into the app (${result.secretNames?.length ?? 0}):`);
  for (const name of result.secretNames ?? []) console.log(`  ${name}`);
  const spare = (result.inVault ?? []).filter(name => !(result.secretNames ?? []).includes(name));
  if (spare.length) console.log(`\nin the account vault but NOT wired to this machine (${spare.length}):\n  ${spare.join('\n  ')}`);
  process.exit(0);
}

if (mode === 'secrets') {
  // NAME=value, or bare NAME to take it from this process's env (so it can come from .env).
  const payload = {};
  for (const entry of secrets) {
    const at = entry.indexOf('=');
    const name = at > -1 ? entry.slice(0, at) : entry;
    const value = at > -1 ? entry.slice(at + 1) : process.env[name];
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Secret names must be UPPER_SNAKE: ${name}`);
    if (value === undefined || value === '') throw new Error(`No value for ${name}. Use --secret ${name}=value, or export ${name} first.`);
    payload[name] = value;
  }
  // One call for all of them: it is accumulative and restarts once at the end.
  if (Object.keys(payload).length) {
    say(`set_machine_secrets: ${Object.keys(payload).join(', ')}`);
    const result = await mcp('set_machine_secrets', { sandboxId: box, secrets: payload }, true);
    console.log(`     stored, wired into the runspec${result.restarted === false ? ', restart PENDING' : ' and restarted'}`);
  }
  for (const name of unsets) {
    say(`unset_machine_secret: ${name}`);
    await mcp('unset_machine_secret', { sandboxId: box, name });
    console.log('     no longer injected (the value stays in the vault)');
  }
  await waitForApp();
  console.log(`\n✓ done in ${since()}. New code still needs a full deploy — this only changed the environment.`);
  process.exit(0);
}

if (mode === 'restart') {
  say('restart_machine');
  await mcp('restart_machine', { sandboxId: box });
  await waitForApp();
  console.log(`\n✓ back in ${since()}. Same code as before: a restart does not pull anything.`);
  process.exit(0);
}

// ── full deploy ───────────────────────────────────────────────────────────────
const message = flag('message', `redeploy ${new Date().toISOString()}`);

// 1 — the commit. `checkout -B` is used over `git pull` so a diverged branch does not merge.
say('git fetch + checkout origin/main');
const head = await run('cd /app && git fetch -q origin main && git checkout -q -B main origin/main && git log -1 --format="%h %s"', 180);
console.log(`     ${head.trim() || '(dry run)'}`);

// 2 — deps then build. `npm ci` falls back to `install` when the lockfile is out of step.
if (has('skip-build')) say('build skipped (--skip-build)');
else {
  say('npm ci || npm install, then npm run build');
  const build = await run('cd /app && (npm ci || npm install) && npm run build 2>&1 | tail -5', 900);
  console.log(build.split('\n').filter(Boolean).map(l => `     ${l}`).join('\n'));
}

// 3 — the release, so a bad deploy can be rolled back with rollback_machine.
say(`deploy_machine ("${message}")`);
await mcp('deploy_machine', { sandboxId: box, message: String(message) });

// 4 — the service reads .easybits.env once at boot; only a restart picks up code and secrets.
say('restart_machine');
await mcp('restart_machine', { sandboxId: box });

await waitForApp();
console.log(`\n✓ live in ${since()}. Open conversations reconnect by themselves; the ACP engine is process state, so in-flight turns are lost.`);
