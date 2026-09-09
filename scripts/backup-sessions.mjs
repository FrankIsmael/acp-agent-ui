import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { easybitsClient, pythonCommand, required } from './lib/easybits.mjs';
import { backupDatabase, uploadDatabase } from './lib/session-database.mjs';

export async function backupSessions({ eb, boxId, database, manifestPath }) {
  const snapshot = JSON.parse(await eb.exec(boxId, pythonCommand(backupDatabase, [database])));
  const created = await eb.request('/files', { method: 'POST', body: {
    fileName: `sessions-${new Date().toISOString().replaceAll(':', '-')}.db`, contentType: 'application/vnd.sqlite3', size: snapshot.size, access: 'private',
  } });
  const fileId = required(created.file?.id, 'file.id');
  required(created.putUrl, 'putUrl');
  const manifest = { version: 1, fileId, boxId, database, createdAt: new Date().toISOString(), size: snapshot.size, sha256: snapshot.sha256, sessions: snapshot.sessions, messages: snapshot.messages, uploaded: false };
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  // Guarda fileId ANTES de subir: incluso un upload fallido queda rastreable.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await eb.exec(boxId, pythonCommand(uploadDatabase, [snapshot.path, created.putUrl]), 330);
  manifest.uploaded = true;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  // Borra solo el temporal que acaba de crear este proceso; nunca la base viva.
  // El upload ya terminó y el manifiesto ya es válido, así que un fallo de
  // limpieza no debe convertir un respaldo correcto en uno aparentemente roto.
  try {
    await eb.exec(
      boxId,
      pythonCommand(
        'import pathlib, sys\np=pathlib.Path(sys.argv[1]); p.unlink(missing_ok=True)\ntry: p.parent.rmdir()\nexcept OSError: pass',
        [snapshot.path],
      ),
    );
  } catch {
    // La carpeta temporal tiene permisos 0700 y no contiene credenciales.
  }
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { box: { type: 'string' }, database: { type: 'string' }, manifest: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('node --env-file=.env scripts/backup-sessions.mjs --database /data/ghosty/data/sessions/sessions.db [--box ID] [--manifest PATH]');
  else {
    const manifestPath = resolve(values.manifest ?? `.memory-backups/${Date.now()}.json`);
    const result = await backupSessions({ eb: easybitsClient(), boxId: required(values.box ?? process.env.AGENT_BOX_ID, 'AGENT_BOX_ID / --box'), database: required(values.database ?? process.env.SESSION_DB_PATH, 'SESSION_DB_PATH / --database'), manifestPath });
    console.log(JSON.stringify({ fileId: result.fileId, manifestPath, sessions: result.sessions, messages: result.messages, size: result.size }));
  }
}
