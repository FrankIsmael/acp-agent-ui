/**
 * Documents the user attaches (PDF, Word, Excel, zip…). Images go to the model as `image`
 * blocks; documents cannot: the box's front (`/opt/goose/dist/server.js`) notes that a
 * `resource` with a `blob` is accepted without error and the agent never sees it. So the server
 * uploads each file to the box (`POST /adjunto`, into the conversation's `adjuntos/` folder) and
 * the turn carries one text block with the paths. The template's skills already read from there
 * (`pdf-reader info adjuntos/X.pdf`, `Read adjuntos/X`).
 *
 * The front takes at most 12 MB per upload and never appends, so a bigger file goes up in
 * `CHUNK_BYTES` pieces: the first under the file's own name, the rest as `<name>.part2`… The
 * block then tells the agent the one command that joins them. Each line also carries the marks
 * the `big-files` skill triggers on: GRANDE (over 5 MB) and COMPRIMIDO (an archive).
 *
 * Shared by the browser and the server: no Node or DOM imports.
 */

/** What the browser sends: the bytes in base64, without the `data:` prefix. */
export interface PromptFile {
  name: string;
  mimeType: string;
  data: string;
}

/** What a turn keeps: where the file landed in the box, not its bytes. */
export interface AttachedFile {
  name: string;
  mimeType: string;
  size: number;
  /** Relative to the conversation's working directory, e.g. `adjuntos/report.pdf`. */
  path?: string;
  /** The other pieces of a file sent in chunks, in order; the agent appends them to `path`. */
  parts?: string[];
}

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** All the files of one message together: the browser sends them in one JSON body. */
export const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
/** Base64 length of a file of `MAX_FILE_BYTES`. */
export const MAX_FILE_BASE64 = base64Length(MAX_FILE_BYTES);
/** The box's front refuses more than 12 MB per upload; leave room. */
export const CHUNK_BYTES = 10 * 1024 * 1024;
/** Where the `big-files` skill takes over. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const ARCHIVE = /\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i;

export const ATTACHMENTS_OPEN = "[attachments]";
export const ATTACHMENTS_CLOSE = "[/attachments]";
const INTRO =
  "The user attached these files. They are saved in your working directory; open them from there:";
const LINE = /^- (.+) \(([^,()]+), (\d+) bytes\)(?: [A-Z]+)*$/;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The text block that goes with the turn. */
export function attachmentsBlock(files: AttachedFile[]) {
  const lines = files.flatMap((f) => {
    const path = f.path ?? f.name;
    const marks = [f.size > LARGE_FILE_BYTES ? " GRANDE" : "", ARCHIVE.test(path) ? " COMPRIMIDO" : ""].join("");
    const line = `- ${path} (${f.mimeType || "application/octet-stream"}, ${f.size} bytes)${marks}`;
    if (!f.parts?.length) return [line];
    const parts = f.parts.map(shellQuote).join(" ");
    return [
      line,
      `  It arrived in ${f.parts.length + 1} pieces. Before anything else, join them with exactly: cat ${parts} >> ${shellQuote(path)} && rm ${parts}`,
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

/** Problem with what the browser sent, or undefined when it is fine. */
export function invalidFiles(files: unknown): { error: string; tooLarge?: boolean } | undefined {
  if (!Array.isArray(files)) return { error: "invalid files" };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per message`, tooLarge: true };
  let total = 0;
  for (const f of files as Partial<PromptFile>[]) {
    if (!f || typeof f.name !== "string" || !f.name.trim() || f.name.length > 200) return { error: "invalid file name" };
    if (typeof f.mimeType !== "string" || f.mimeType.length > 200) return { error: `invalid type for "${f.name}"` };
    if (typeof f.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return { error: `invalid content for "${f.name}"` };
    if (f.data.length > MAX_FILE_BASE64) return { error: `"${f.name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, tooLarge: true };
    total += f.data.length;
  }
  if (total > base64Length(MAX_MESSAGE_BYTES))
    return { error: `the files of one message add up to more than ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`, tooLarge: true };
  return undefined;
}

function base64Length(bytes: number) {
  return Math.ceil(bytes / 3) * 4;
}

/** Byte count of a base64 string, without decoding it. */
export function base64Size(data: string) {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, (data.length / 4) * 3 - padding);
}
