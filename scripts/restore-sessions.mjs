/**
 node --env-file=.env scripts/restore-sessions.mjs \
  --box <ID_DE_LA_CAJA_NUEVA> \
  --database /data/ghosty/data/sessions/sessions.db \
  --service ghosty-lite-runtime.service \
  --manifest .memory-backups/1789664622813.json

What each flag means and where to get it:

- --box — the sandbox you're restoring into. Omit it and it falls back to AGENT_BOX_ID from .env, i.e. your current prod box. Only do that if you really mean to overwrite prod.
- --database — required (no auto-detect here: a new box has nothing to detect). /data/ghosty/data/sessions/sessions.db for Ghosty Lite, /data/state/goose/sessions/sessions.db for goose manual. Defaults to SESSION_DB_PATH from .env.
- --service — the agent's systemd unit; the script stops it before swapping the file and restarts it after. ghosty-lite-runtime.service for your template (AGENT_SERVICE in .env).
- --manifest — the JSON the backup wrote; it supplies the fileId and the SHA-256, so the download is verified. Alternative without the manifest: --file-id 6aac1d6f31cb0fb8e921072d (no checksum then).
 */


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
