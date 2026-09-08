import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.cancel";
import { getConversation } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return data({ error: "forbidden" }, { status: 403 });
  }
  const conversation = getConversation(params.id);
  if (!conversation || conversation.closed) return data({ error: "conversation not found" }, { status: 404 });
  try {
    await conversation.cancel();
    return data({ cancelling: true });
  } catch {
    return data({ error: "No pude detener la respuesta. Inténtalo de nuevo." }, { status: 502 });
  }
}
