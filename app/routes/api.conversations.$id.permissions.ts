import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.permissions";
import { getConversation, markActivity } from "~/.server/acp";
import { assertSameOrigin } from "~/.server/request-validation";

export function loader({ params }: Route.LoaderArgs) {
  const conversation = getConversation(params.id);
  if (!conversation) return data({ error: "Conversación no disponible" }, { status: 404 });
  return data({ permissions: conversation.permissions.snapshot() }, { headers: { "Cache-Control": "no-store" } });
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "Método no permitido" }, { status: 405 });
  assertSameOrigin(request);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.permissionId !== "string" || body.permissionId.length > 128 ||
      typeof body.optionId !== "string" || body.optionId.length > 1024) {
    return data({ error: "permissionId y optionId son obligatorios" }, { status: 400 });
  }
  const conversation = getConversation(params.id);
  if (!conversation) return data({ error: "Conversación no disponible" }, { status: 404 });
  const result = conversation.permissions.decide(body.permissionId, body.optionId);
  if (result === "missing") return data({ error: "Este permiso ya se resolvió o fue cancelado" }, { status: 409 });
  if (result === "invalid") return data({ error: "La opción no pertenece a este permiso" }, { status: 400 });
  markActivity();
  return data({ ok: true });
}
