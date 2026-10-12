/**
 * POST /api/conversations/:id/uploads?name=<file name> — one document, the raw bytes as the
 * body (no base64, no JSON). Answers `{ id, name, mimeType, size }`; the message then names
 * the file by that id. See app/.server/uploads.ts for where the bytes go.
 */
import { data } from "react-router";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Route } from "./+types/api.conversations.$id.uploads";
import { getConversation } from "~/.server/acp";
import { embedConversation } from "~/.server/embed-conversations";
import { saveUpload, UploadError } from "~/.server/uploads";
import { invalidFileName, MAX_FILE_BYTES } from "~/lib/attachments";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  if (!getConversation(params.id)) return data({ error: "La conversación no está disponible." }, { status: 404 });
  // The public portfolio widget does not take documents: anyone could fill the bucket.
  if (embedConversation(params.id)) return data({ error: "files are not accepted here" }, { status: 403 });
  const name = new URL(request.url).searchParams.get("name");
  const nameProblem = invalidFileName(name);
  if (nameProblem || !name) return data({ error: nameProblem }, { status: 400 });
  const size = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 0) return data({ error: "missing content-length" }, { status: 411 });
  if (size > MAX_FILE_BYTES)
    return data({ error: `"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` }, { status: 413 });
  const mimeType = (request.headers.get("content-type") ?? "").split(";")[0].trim().slice(0, 200) || "application/octet-stream";
  const body = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  try {
    return data(await saveUpload(params.id, { name, mimeType, size }, body as unknown as WebReadableStream<Uint8Array>));
  } catch (error) {
    if (error instanceof UploadError) {
      console.warn(`[uploads] ${params.id} ${name}: ${error.message}`);
      return data({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
