/** POST /api/conversations — abre una conversación (y despierta la caja). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations";
import { readModelPreference } from "~/.server/model-preference";
import { AgentError, createConversation, listConversations } from "~/.server/acp";

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
    // Los fallos conocidos (timeout, caja, URL) llegan al navegador con su causa; el resto se
    // queda en genérico y la causa real va al log del servidor.
    console.error("[conversations] no se pudo abrir la conversación:", e);
    const message = e instanceof AgentError ? e.message : "No pude abrir la conversación. Revisa la conexión con el agente.";
    return data({ error: message }, { status: 502 });
  }
}
