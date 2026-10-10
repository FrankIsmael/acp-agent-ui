/**
 * Translates the descriptions of the template's skills to English on a ghosty-lite box. The
 * `description:` of every `SKILL.md` under `/opt/goose/skills` (symlinked into `~/.claude/skills`
 * on boot) is replaced with the English one in scripts/skill-translations.json, only if it is
 * still the known Spanish original (md5 of the description block). A skill whose description
 * changed upstream is skipped and reported. Bodies stay Spanish; they only enter context when
 * the skill fires. Backup once to `/opt/goose/skills.bak-es.tgz`. Runbook: docs/agent-box.md.
 *
 *   node --env-file=.env scripts/translate-skills.mjs [--box <id>]
 *
 * Idempotent. Tool names, binaries and paths stay verbatim.
 *
 * ⚠️ `/opt` survives reboots, NOT a new box or a template rebake: rerun after recreating it.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { easybitsClient, required } from './lib/easybits.mjs';

const boxFlag = process.argv.indexOf('--box');
const box = required(boxFlag > -1 ? process.argv[boxFlag + 1] : process.env.AGENT_BOX_ID, 'AGENT_BOX_ID (or --box <id>)');
const eb = easybitsClient();

const SKILLS = '/opt/goose/skills';
const SKILL_EN = JSON.parse(readFileSync(new URL('./skill-translations.json', import.meta.url), 'utf8'));

const md5 = buf => createHash('md5').update(buf).digest('hex');
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

console.log(`[skills] checking ${box}…`);
// One exec per changed file (some SKILL.md are 20 KB+).
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
console.log('[skills] done. Open a NEW THREAD: open ones keep the skills they started with.');
