/** POST /api/conversations — abre una conversación (y despierta la caja). */
import { demoUser, conversationOwner, demoConversation, DemoLimitError } from "~/.server/demo";
import { data } from "react-router";
import type { Route } from "./+types/api.conversations";
import { readModelPreference } from "~/.server/model-preference";
import { AgentError, createConversation, listConversations } from "~/.server/acp";

export async function loader({ request }: Route.LoaderArgs) {
  const owner = demoUser(request);
  const snapshot = await listConversations();
  return data({ ...snapshot, conversations: owner ? snapshot.conversations.filter(c => conversationOwner(c.id) === owner) : snapshot.conversations }, { headers: { "Cache-Control": "no-store" } });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  try {
    const owner = demoUser(request);
    const model = owner ? null : await readModelPreference(request);
    const id = owner ? await demoConversation(owner, () => createConversation(model)) : await createConversation(model);
    return data({ conversationId: id });
  } catch (e) {
    if (e instanceof Response) return data({ error: await e.text() }, { status: e.status });
    if (e instanceof DemoLimitError) return data({ error: e.message, code: "DEMO_LIMIT" }, { status: 429 });
    // Los fallos conocidos (timeout, caja, URL) llegan al navegador con su causa; el resto se
    // queda en genérico y la causa real va al log del servidor.
    console.error("[conversations] no se pudo abrir la conversación:", e);
    const message = e instanceof AgentError ? e.message : "No pude abrir la conversación. Revisa la conexión con el agente.";
    return data({ error: message }, { status: 502 });
  }
}
