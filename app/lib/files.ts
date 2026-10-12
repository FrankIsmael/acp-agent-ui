/**
 * Files the agent delivers. The box's SDK (`/opt/gs-sdk`: publishPdf, publishSlides, publishFile…)
 * uploads the bytes and prints a fenced block the agent pastes verbatim:
 *
 *   ```eb-file
 *   {"url":"https://…","name":"deck.pdf","mime":"application/pdf","size":5847,"thumb":"https://…"}
 *   ```
 *
 * The chat turns each one into a download card. See docs/agent-storage.md.
 */
export interface DeliveredFile {
  url: string;
  name: string;
  mime: string;
  size?: number;
  thumb?: string;
}

export type FilePart = { kind: "text"; text: string } | { kind: "file"; file: DeliveredFile };

const OPENING = "```eb-file";
const BLOCK = /^[ \t]*```eb-file[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;

// Only links the browser can open as a download: no javascript:, data: or relative URLs.
function httpsUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The block's JSON, or undefined when it is not a usable file (then it stays as text). */
export function parseFileBlock(json: string): DeliveredFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  const url = httpsUrl(value.url);
  if (!url) return undefined;
  const last = new URL(url).pathname.split("/").pop() || "";
  let fallback = last;
  try {
    fallback = decodeURIComponent(last);
  } catch {
    /* keep it encoded */
  }
  return {
    url,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallback || "file",
    mime: typeof value.mime === "string" ? value.mime : "application/octet-stream",
    size: typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 ? value.size : undefined,
    thumb: httpsUrl(value.thumb),
  };
}

/** Split markdown into text and file cards. While streaming, an unclosed block is held back. */
export function splitFiles(text: string, streaming = false): FilePart[] {
  const parts: FilePart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(BLOCK)) {
    const file = parseFileBlock(match[1]);
    if (!file) continue;
    const before = text.slice(cursor, match.index);
    if (before.trim()) parts.push({ kind: "text", text: before });
    parts.push({ kind: "file", file });
    cursor = match.index + match[0].length;
  }
  let tail = text.slice(cursor);
  if (streaming) {
    const open = tail.lastIndexOf(OPENING);
    if (open !== -1 && !/\n[ \t]*```/.test(tail.slice(open + OPENING.length))) tail = tail.slice(0, open);
  }
  if (tail.trim()) parts.push({ kind: "text", text: tail });
  return parts;
}

export function formatSize(bytes: number, locale?: string) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** Short label for the card: "PDF", "PPTX", "PNG"… from the name, else from the mime. */
export function fileLabel(file: Pick<DeliveredFile, "name" | "mime">) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = file.mime.split(/[/;]/)[1]?.trim();
  return sub && sub.length <= 5 ? sub.toUpperCase() : "FILE";
}
