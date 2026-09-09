import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { easybitsClient, pythonCommand, required } from './lib/easybits.mjs';
import { restoreDatabase } from './lib/session-database.mjs';

export async function restoreSessions({ eb, boxId, database, service, fileId, sha256 = '', force = false }) {
  const file = await eb.request(`/files/${encodeURIComponent(fileId)}`);
  const readUrl = required(file.readUrl, 'readUrl');
  return JSON.parse(await eb.exec(boxId, pythonCommand(restoreDatabase, [readUrl, database, service, String(force), sha256]), 360));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { box: { type: 'string' }, database: { type: 'string' }, service: { type: 'string' }, 'file-id': { type: 'string' }, manifest: { type: 'string' }, force: { type: 'boolean', default: false }, help: { type: 'boolean' } } });
  if (values.help) console.log('node --env-file=.env scripts/restore-sessions.mjs --box NEW_BOX --database PATH --service NAME.service (--manifest PATH | --file-id ID) [--force]');
  else {
    const manifest = values.manifest ? JSON.parse(await readFile(values.manifest, 'utf8')) : null;
    if (manifest && (manifest.version !== 1 || !manifest.uploaded)) throw new Error('El manifiesto no contiene un respaldo subido y válido.');
    console.log(JSON.stringify(await restoreSessions({ eb: easybitsClient(), boxId: required(values.box ?? process.env.AGENT_BOX_ID, '--box'), database: required(values.database ?? process.env.SESSION_DB_PATH, '--database'), service: required(values.service ?? process.env.AGENT_SERVICE, '--service'), fileId: required(values['file-id'] ?? manifest?.fileId, '--file-id / --manifest'), sha256: manifest?.sha256, force: values.force })));
  }
}
