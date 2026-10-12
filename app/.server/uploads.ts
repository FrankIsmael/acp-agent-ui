/**
 * Documents the user attaches, uploaded before the message that names them
 * (`POST /api/conversations/:id/uploads`, the raw bytes). See `app/lib/attachments.ts` for the
 * block the turn carries and docs/agent-storage.md#user-uploads for the bucket.
 *
 * Each file streams to our uploads bucket (Oracle Object Storage, S3 API, `UPLOAD_*`) under
 * `<UPLOAD_PREFIX><conversation>/<id>/<name>`: the bucket is the copy that outlives the box. The
 * turn then hands the agent a presigned GET link to download it into `adjuntos/`. It is a
 * different bucket and key from the box's own (`TIGRIS_*`, for the files the agent delivers),
 * so the agent never holds a key that lists what every user uploaded. Without `UPLOAD_*`
 * nothing can be attached.
 *
 * A row in `.data/uploads.db` keeps where each file is, so the message only sends ids and the
 * server never trusts a path or a link from the browser.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, extname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  MAX_FILE_BYTES,
  type AttachedFile,
  type UploadedFile,
} from '~/lib/attachments';

const env = (name: string) => (process.env[name] ?? '').trim();

/** How long the agent's download link lives. It downloads the file first thing in the turn. */
const LINK_SECONDS = 60 * 60;
const UPLOAD_SECONDS = 15 * 60;

