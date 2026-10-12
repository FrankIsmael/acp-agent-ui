/**
 * Documents the user attaches (PDF, Word, Excel, zip…). Images go to the model as `image`
 * blocks; documents cannot: the box's front (`/opt/goose/dist/server.js`) notes that a
 * `resource` with a `blob` is accepted without error and the agent never sees it. So the
 * browser uploads each file first (`POST /api/conversations/:id/uploads`, raw bytes) and the
 * turn carries one text block with the paths in the conversation's `adjuntos/` folder. The
 * template's skills already read from there (`pdf-reader info adjuntos/X.pdf`, `Read adjuntos/X`).
 *
 * The bytes go to our uploads bucket (`app/.server/uploads.ts`), not to the box: each line
 * carries a short-lived link and the one `curl` that downloads the file to its path.
 *
 * Each line also carries the marks the `big-files` skill triggers on: GRANDE (over 5 MB) and
 * COMPRIMIDO (an archive).
 *
 * Shared by the browser and the server: no Node or DOM imports.
 */

/** What the upload route answers and what the browser then sends with the message. */
export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** What a turn keeps: where the file lands in the box, not its bytes. */
export interface AttachedFile {
  name: string;
  mimeType: string;
  size: number;
  /** Relative to the conversation's working directory, e.g. `adjuntos/report.pdf`. */
  path?: string;
  /** A short-lived link to the file in the bucket; the agent downloads it to `path`. */
  url?: string;
}

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** All the files of one message together. */
export const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
/** Where the `big-files` skill takes over. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const ARCHIVE = /\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i;

export const ATTACHMENTS_OPEN = "[attachments]";
export const ATTACHMENTS_CLOSE = "[/attachments]";
const INTRO =
  "The user attached these files, at these paths in your working directory; open them from there:";
const LINE = /^- (.+) \(([^,()]+), (\d+) bytes\)(?: [A-Z]+)*$/;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The text block that goes with the turn. */
export function attachmentsBlock(files: AttachedFile[]) {
  const lines = files.flatMap((f) => {
    const path = f.path ?? f.name;
    const marks = [f.size > LARGE_FILE_BYTES ? " GRANDE" : "", ARCHIVE.test(path) ? " COMPRIMIDO" : ""].join("");
    const line = `- ${path} (${f.mimeType || "application/octet-stream"}, ${f.size} bytes)${marks}`;
    if (!f.url) return [line];
    return [
      line,
      `  It is not on disk yet. Before anything else, download it with exactly: curl -fsS --create-dirs -o ${shellQuote(path)} ${shellQuote(f.url)}`,
    ];
  });
  return [ATTACHMENTS_OPEN, INTRO, ...lines, ATTACHMENTS_CLOSE].join("\n");
}

/**
 * Takes the block out of a replayed user chunk. Returns the files it listed and the text
 * without it; `files` is empty when the chunk had no block.
 */
export function takeAttachments(text: string): { text: string; files: AttachedFile[] } {
  const start = text.indexOf(ATTACHMENTS_OPEN);
  if (start === -1) return { text, files: [] };
  const end = text.indexOf(ATTACHMENTS_CLOSE, start);
  if (end === -1) return { text, files: [] };
  const files: AttachedFile[] = [];
  for (const line of text.slice(start + ATTACHMENTS_OPEN.length, end).split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const path = match[1];
    files.push({ name: path.split("/").pop() || path, mimeType: match[2], size: Number(match[3]), path });
  }
  const rest = (text.slice(0, start) + text.slice(end + ATTACHMENTS_CLOSE.length)).trim();
  return { text: rest, files };
}

/** Problem with the uploads a message names, or undefined when they are fine. */
export function invalidFiles(files: unknown): { error: string; tooLarge?: boolean } | undefined {
  if (!Array.isArray(files)) return { error: "invalid files" };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per message`, tooLarge: true };
  for (const f of files as Partial<UploadedFile>[]) {
    if (!f || typeof f.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id)) return { error: "invalid file" };
  }
  if (new Set(files.map((f: UploadedFile) => f.id)).size !== files.length) return { error: "repeated file" };
  return undefined;
}

/** Problem with a file name the upload route receives, or undefined when it is fine. */
export function invalidFileName(name: unknown) {
  if (typeof name !== "string" || !name.trim() || name.length > 200) return "invalid file name";
  if (/[\/\0]/.test(name) || name === "." || name === "..") return "invalid file name";
  return undefined;
}
