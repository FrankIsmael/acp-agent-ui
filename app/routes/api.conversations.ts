/** POST /api/conversations — abre una conversación (y despierta la caja). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations";
import { readModelPreference } from "~/.server/model-preference";
import { createConversation, listConversations } from "~/.server/acp";

export async function loader() {
  return data(await listConversations(), { headers: { "Cache-Control": "no-store" } });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  try {
    const id = await createConversation(await readModelPreference(request));
    return data({ conversationId: id });
  } catch (e) {
    return data({ error: "No pude abrir la conversación. Revisa la conexión con el agente." }, { status: 502 });
  }
}
