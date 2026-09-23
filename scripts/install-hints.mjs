/**
 * Escribe HINTS_BLOCK (las reglas de formato: artifacts en el chat web, texto plano por canal)
 * en los hints de una caja ghosty-lite. La app ya NO las manda en cada turno ni comprueba que
 * estén: este script es lo que hace que estén.
 *
 *   node --experimental-strip-types --env-file=.env scripts/install-hints.mjs [--box <id>]
 *
 * Toca tres archivos, y el orden importa:
 *   /opt/goose/goosehints.md          la copia HORNEADA — la única que sobrevive a un arranque,
 *                                     porque `ghosty-lite-start` la copia encima de las otras dos
 *   /data/ghosty/config/.goosehints   lo que lee goose (providers que no sean claude-acp)
 *   /data/work/CLAUDE.md              lo que lee el cerebro con claude-acp; el que de verdad manda
 *
 * Idempotente: si la marca ya está, no escribe. Deja `.bak` de la copia horneada la primera vez.
 *
 * ⚠️ `/opt` es el disco de imagen: aguanta reboots, NO una caja nueva ni un rebake del template.
 * En una caja recién creada hay que volver a correrlo (o meter el bloque en el template).
 */
import { easybitsClient, required, shellQuote } from './lib/easybits.mjs';
import { HINTS_BLOCK, HINTS_MARKER } from '../app/.server/artifact-instructions.ts';

const boxFlag = process.argv.indexOf('--box');
const box = required(boxFlag > -1 ? process.argv[boxFlag + 1] : process.env.AGENT_BOX_ID, 'AGENT_BOX_ID (o --box <id>)');
const BAKED = '/opt/goose/goosehints.md';
const COPIES = [process.env.ACP_CWD ? `${process.env.ACP_CWD}/CLAUDE.md` : '/data/work/CLAUDE.md', '/data/ghosty/config/.goosehints'];

const eb = easybitsClient();
const b64 = Buffer.from(HINTS_BLOCK).toString('base64');
const marker = shellQuote(HINTS_MARKER);
// `grep -qs`: silencioso y sin fallar si el archivo no existe. El horneado se respalda una vez
// (`cp -n`) para poder volver al original del template.
const append = file => `if grep -qsF ${marker} ${shellQuote(file)}; then echo "ya estaba: ${file}"; `
  + `else echo ${b64} | base64 -d >> ${shellQuote(file)} && echo "escrito: ${file}"; fi`;

const report = await eb.exec(box, [
  `cp -n ${BAKED} ${BAKED}.bak 2>/dev/null || true`,
  append(BAKED),
  ...COPIES.map(append),
].join('\n'));
process.stdout.write(report);
console.log('\nListo. Las conversaciones NUEVAS ya leen las reglas; las abiertas siguen con lo suyo.');
