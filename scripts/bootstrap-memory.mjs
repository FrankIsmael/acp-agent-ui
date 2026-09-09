import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { easybitsClient, required } from './lib/easybits.mjs';
import { skillsBootstrap, gooseStorageBootstrap } from './lib/skills-bootstrap.mjs';
const { values } = parseArgs({ options: { 'goose-service': { type: 'string' }, repository: { type: 'string' }, branch: { type: 'string' }, box: { type: 'string' }, output: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' } } });
if (values.help) console.log('node --env-file=.env scripts/bootstrap-memory.mjs --repository HTTPS_URL [--branch main] [--output FILE] [--goose-service NAME.service] [--apply]');
else {
  const script = 'set -eu\n' + (values['goose-service'] ? gooseStorageBootstrap(values['goose-service']) + '\n' : '') + skillsBootstrap({ repository: required(values.repository ?? process.env.SKILLS_REPO_URL, '--repository / SKILLS_REPO_URL'), branch: values.branch ?? process.env.SKILLS_REPO_BRANCH ?? 'main', cwd: process.env.ACP_CWD ?? '/data/work' });
  if (values.output) await writeFile(values.output, script, { mode: 0o600 });
  if (!values.apply) { if (!values.output) console.log(script); }
  else {
    const eb = easybitsClient();
    const boxId = required(values.box ?? process.env.AGENT_BOX_ID, 'AGENT_BOX_ID');
    const box = await eb.request(`/sandboxes/${encodeURIComponent(boxId)}`);
    const marker = '# acp-ui project skills bootstrap';
    const previous = box.metadata?.eb_boot ?? '';
    const prefix = previous.includes(marker) ? previous.slice(0, previous.indexOf(marker)) : previous;
    const combined = prefix + (prefix ? '\n' : '') + marker + '\n' + script;
    console.log((await eb.exec(boxId, script, 180)).trim());
    await eb.request(`/sandboxes/${encodeURIComponent(boxId)}/bootstrap`, { method: 'POST', body: { script: combined } });
    const saved = await eb.request(`/sandboxes/${encodeURIComponent(boxId)}`);
    if (!saved.metadata?.eb_boot?.includes(marker)) throw new Error('No se pudo verificar el bootstrap guardado.');
    console.log('Bootstrap guardado; verificar eb_boot_last, eb_boot_exit y eb_boot_err en el próximo despertar.');
  }
}
