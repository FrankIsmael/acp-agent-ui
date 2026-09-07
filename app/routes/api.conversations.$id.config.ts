/**
 * POST /api/conversations/:id/config — cambia un selector de la sesión.
 *
 * Es `session/set_config_option` de ACP: el mismo método sirve para el modelo,
 * el modo o cualquier otro selector que el agente declare. El resultado no
 * vuelve por aquí, sino por el SSE (`config`), porque cambiar uno puede
 * reescribir la lista entera y todas las pestañas abiertas deben enterarse.
 */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.config";
import { setConversationConfig } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  const body = (await request.json()) as { configId?: string; value?: string | boolean };
  if (!body.configId || body.value === undefined) {
    return data({ error: "configId y value son obligatorios" }, { status: 400 });
  }
  try {
    const ok = await setConversationConfig(params.id, body.configId, body.value);
    if (!ok) return data({ error: "conversation not found" }, { status: 404 });
    return data({ ok: true });
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 502 });
  }
}
