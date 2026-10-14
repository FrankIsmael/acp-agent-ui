import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { easybitsClient, pythonCommand, required } from './lib/easybits.mjs';
import {
  backupDatabase,
  detectDatabase,
  knownDatabases,
  uploadDatabase,
} from './lib/session-database.mjs';

/** If SESSION_DB_PATH is not set, try to find the database among known paths; if there are two candidates we can't guess. */
export async function detectSessionDatabase({ eb, boxId }) {
  const found = JSON.parse(
    await eb.exec(boxId, pythonCommand(detectDatabase, knownDatabases)),
  );
  if (found.length === 1) return found[0];
  if (found.length === 0)
    throw new Error(
      `No session database found in the box. Tried paths: ${knownDatabases.join(', ')}`,
    );
  throw new Error(
    `More than one session database found (${found.join(', ')}). Specify one with --database or SESSION_DB_PATH.`,
  );
}

export async function backupSessions({ eb, boxId, database, manifestPath }) {
  database ??= await detectSessionDatabase({ eb, boxId });
  const snapshot = JSON.parse(
    await eb.exec(boxId, pythonCommand(backupDatabase, [database])),
  );
  const created = await eb.request('/files', {
    method: 'POST',
    body: {
      fileName: `sessions-${new Date().toISOString().replaceAll(':', '-')}.db`,
      contentType: 'application/vnd.sqlite3',
      size: snapshot.size,
      access: 'private',
    },
  });
  const fileId = required(created.file?.id, 'file.id');
  required(created.putUrl, 'putUrl');
  const manifest = {
    version: 1,
    fileId,
    boxId,
    database,
    createdAt: new Date().toISOString(),
    size: snapshot.size,
    sha256: snapshot.sha256,
    sessions: snapshot.sessions,
    messages: snapshot.messages,
    uploaded: false,
  };
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  // Save fileId BEFORE upload: even a failed upload is traceable.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await eb.exec(
    boxId,
    pythonCommand(uploadDatabase, [snapshot.path, created.putUrl]),
    330,
  );
  manifest.uploaded = true;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
  // Remove only the temporary just created by this process; never the live database.
  // The upload has already finished and the manifest is already valid, so a
  // cleanup failure should not change a correct backup into an apparently broken one.
  try {
    await eb.exec(
      boxId,
      pythonCommand(
        'import pathlib, sys\np=pathlib.Path(sys.argv[1]); p.unlink(missing_ok=True)\ntry: p.parent.rmdir()\nexcept OSError: pass',
        [snapshot.path],
      ),
    );
  } catch {
    // The temp folder has 0700 permissions and does not contain credentials.
  }
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      box: { type: 'string' },
      database: { type: 'string' },
      manifest: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      'node --env-file=.env scripts/backup-sessions.mjs [--database /data/ghosty/data/sessions/sessions.db] [--box ID] [--manifest PATH]',
    );
  else {
    const manifestPath = resolve(
      values.manifest ?? `.memory-backups/${Date.now()}.json`,
    );
    const result = await backupSessions({
      eb: easybitsClient(),
      boxId: required(
        values.box ?? process.env.AGENT_BOX_ID,
        'AGENT_BOX_ID / --box',
      ),
      database: values.database || process.env.SESSION_DB_PATH || undefined,
      manifestPath,
    });
    console.log(
      JSON.stringify({
        fileId: result.fileId,
        database: result.database,
        manifestPath,
        sessions: result.sessions,
        messages: result.messages,
        size: result.size,
      }),
    );
  }
}
