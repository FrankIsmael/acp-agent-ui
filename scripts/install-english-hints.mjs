/**
 * Replaces the Spanish house hints on the agent box with the English ones in `box/`:
 *
 *   /opt/goose/goosehints.md          ← box/goosehints.md (the baked house prompt)
 *   /usr/local/bin/ghosty-prompt-hooks ← box/ghosty-prompt-hooks (only its `hilos` / disk
 *                                        heredoc and the identity header are translated)
 *
 * then runs `ghosty-prompt-hooks`, which regenerates the three copies the brain reads
 * (`/data/ghosty/config/.goosehints`, `/data/work/.goosehints`, `/data/work/CLAUDE.md`).
 * Editing those copies directly is pointless: the hooks rewrite them on every boot.
 *
 * Commands, tool names, paths and the `[TU MODELO: …]` marker are kept verbatim. The old
 * "reply in the language… and use tú" line is dropped on purpose: the reply-language rule
 * lives in HINTS_BLOCK (see docs/spanish-replies.md).
 *
 * Safety: each file is only replaced if it is the known Spanish original (or already English).
 * Blocks appended to the baked file after it (install-hints, install-image-mcp) are kept.
 * Anything else aborts — the template changed and the translation needs redoing.
 * Originals are backed up once to `/opt/goose/*.bak-es`.
 *
 * ⚠️ `/opt` survives reboots, NOT a new box or a template rebake: rerun after recreating it.
 *
 *   node --env-file=.env scripts/install-english-hints.mjs [--box <id>]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { easybitsClient, required } from './lib/easybits.mjs';

const boxFlag = process.argv.indexOf('--box');
const box = required(boxFlag > -1 ? process.argv[boxFlag + 1] : process.env.AGENT_BOX_ID, 'AGENT_BOX_ID (or --box <id>)');
const eb = easybitsClient();

const BAKED = '/opt/goose/goosehints.md';
const HOOKS = '/usr/local/bin/ghosty-prompt-hooks';
// md5 + size of the Spanish originals in the ghosty-lite template (checked 2026-10-08).
const ES_BAKED = { md5: '6f578c4de21a171d55000e21afe2c7d4', bytes: 9884 };
const ES_HOOKS = { md5: 'e2abf8c55b92cb33264a3bc4ca65a421', bytes: 3813 };

const local = name => readFileSync(new URL(`../box/${name}`, import.meta.url));
const enBaked = local('goosehints.md');
const enHooks = local('ghosty-prompt-hooks');
const md5 = buf => createHash('md5').update(buf).digest('hex');
const remote = async path => Buffer.from((await eb.exec(box, `base64 -w0 ${path}`)).trim(), 'base64');

// Returns the new content, null if already English, or throws if the file is unknown.
function translate(path, current, es, en) {
  if (current.subarray(0, en.length).equals(en)) return null;
  if (current.length >= es.bytes && md5(current.subarray(0, es.bytes)) === es.md5) {
    return Buffer.concat([en, current.subarray(es.bytes)]);
  }
  throw new Error(`${path} is neither the known Spanish original nor the English one: the template changed. Nothing was written.`);
}

console.log(`[hints-en] checking ${box}…`);
const baked = translate(BAKED, await remote(BAKED), ES_BAKED, enBaked);
const hooks = translate(HOOKS, await remote(HOOKS), ES_HOOKS, enHooks);

const steps = ['set -e'];
if (baked) {
  steps.push(
    `cp -n ${BAKED} ${BAKED}.bak-es`,
    `echo ${baked.toString('base64')} | base64 -d > ${BAKED}.new && mv ${BAKED}.new ${BAKED}`,
    `echo "translated: ${BAKED}"`,
  );
} else steps.push(`echo "already English: ${BAKED}"`);
if (hooks) {
  steps.push(
    `cp -n ${HOOKS} /opt/goose/ghosty-prompt-hooks.bak-es`,
    `echo ${hooks.toString('base64')} | base64 -d > ${HOOKS}.new`,
    `bash -n ${HOOKS}.new`,
    `chmod 0755 ${HOOKS}.new && mv ${HOOKS}.new ${HOOKS}`,
    `echo "translated: ${HOOKS}"`,
  );
} else steps.push(`echo "already English: ${HOOKS}"`);
steps.push(
  HOOKS,
  `echo "lines with Spanish accents in CLAUDE.md: $(grep -cE '[áéíóúñ¿¡«»]' /data/work/CLAUDE.md || true)"`,
);

console.log((await eb.exec(box, steps.join('\n'))).trim());
console.log('[hints-en] done. Open a NEW THREAD: open ones keep the hints they started with.');