interface BucketConfig {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

function bucketConfig(): BucketConfig | null {
  const endpoint = env('UPLOAD_ENDPOINT');
  const bucket = env('UPLOAD_BUCKET');
  const region = env('UPLOAD_REGION');
  const accessKey = env('UPLOAD_ACCESS_KEY_ID');
  const secretKey = env('UPLOAD_SECRET_ACCESS_KEY');
  if (!endpoint || !bucket || !region || !accessKey || !secretKey) return null;
  const prefix = env('UPLOAD_PREFIX') || 'uploads/';
  return {
    endpoint: new URL(endpoint),
    bucket,
    region,
    accessKey,
    secretKey,
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
  };
}

// --- S3 (SigV4, query-string presigning) -------------------------------------------------

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();

/**
 * A presigned URL for one object, path-style (`<endpoint>/<bucket>/<key>`), which Oracle's S3
 * API takes. Only `host` is signed and the payload is `UNSIGNED-PAYLOAD`, so the same URL works
 * for a streamed PUT and for `curl` on the box.
 */
export function presign(
  config: BucketConfig,
  method: 'GET' | 'PUT',
  key: string,
  seconds: number,
  now = new Date(),
) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const path = `/${rfc3986(config.bucket)}/${key.split('/').map(rfc3986).join('/')}`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKey}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(seconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join('&');
  const canonical = [
    method,
    path,
    query,
    `host:${config.endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join(
    '\n',
  );
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretKey}`, day), config.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(toSign)
    .digest('hex');
  return `${config.endpoint.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** Streams the body to the bucket; resolves with its sha256 once Oracle answers 200. */
async function putObject(
  config: BucketConfig,
  key: string,
  mimeType: string,
  size: number,
  body: Readable,
) {
  const hash = createHash('sha256');
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > size) return done(new UploadError('the file is larger than it said', 400));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const url = new URL(presign(config, 'PUT', key, UPLOAD_SECONDS));
  const answer = new Promise<void>((done, fail) => {
    const req = httpsRequest(
      url,
      {
        method: 'PUT',
        headers: { 'content-type': mimeType, 'content-length': String(size) },
        timeout: 120_000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c.length < 400 ? c : ''));
        res.on('end', () =>
          res.statusCode === 200
            ? done()
            : fail(new Error(`bucket answered ${res.statusCode}: ${text.slice(0, 200)}`)),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('bucket timed out')));
    req.on('error', fail);
    pipeline(body, counter, req).catch(fail);
  });
  await answer;
  if (seen !== size) throw new UploadError('the file is shorter than it said', 400);
  return hash.digest('hex');
}

// --- Where each upload is ----------------------------------------------------------------

interface Row {
  id: string;
  session_id: string;
  name: string;
  mime_type: string;
  size: number;
  path: string;
  bucket_key: string;
  sha256: string | null;
}

export class UploadStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    // `sha256` stays null while the bytes are on their way: such a row is not attachable yet.
    this.db.exec(`CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      sha256 TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS uploads_session ON uploads (session_id, path);`);
  }

  /**
   * Reserves `adjuntos/<name>` in the conversation, or `<stem>-1<ext>`… when a file of this
   * conversation already took it: the agent's `curl -o` would overwrite it.
   */
  reserve(row: Omit<Row, 'path' | 'sha256'>) {
    const ext = extname(row.name);
    const stem = ext ? row.name.slice(0, -ext.length) : row.name;
    const taken = this.db.prepare(
      'SELECT 1 FROM uploads WHERE session_id = ? AND path = ?',
    );
    let path = `adjuntos/${row.name}`;
    for (let n = 1; taken.get(row.session_id, path); n++)
      path = `adjuntos/${stem}-${n}${ext}`;
    this.db
      .prepare(
        'INSERT INTO uploads (id, session_id, name, mime_type, size, path, bucket_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.session_id,
        row.name,
        row.mime_type,
        row.size,
        path,
        row.bucket_key,
        Date.now(),
      );
    return path;
  }

  finish(id: string, sha256: string) {
    this.db.prepare('UPDATE uploads SET sha256 = ? WHERE id = ?').run(sha256, id);
  }

  drop(id: string) {
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  }

  /** The finished uploads of this conversation, in the order asked; undefined if any is not. */
  get(sessionId: string, ids: string[]): Row[] | undefined {
    const one = this.db.prepare(
      'SELECT * FROM uploads WHERE id = ? AND session_id = ? AND sha256 IS NOT NULL AND bucket_key IS NOT NULL',
    );
    const rows = ids.map((id) => one.get(id, sessionId) as Row | undefined);
    return rows.every(Boolean) ? (rows as Row[]) : undefined;
  }

  close() {
    this.db.close();
  }
}

let store: UploadStore | undefined;
export function uploadStore() {
  const path = process.env.ACP_UPLOADS_DB || '.data/uploads.db';
  return (store ??= new UploadStore(path === ':memory:' ? path : resolve(path)));
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** Takes one file's bytes, puts them in the bucket (or the box) and records where. */
export async function saveUpload(
  sessionId: string,
  file: { name: string; mimeType: string; size: number },
  body: WebReadableStream<Uint8Array>,
): Promise<UploadedFile> {
  if (file.size > MAX_FILE_BYTES)
    throw new UploadError(`"${file.name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
  const config = bucketConfig();
  if (!config)
    throw new UploadError(
      'Attachments are not configured on the server (UPLOAD_*, see docs/agent-storage.md#user-uploads).',
      503,
    );
  const id = randomBytes(12).toString('base64url');
  const key = `${config.prefix}${sessionId}/${id}/${file.name}`;
  const uploads = uploadStore();
  uploads.reserve({
    id,
    session_id: sessionId,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
    bucket_key: key,
  });
  const stream = Readable.fromWeb(body);
  try {
    uploads.finish(id, await putObject(config, key, file.mimeType, file.size, stream));
  } catch (e) {
    uploads.drop(id);
    stream.destroy();
    if (e instanceof UploadError) throw e;
    throw new UploadError(`Could not upload "${file.name}": ${(e as Error).message}`);
  }
  console.log(
    `[uploads] ${sessionId} ${file.name} (${file.size} bytes) → ${key}`,
  );
  return { id, name: file.name, mimeType: file.mimeType, size: file.size };
}

/**
 * The files a message names, as the turn gives them to the agent, each with a fresh download
 * link. Undefined if any id is unknown, unfinished or from another conversation.
 */
export function attachUploads(
  sessionId: string,
  ids: string[],
): AttachedFile[] | undefined {
  const rows = uploadStore().get(sessionId, ids);
  if (!rows) return undefined;
  const config = bucketConfig();
  if (!config) throw new UploadError('The uploads bucket is no longer configured.', 503);
  return rows.map((row) => ({
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    path: row.path,
    url: presign(config, 'GET', row.bucket_key, LINK_SECONDS),
  }));
}
