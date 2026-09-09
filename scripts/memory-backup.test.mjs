import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { backupSessions } from './backup-sessions.mjs';
import { restoreSessions } from './restore-sessions.mjs';
import { skillsBootstrap } from './lib/skills-bootstrap.mjs';
const run = promisify(execFile);

test('WAL-safe backup, private upload manifest, guarded restore, checksum, service lifecycle', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'acp-memory-test-'));
  const source = join(folder, 'source.db');
  const target = join(folder, 'restored.db');
  const state = join(folder, 'service-state');
  const manifestPath = join(folder, 'manifest.json');
  await writeFile(state, 'running');
  await writeFile(join(folder, 'systemctl'), `#!/bin/sh\ncase "$1" in\nshow) echo loaded;;\nis-active) test "$(cat '${state}')" = running;;\nstop) echo stopped > '${state}';;\nstart) echo running > '${state}';;\nesac\n`);
  await chmod(join(folder, 'systemctl'), 0o700);
  const writer = spawn('python3', ['-u', '-c', `import sqlite3,time\nc=sqlite3.connect(${JSON.stringify(source)})\nc.execute('pragma journal_mode=WAL')\nc.execute('create table sessions(id text)')\nc.execute('create table messages(text text)')\nc.execute("insert into sessions values ('remembered')")\nc.execute("insert into messages values ('recent WAL message')")\nc.commit()\nprint('ready',flush=True)\ntime.sleep(120)`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(writer.stdout, 'data');
  let uploaded;
  let uploadRequest;
  const server = createServer(async (req, res) => {
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      uploaded = Buffer.concat(chunks); res.end('');
    } else { res.end(uploaded); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/signed-token`;
  const eb = {
    request: async (path, options) => {
      if (path === '/files') { uploadRequest = options.body; return { file: { id: 'private-backup' }, putUrl: url }; }
      return { readUrl: url, url: '' };
    },
    exec: async (_box, command) => {
      assert.ok(!command.includes('EASYBITS_API_KEY'), 'cloud credential never enters sandbox command');
      return (await run('/bin/sh', ['-c', command], { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } })).stdout;
    },
  };
  try {
    const backup = await backupSessions({ eb, boxId: 'test', database: source, manifestPath });
    assert.equal(backup.sessions, 1); assert.equal(backup.messages, 1);
    assert.equal(uploadRequest.access, 'private');
    assert.equal(backup.uploaded, true);
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).fileId, 'private-backup');
    assert.ok(!(await readFile(manifestPath, 'utf8')).includes(url), 'signed URL is not persisted');
    const result = await restoreSessions({ eb, boxId: 'new', database: target, service: 'agent.service', fileId: backup.fileId, sha256: backup.sha256 });
    assert.equal(result.messages, 1);
    assert.equal((await readFile(state, 'utf8')).trim(), 'running');
    const original = await readFile(target);
    await assert.rejects(restoreSessions({ eb, boxId: 'new', database: target, service: 'agent.service', fileId: backup.fileId }), /Destination exists/);
    assert.deepEqual(await readFile(target), original);
    await assert.rejects(restoreSessions({ eb, boxId: 'new', database: target, service: 'agent.service', fileId: backup.fileId, force: true, sha256: 'incorrect' }), /checksum mismatch/);
    assert.deepEqual(await readFile(target), original);
    const forced = await restoreSessions({ eb, boxId: 'new', database: target, service: 'agent.service', fileId: backup.fileId, force: true, sha256: backup.sha256 });
    assert.ok(forced.previousDatabase);
    assert.deepEqual(await readFile(join(forced.previousDatabase, 'sessions.db')), original);
    uploaded = Buffer.from('not sqlite');
    await assert.rejects(restoreSessions({ eb, boxId: 'new', database: target, service: 'agent.service', fileId: backup.fileId, force: true }), /database/);
    assert.deepEqual(await readFile(target), original);
    assert.equal((await readFile(state, 'utf8')).trim(), 'running');
  } finally {
    writer.kill(); await once(writer, 'exit');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test('bootstrap rejects credential URLs and shell-shaped branch arguments', () => {
  assert.throws(() => skillsBootstrap({ repository: 'https://secret@github.com/repo.git' }), /credentials/);
  assert.throws(() => skillsBootstrap({ repository: 'https://github.com/repo.git', branch: 'main;id' }), /branch/);
});
