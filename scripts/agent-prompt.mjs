/**
 * Puts Robbie's system prompt (`scripts/system-prompt.md`) and icon on the EasyBits agent through
 * the agents API. The prompt goes in `replace` mode: it is the whole persona, so the Ghosty
 * house prompt baked into the template is left out.
 *
 * The box's `ghosty-prompt-hooks` would still append its own `hilos` / disk paragraph (in
 * Spanish) after it. That text is in the doc already, so the heredoc that writes it is emptied
 * and the hooks are rerun: CLAUDE.md is then exactly the doc. The API cannot reach that file
 * (`/usr/local/bin` survives reboots, not a new box): it goes through exec. Backup once to `.bak`.
 *
 *   node --env-file=.env scripts/agent-prompt.mjs                 PATCH the agent of AGENT_BOX_ID
 *   node --env-file=.env scripts/agent-prompt.mjs --check         only compare with what is live
 *   node --env-file=.env scripts/agent-prompt.mjs --create <name> POST a new ghosty-lite agent with it
 *
 * The agent is found by AGENT_ID or, failing that, by the agent whose sandbox is AGENT_BOX_ID
 * (the API wants the agent id; `/agents/<sandbox id>/…` answers 500). The icon goes to
 * `/data/work/robbie.png`, the path the prompt tells the agent to open.
 *
 * Takes effect on the next session: open threads keep the prompt they started with.
 */
import { readFileSync } from 'node:fs';
import { easybitsClient, required } from './lib/easybits.mjs';

const PROMPT = readFileSync(new URL('./system-prompt.md', import.meta.url), 'utf8')
  // The leading comment is for whoever edits the file, not for the agent.
  .replace(/^<!--[\s\S]*?-->\s*/, '');
const ICON = readFileSync(new URL('../public/favicon.png', import.meta.url));
const MODE = 'replace';
const API = process.env.EASYBITS_API_URL ?? 'https://www.easybits.cloud/api/v2';
const HOOKS = '/usr/local/bin/ghosty-prompt-hooks';
const HOOKS_HEREDOC = /(cat >> "\$OUT" <<'HINT'\n)[\s\S]*?(\nHINT\n)/;

const eb = easybitsClient();
const flag = name => process.argv.indexOf(name);

async function findAgent() {
  const box = required(process.env.AGENT_BOX_ID, 'AGENT_BOX_ID');
  if (process.env.AGENT_ID) return { agentId: process.env.AGENT_ID, sandboxId: box };
  const body = await eb.request('/agents');
  const agents = Array.isArray(body) ? body : Object.values(body).find(Array.isArray) ?? [];
  const agent = agents.find(a => a.sandboxId === box);
  if (!agent) throw new Error(`No EasyBits agent has the sandbox ${box}. Set AGENT_ID.`);
  return agent;
}

async function uploadIcon(agentId) {
  const response = await fetch(`${API}/agents/${agentId}/files/robbie.png`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${process.env.EASYBITS_API_KEY}`, 'content-type': 'image/png' },
    body: ICON,
  });
  if (!response.ok) throw new Error(`EasyBits PUT /files/robbie.png: HTTP ${response.status}`);
  console.log('icon: /data/work/robbie.png');
}

// Empties the hooks' own paragraph (`cat >> "$OUT" <<'HINT'` then nothing) and reruns them.
async function quietHooks(box) {
  const out = (await eb.exec(box, `[ -f ${HOOKS} ] && base64 -w0 ${HOOKS} || echo MISSING`)).trim();
  if (out === 'MISSING') throw new Error(`${HOOKS} does not exist: is this a ghosty-lite box?`);
  const current = Buffer.from(out, 'base64').toString();
  if (!HOOKS_HEREDOC.test(current)) throw new Error(`${HOOKS} no longer has the HINT heredoc: the template changed. Nothing was written.`);
  const next = current.replace(HOOKS_HEREDOC, (_, open, close) => open.trimEnd() + close);
  const steps = ['set -e'];
  if (next === current) steps.push(`echo "hooks: up to date"`);
  else steps.push(
    `cp -n ${HOOKS} ${HOOKS}.bak`,
    `echo ${Buffer.from(next).toString('base64')} | base64 -d > ${HOOKS}.new`,
    `bash -n ${HOOKS}.new`,
    `chmod 0755 ${HOOKS}.new`,
    `mv ${HOOKS}.new ${HOOKS}`,
    `echo "hooks: own paragraph removed"`,
  );
  steps.push(HOOKS);
  console.log((await eb.exec(box, steps.join('\n'))).trim());
}

async function live(agentId) {
  const { systemPrompt, systemPromptMode } = await eb.request(`/agents/${agentId}/prompt`);
  const same = systemPrompt?.trim() === PROMPT.trim() && systemPromptMode === MODE;
  console.log(`prompt: ${same ? 'up to date' : 'differs'} (live: ${systemPromptMode}, ${systemPrompt?.length ?? 0} chars; repo: ${MODE}, ${PROMPT.length} chars)`);
  return same;
}

if (flag('--create') > -1) {
  const name = required(process.argv[flag('--create') + 1], '--create <name>');
  const agent = await eb.request('/agents', {
    method: 'POST',
    body: { template: 'ghosty-lite', name, env: { SYSTEM_PROMPT: PROMPT, SYSTEM_PROMPT_MODE: MODE } },
    timeoutMs: 300_000,
  });
  console.log(`created ${name}: agentId=${agent.agentId} sandboxId=${agent.sandboxId}`);
  console.log('Set AGENT_BOX_ID / ACP_WS_URL from it (docs/agent-box.md).');
  try {
    await quietHooks(agent.sandboxId);
    await uploadIcon(agent.agentId);
  } catch (error) {
    console.error(`box not ready yet (${error.message}): rerun without --create once it is up.`);
  }
} else {
  const { agentId, sandboxId } = await findAgent();
  console.log(`[prompt] agent ${agentId} (${sandboxId})`);
  if (flag('--check') > -1) {
    process.exitCode = (await live(agentId)) ? 0 : 1;
  } else {
    if (!(await live(agentId))) {
      await eb.request(`/agents/${agentId}`, { method: 'PATCH', body: { systemPrompt: PROMPT, systemPromptMode: MODE } });
      await live(agentId);
    }
    await quietHooks(sandboxId);
    await uploadIcon(agentId);
    console.log('[prompt] done. Open a NEW THREAD: open ones keep the prompt they started with.');
  }
}
