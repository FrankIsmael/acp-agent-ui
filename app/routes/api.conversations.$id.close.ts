import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.close";
import { closeConversation } from "~/.server/acp";
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  try {
    if (!await closeConversation(params.id)) return data({ error: "conversation not found" }, { status: 404 });
    return data({ closed: true });
  } catch { return data({ error: "No pude cerrar la conversación." }, { status: 502 }); }
}
