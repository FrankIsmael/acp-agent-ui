/**
 * Puts `scripts/system-prompt.md` into the running agent, without creating a new one.
 *
 *   node --env-file=.env scripts/update-agent-prompt.mjs           # writes it
 *   node --env-file=.env scripts/update-agent-prompt.mjs --dry-run # only says what would change
 *
 * Through the EasyBits agents API: `GET /agents/:id/prompt` reads the one in force, `PATCH
 * /agents/:id` with `systemPrompt` changes it live (the box rewrites `/data/agent/PROMPT.md` and
 * rebuilds `CLAUDE.md` / `.goosehints`). Conversations opened after this see the new prompt; one
 * already open keeps the one it started with.
 *
 * Variables: EASYBITS_API_KEY, and AGENT_ID or AGENT_BOX_ID (the agent is looked up by its box).
 */
import { readFileSync } from 'node:fs';
import { required } from './lib/easybits.mjs';

const KEY = required(process.env.EASYBITS_API_KEY, 'EASYBITS_API_KEY');
const API = process.env.EASYBITS_API_URL ?? 'https://www.easybits.cloud/api/v2';
const DRY_RUN = process.argv.includes('--dry-run');
const MODE = 'replace';
// Same as new-ghosty-agent.mjs: the leading comment is for whoever edits the file.
const PROMPT = readFileSync(new URL('./system-prompt.md', import.meta.url), 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/, '')
  .trimEnd();

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

let agentId = process.env.AGENT_ID;
if (!agentId) {
  const box = required(process.env.AGENT_BOX_ID, 'AGENT_ID or AGENT_BOX_ID');
  const { agents } = await api('/agents');
  agentId = agents.find((agent) => agent.sandboxId === box)?.agentId;
  if (!agentId) throw new Error(`no agent runs in box ${box}`);
}

const current = await api(`/agents/${agentId}/prompt`);
const before = (current.systemPrompt ?? '').trimEnd();
if (before === PROMPT && current.systemPromptMode === MODE) {
  console.log(`agent ${agentId}: prompt already up to date (${PROMPT.length} chars, ${MODE}).`);
  process.exit(0);
}
const had = new Set(before.split('\n'));
const has = new Set(PROMPT.split('\n'));
const added = PROMPT.split('\n').filter((line) => line && !had.has(line));
const removed = before.split('\n').filter((line) => line && !has.has(line));
console.log(
  `agent ${agentId}: ${before.length} → ${PROMPT.length} chars, +${added.length} / -${removed.length} lines` +
    (current.systemPromptMode === MODE ? '' : `, mode ${current.systemPromptMode} → ${MODE}`),
);
for (const line of removed) console.log(`  - ${line.slice(0, 100)}`);
for (const line of added) console.log(`  + ${line.slice(0, 100)}`);
if (DRY_RUN) process.exit(0);

await api(`/agents/${agentId}`, {
  method: 'PATCH',
  body: { systemPrompt: PROMPT, systemPromptMode: MODE },
});
const after = await api(`/agents/${agentId}/prompt`);
if ((after.systemPrompt ?? '').trimEnd() !== PROMPT)
  throw new Error('the PATCH was accepted but the prompt read back is different');
console.log('Done: new conversations use the new prompt.');
