/**
 * Installs the house hints on a ghosty-lite box, in English, with HINTS_BLOCK (the output-format
 * and reply-language rules). The app does NOT send these on every turn nor check they are there:
 * this script is what puts them there. Runbook for a lost box: docs/agent-box.md.
 *
 *   node --experimental-strip-types --env-file=.env scripts/install-hints.mjs [--box <id>]
 *
 * The brain reads three copies (`/data/ghosty/config/.goosehints`, `/data/work/.goosehints`,
 * `/data/work/CLAUDE.md`). `ghosty-prompt-hooks` rebuilds them on every boot from:
 *   /opt/goose/goosehints.md            the baked house prompt → replaced by scripts/house-hints.md
 *   /usr/local/bin/ghosty-prompt-hooks  its `hilos` / disk heredoc and identity header → English
 * so this script edits those two sources and then runs the hooks. Editing the copies is pointless.
 * On an older template without the hooks it falls back to appending HINTS_BLOCK to the copies.
 *
 * Idempotent. The baked file is only replaced if it is the known Spanish original or already
 * English; anything appended after it (e.g. by install-image-mcp) is kept. Otherwise it aborts
 * without writing: the template changed and house-hints.md needs redoing. Originals are backed up
 * once to `*.bak`.
 *
 * Skills: the `description:` of every `SKILL.md` under `/opt/goose/skills` (symlinked into
 * `~/.claude/skills` on boot) is replaced with the English one in scripts/skill-descriptions.json,
 * only if it is still the known Spanish original (md5 of the description block). A skill whose
 * description changed upstream is skipped and reported. Bodies stay Spanish; they only enter
 * context when the skill fires. Backup once to `/opt/goose/skills.bak-es.tgz`.
 *
 * Commands, tool names, paths and the `[TU MODELO: …]` marker stay verbatim. There is no language
 * line in the house prompt on purpose: the rule lives in HINTS_BLOCK (docs/agent-box.md, Reply language).
 *
 * ⚠️ `/opt` survives reboots, NOT a new box or a template rebake: rerun after recreating it.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { easybitsClient, required, shellQuote } from './lib/easybits.mjs';
import { HINTS_BLOCK, HINTS_MARKER } from '../app/.server/artifact-instructions.ts';

const boxFlag = process.argv.indexOf('--box');
const box = required(boxFlag > -1 ? process.argv[boxFlag + 1] : process.env.AGENT_BOX_ID, 'AGENT_BOX_ID (or --box <id>)');
const eb = easybitsClient();

const BAKED = '/opt/goose/goosehints.md';
const HOOKS = '/usr/local/bin/ghosty-prompt-hooks';
const COPIES = [`${process.env.ACP_CWD ?? '/data/work'}/CLAUDE.md`, '/data/ghosty/config/.goosehints'];
// md5 + size of the Spanish baked prompt in the ghosty-lite template (checked 2026-10-09).
const ES_BAKED = { md5: '87c5711d3b5a5ad5c50a5518ee2853f0', bytes: 9929 };
const EN_BAKED = readFileSync(new URL('./house-hints.md', import.meta.url));
const SKILLS = '/opt/goose/skills';
const SKILL_EN = JSON.parse(readFileSync(new URL('./skill-descriptions.json', import.meta.url), 'utf8'));

// The `hilos` / disk paragraph `ghosty-prompt-hooks` appends after the baked prompt.
const HOOKS_HINT = `
## Your memory of this conversation: \`hilos\`

In a long conversation the beginning falls out of your context, but it is still stored. If the
person takes for granted something that was said earlier here and you no longer see it,
**look it up** instead of making it up or saying you don't remember:

\`\`\`bash
hilos grep "palabra clave"      # where it was said, with context
hilos read --tail 10            # the end of this conversation (user/agent, no tools)
\`\`\`

It only reads THIS conversation: other people's conversations are isolated and cannot be seen.
Read \`/opt/goose/skills/hilos/SKILL.md\` if you need more.

## Your disk

Your working folder is your current directory (\`$HOME\`): it belongs to this conversation only,
and what you write there is not visible to any other. The agent's knowledge files are in
\`/data/work/\` (read-only); read them by their absolute path.`;
const IDENTITY_HEADER = `printf '\\n\\n## Who you are (agent identity)\\n\\n' >> "$OUT"`;

const md5 = buf => createHash('md5').update(buf).digest('hex');
const read = async path => {
  const out = (await eb.exec(box, `[ -f ${path} ] && base64 -w0 ${path} || echo MISSING`)).trim();
  return out === 'MISSING' ? null : Buffer.from(out, 'base64');
};

function englishBaked(current) {
  if (!current) throw new Error(`${BAKED} does not exist: is this a ghosty-lite box?`);
  let next;
  if (current.subarray(0, EN_BAKED.length).equals(EN_BAKED)) next = current;
  else if (current.length >= ES_BAKED.bytes && md5(current.subarray(0, ES_BAKED.bytes)) === ES_BAKED.md5) {
    next = Buffer.concat([EN_BAKED, current.subarray(ES_BAKED.bytes)]);
  } else {
    throw new Error(`${BAKED} is neither the known Spanish original nor scripts/house-hints.md: the template changed. Nothing was written.`);
  }
  return next.includes(HINTS_MARKER) ? next : Buffer.concat([next, Buffer.from(HINTS_BLOCK)]);
}

function englishHooks(current) {
  const source = current.toString();
  const heredoc = /(cat >> "\$OUT" <<'HINT'\n)[\s\S]*?(\nHINT\n)/;
  const header = /printf '\\n\\n## [^'\n]*\\n\\n' >> "\$OUT"/;
  if (!heredoc.test(source) || !header.test(source)) {
    throw new Error(`${HOOKS} no longer has the expected HINT heredoc / identity header: the template changed. Nothing was written.`);
  }
  return Buffer.from(source.replace(heredoc, (_, open, close) => open + HOOKS_HINT + close).replace(header, IDENTITY_HEADER));
}

// The `description:` line plus its indented continuation lines, inside the frontmatter.
function descriptionBlock(lines) {
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const start = lines.findIndex((line, i) => i > 0 && i < end && line.startsWith('description:'));
  if (start === -1) return null;
  let stop = start + 1;
  while (stop < end && /^[ \t]/.test(lines[stop])) stop++;
  return { start, stop, raw: lines.slice(start, stop).join('\n') };
}

// Returns the new SKILL.md, or a string saying why it was left alone.
function englishSkill(name, current) {
  const entry = SKILL_EN[name];
  if (!entry) return 'no English description';
  const lines = current.split('\n');
  const block = descriptionBlock(lines);
  if (!block) return 'no description in frontmatter';
  const next = `description: >-\n  ${entry.en}`;
  if (block.raw === next) return 'up to date';
  if (md5(block.raw) !== entry.es) return 'description changed upstream, skipped';
  lines.splice(block.start, block.stop - block.start, ...next.split('\n'));
  return lines.join('\n');
}

console.log(`[hints] checking ${box}…`);
const [bakedNow, hooksNow] = [await read(BAKED), await read(HOOKS)];
const baked = englishBaked(bakedNow);
const hooks = hooksNow && englishHooks(hooksNow);

const write = (path, content, mode) => [
  `cp -n ${path} ${path}.bak`,
  `echo ${content.toString('base64')} | base64 -d > ${path}.new`,
  ...(mode ? [`bash -n ${path}.new`, `chmod ${mode} ${path}.new`] : []),
  `mv ${path}.new ${path}`,
  `echo "written: ${path}"`,
];
const steps = ['set -e'];
steps.push(...(baked.equals(bakedNow) ? [`echo "up to date: ${BAKED}"`] : write(BAKED, baked)));
if (hooks) {
  steps.push(...(hooks.equals(hooksNow) ? [`echo "up to date: ${HOOKS}"`] : write(HOOKS, hooks, '0755')), HOOKS);
} else {
  // Older template: the launcher copies the baked file over the copies on boot; until then, append.
  const b64 = Buffer.from(HINTS_BLOCK).toString('base64');
  for (const file of COPIES) {
    steps.push(`grep -qsF ${shellQuote(HINTS_MARKER)} ${file} || { echo ${b64} | base64 -d >> ${file} && echo "appended: ${file}"; }`);
  }
}
steps.push(`echo "lines with Spanish accents in ${COPIES[0]}: $(grep -cE '[áéíóúñ¿¡«»]' ${COPIES[0]} || true)"`);

console.log((await eb.exec(box, steps.join('\n'))).trim());

// Skills: one exec per changed file (some SKILL.md are 20 KB+).
const listing = await eb.exec(box, `for d in ${SKILLS}/*/; do [ -f "$d/SKILL.md" ] && printf '%s\\t%s\\n' "$(basename "$d")" "$(base64 -w0 "$d/SKILL.md")"; done; true`);
const skills = listing.trim().split('\n').filter(Boolean).map(line => {
  const [name, b64] = line.split('\t');
  return { name, result: englishSkill(name, Buffer.from(b64, 'base64').toString('utf8')) };
});
const changed = skills.filter(skill => skill.result.startsWith('---'));
if (changed.length) await eb.exec(box, `[ -f ${SKILLS}.bak-es.tgz ] || tar czf ${SKILLS}.bak-es.tgz -C /opt/goose skills`);
for (const { name, result } of changed) {
  const path = `${SKILLS}/${name}/SKILL.md`;
  await eb.exec(box, `echo ${Buffer.from(result).toString('base64')} | base64 -d > ${path}.new && mv ${path}.new ${path}`);
}
for (const { name, result } of skills) {
  if (SKILL_EN[name]) console.log(`skill ${name}: ${result.startsWith('---') ? 'translated' : result}`);
}
console.log('[hints] done. Open a NEW THREAD: open ones keep the hints they started with.');
