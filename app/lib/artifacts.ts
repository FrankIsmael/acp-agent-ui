export interface ParsedArtifact {
  identifier: string;
  title: string;
  type: string;
  language: string;
  content: string;
  complete: boolean;
}

export interface Artifact extends ParsedArtifact {
  key: string;
  conversationId: string;
  turnIndex: number;
  updatedAt: number;
  editedContent?: string;
}

export type ArtifactPart = { kind: "text"; text: string } | { kind: "artifact"; artifact: ParsedArtifact; index: number };

function decodeAttribute(value: string) {
  return value.replace(/&(quot|apos|amp|lt|gt);/g, (_, entity: string) =>
    ({ quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" })[entity]!);
}

// Keep a partial delimiter out of both the chat and the preview until the next
// chunk arrives. Content itself is deliberately never HTML/XML decoded.
function withoutPartialSuffix(text: string, delimiter: string) {
  for (let length = Math.min(text.length, delimiter.length); length > 0; length--) {
    if (text.slice(-length).toLowerCase() === delimiter.slice(0, length)) return text.slice(0, -length);
  }
  return text;
}

/** Parse the accumulated stream; unlike DOMParser this accepts unfinished XML. */
export function parseArtifacts(text: string, streaming = false): ArtifactPart[] {
  const parts: ArtifactPart[] = [];
  const opening = /<artifact(?=\s|>)/gi;
  let cursor = 0;
  let index = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    if (match.index > cursor) parts.push({ kind: "text", text: text.slice(cursor, match.index) });
    // '>' is legal inside a quoted attribute.
    const header = /^<artifact\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(text.slice(match.index));
    if (!header) {
      if (!streaming) parts.push({ kind: "text", text: text.slice(match.index) });
      return parts;
    }
    const attributes: Record<string, string> = Object.create(null);
    for (const attr of header[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attr[1].toLowerCase()] = decodeAttribute(attr[2] ?? attr[3]);
    }
    const start = match.index + header[0].length;
    const closing = /<\/artifact\s*>/gi;
    closing.lastIndex = start;
    const end = closing.exec(text);
    const content = text.slice(start, end?.index);
    parts.push({
      kind: "artifact", index,
      artifact: {
        identifier: attributes.identifier || attributes.id || `artifact-${index + 1}`,
        title: attributes.title || "Sin título",
        type: (attributes.type || "text/plain").toLowerCase(),
        language: (attributes.language || "").toLowerCase(),
        content: !end && streaming ? withoutPartialSuffix(content, "</artifact>") : content,
        complete: !!end,
      },
    });
    index++;
    if (!end) return parts;
    cursor = end.index + end[0].length;
    opening.lastIndex = cursor;
  }
  const tail = text.slice(cursor);
  const visible = streaming ? withoutPartialSuffix(tail, "<artifact") : tail;
  if (visible) parts.push({ kind: "text", text: visible });
  return parts;
}

// Each response is a revision. Reusing an identifier in a later turn must not
// destroy a user's local edits or change an earlier message's artifact card.
export function artifactKey(conversationId: string, turnIndex: number, index: number) {
  return JSON.stringify([conversationId, turnIndex, index]);
}

export function artifactContent(artifact: Artifact) {
  return artifact.editedContent ?? artifact.content;
}

export function previewKind(artifact: Pick<ParsedArtifact, "type" | "language">) {
  if (["text/html", "application/vnd.ant.html"].includes(artifact.type) || ["html", "htm"].includes(artifact.language)) return "html";
  if (artifact.type === "image/svg+xml" || artifact.language === "svg") return "svg";
  if (["text/markdown", "text/md", "application/vnd.ant.document"].includes(artifact.type) || ["markdown", "md"].includes(artifact.language)) return "markdown";
  if (artifact.type === "text/plain" && !artifact.language) return "text";
  return "code";
}

/** Only used in an opaque-origin sandbox. Inline code is the artifact's purpose;
 * eval, external resources, connections, forms, frames and workers stay blocked.
 * Do not add allow-same-origin to the iframe or reuse this policy in the host. */
export function artifactPreviewDocument(content: string) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}svg{max-width:100%;height:auto}</style></head><body>${content}</body></html>`;
}

export function artifactFile(artifact: Artifact) {
  const kind = previewKind(artifact);
  const extensions: Record<string, string> = { javascript: "js", typescript: "ts", python: "py", ruby: "rb", rust: "rs", shell: "sh", bash: "sh", markdown: "md" };
  const extension = kind === "code" ? (extensions[artifact.language] || artifact.language.replace(/[^a-z0-9]/g, "").slice(0, 12) || "txt") : ({ html: "html", svg: "svg", markdown: "md", text: "txt" })[kind];
  const stem = artifact.title.replace(/\.[a-z0-9]+$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "artifact";
  const mime = ({ html: "text/html", svg: "image/svg+xml", markdown: "text/markdown", text: "text/plain", code: "text/plain" })[kind];
  return { name: `${stem}.${extension}`, mime };
}

export const ARTIFACT_STORAGE_KEY = "acp-artifacts-v1";

export function readArtifactStorage(raw: string | null): Artifact[] {
  if (!raw) return [];
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("artifacts" in data) || !Array.isArray(data.artifacts)) throw new Error("Invalid artifact library");
  return data.artifacts.filter((a: unknown): a is Artifact => {
    if (!a || typeof a !== "object") return false;
    const v = a as Artifact;
    return [v.key, v.conversationId, v.identifier, v.title, v.type, v.language, v.content].every(x => typeof x === "string") &&
      typeof v.complete === "boolean" && Number.isInteger(v.turnIndex) && Number.isFinite(v.updatedAt) &&
      (v.editedContent === undefined || typeof v.editedContent === "string");
  });
}

export function mergeArtifacts(current: Artifact[], incoming: Artifact[]) {
  const next = [...current];
  let changed = false;
  for (const artifact of incoming) {
    const index = next.findIndex(a => a.key === artifact.key);
    const previous = next[index];
    if (previous && ["content", "title", "language", "type", "complete"].every(key => previous[key as keyof Artifact] === artifact[key as keyof Artifact])) continue;
    changed = true;
    if (previous) next[index] = { ...artifact, editedContent: previous.editedContent };
    else next.push(artifact);
  }
  return changed ? next : current;
}
