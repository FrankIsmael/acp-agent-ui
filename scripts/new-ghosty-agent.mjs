/**
 * Spins up a ghosty-lite agent with Claude as the provider and updates .env to point to it.
 *
 *   EASYBITS_API_KEY=... CLAUDE_CODE_OAUTH_TOKEN=... node scripts/new-ghosty-agent.mjs [name]
 *   EASYBITS_API_KEY=... ANTHROPIC_API_KEY=...       node scripts/new-ghosty-agent.mjs [name]
 *
 * This is the way back when the box disappears from the host (404 "sandbox not found" with the
 * agent in `lost`; happened on Sep 2 and Sep 12, 2026). Unlike `new-goose-box.mjs`, nothing is
 * installed here: the `ghosty-lite` template already includes the agent and reads provider, model,
 * and credentials from its env on startup.
 *
 * Why Claude and not DeepSeek: with goose/ghosty over any "normal" provider, the MCP client is rmcp
 * and rejects EasyBits's `tools/list` (see ESTADO.md). With `claude-acp` the turn is executed by the
 * Claude Code adapter, which brings its own MCP client and does deliver the tools.
 *
 * Variables:
 *   GHOSTY_PROVIDER   default claude-acp (alternatives: claude-code, anthropic)
 *   GHOSTY_MODEL      default sonnet
 *   GOOSE_MODE        default approve — with claude-acp, goose asks for `bypassPermissions`, which the
 *                     adapter doesn't provide, so each turn fails with a silent Internal error.
 *   ACP_AGENT_TOKEN   default: a random value. It is the `?token=` which the web client uses to connect.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error('missing EASYBITS_API_KEY');
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
if (!OAUTH && !API_KEY)
  throw new Error(
    'missing CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY',
  );

const NAME = process.argv[2] ?? 'Robbie Agent';
const PROVIDER = process.env.GHOSTY_PROVIDER ?? 'claude-acp';
const MODEL = process.env.GHOSTY_MODEL ?? 'sonnet';
const MODE = process.env.GOOSE_MODE ?? 'approve';
const AGENT_TOKEN =
  process.env.ACP_AGENT_TOKEN ?? `agt_${randomBytes(24).toString('hex')}`;

const { EasybitsClient } = await import('@easybits.cloud/sdk');
const eb = new EasybitsClient({ apiKey: KEY });

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const env = {
  GHOSTY_PROVIDER: PROVIDER,
  GHOSTY_MODEL: MODEL,
  GOOSE_MODE: MODE,
  ACP_AGENT_TOKEN: AGENT_TOKEN,
  EASYBITS_API_KEY: KEY,
  ...(OAUTH
    ? { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }
    : { ANTHROPIC_API_KEY: API_KEY }),
};
console.log(
  `creating ${NAME}: ghosty-lite · ${PROVIDER}/${MODEL} · GOOSE_MODE=${MODE} · auth=${OAUTH ? 'oauth' : 'api-key'}`,
);
const created = await eb.createAgent({
  template: 'ghosty-lite',
  name: NAME,
  env,
  timeoutSeconds: 14400,
});
console.log(
  `agent ${created.agentId} in box ${created.sandboxId} (${since()})`,
);

// First thing: do not lose the token. createAgent returns `agentUrl` as `sandbox://…:3000` (a
// marker, not the real URL) and the wss:// URL only appears later in getAgent. If something fails
// later, with this saved in .env you can resume manually; without this, the random token is lost
// (this happened on Sep 12, 2026, and had to be recovered from /etc/ghosty-lite-runtime/.env via exec).
const file = '.env';
let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const set = (name, value) => {
  const line = `${name}=${value}`;
  text = new RegExp(`^${name}=`, 'm').test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${text.replace(/\n?$/, '\n')}${line}\n`;
};
set('AGENT_BOX_ID', created.sandboxId);
set('ACP_SECRET', AGENT_TOKEN);
writeFileSync(file, text, { mode: 0o600 });
console.log('.env: AGENT_BOX_ID and ACP_SECRET saved');

// The actual URL and runtime: call getAgent until agentUrl is wss://, then do the handshake.
// Without token responds 401, with the correct token responds 406 (wants Upgrade);
// 404/502/503 = not listening yet.
let agentUrl = '';
for (let i = 0; i < 90; i++) {
  if (!agentUrl.startsWith('wss://'))
    agentUrl = (await eb.getAgent(created.agentId)).agentUrl ?? '';
  if (agentUrl.startsWith('wss://')) {
    const r = await fetch(
      `${agentUrl.replace(/^wss:/, 'https:')}?token=${AGENT_TOKEN}`,
    ).catch(() => null);
    if (r && ![404, 502, 503].includes(r.status)) {
      if (r.status === 401)
        throw new Error(
          'the agent rejected ACP_AGENT_TOKEN: check /etc/ghosty-lite-runtime/.env in the box',
        );
      console.log(`agent listening (HTTP ${r.status}, ${since()})`);
      break;
    }
  }
  if (i === 89)
    throw new Error(
      `the agent did not start in 3 min (AGENT_BOX_ID=${created.sandboxId}; the token is already in .env)`,
    );
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
set('ACP_WS_URL', agentUrl);
writeFileSync(file, text, { mode: 0o600 });

// The template's own skills (pdf-reader, big-files, office-reader…) live in /opt/goose/skills,
// but each conversation's `~/.claude/skills` points only at /data/agent/skills, so Claude Code
// never sees them (the skills page lists them because it asks goose, not Claude). Linking them
// there makes them visible from the next conversation; /data survives reboots, a new box
// needs it again. A skill the agent already has under the same name is left alone. Until
// sandbox-host's fix/claude-skills-per-conversation ships in the template.
// const LINK_SKILLS = `mkdir -p /data/agent/skills
// for d in /opt/goose/skills/*/; do
//   t=/data/agent/skills/$(basename "$d")
//   [ -e "$t" ] && [ ! -L "$t" ] && continue
//   ln -sfn "\${d%/}" "$t"
// done
// ls /data/agent/skills | wc -l`;
// try {
//   const { easybitsClient } = await import('./lib/easybits.mjs');
//   const count = (await easybitsClient({ apiKey: KEY }).exec(created.sandboxId, LINK_SKILLS)).trim();
//   console.log(`skills: ${count} in /data/agent/skills, visible to Claude Code`);
// } catch (error) {
//   console.error(`skills: could not link them (${error.message}); rerun on the box:\n${LINK_SKILLS}`);
// }

console.log(
  `.env updated (ACP_WS_URL, ACP_SECRET, AGENT_BOX_ID) in ${since()} — restart npm run dev`,
);
