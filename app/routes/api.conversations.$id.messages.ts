/** POST /api/conversations/:id/messages — encola un turno (texto + imágenes). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.messages";
import { askConversation, type PromptImage } from "~/.server/acp";

// Un base64 de 8 MB son ~6 MB de imagen: más que eso no lo acepta ningún
// modelo y sí tumba el proceso, así que se corta aquí y no en el agente.
const MAX_IMAGES = 8;
const MAX_BYTES = 8 * 1024 * 1024;

export async function action({ request, params }: Route.ActionArgs) {
  const body = (await request.json()) as { text?: string; images?: PromptImage[] };
  const images = Array.isArray(body.images) ? body.images : [];
  // Sin texto pero con imágenes es un turno válido ("¿qué ves aquí?" se
  // sobreentiende); sin nada de nada, no.
  if (!body.text && images.length === 0) return data({ error: "no content" }, { status: 400 });
  if (images.length > MAX_IMAGES) {
    return data({ error: `máximo ${MAX_IMAGES} imágenes por turno` }, { status: 413 });
  }
  for (const img of images) {
    if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") {
      return data({ error: "imagen inválida" }, { status: 400 });
    }
    if (img.data.length > MAX_BYTES) {
      return data({ error: `"${img.name ?? "imagen"}" pesa demasiado` }, { status: 413 });
    }
  }
  const ok = askConversation(params.id, String(body.text ?? ""), images);
  if (!ok) return data({ error: "conversation not found" }, { status: 404 });
  return data({ queued: true });
}
