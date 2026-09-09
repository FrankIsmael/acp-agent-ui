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
import { modelPreference } from "~/.server/model-preference";
import { getConversation, setConversationConfig } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  if (request.headers.get("sec-fetch-site") === "cross-site") return data({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { configId?: string; value?: string | boolean };
  if (!body || typeof body.configId !== "string" || (typeof body.value !== "string" && typeof body.value !== "boolean") || (typeof body.value === "string" && body.value.length > 256)) {
    return data({ error: "configId y value son obligatorios" }, { status: 400 });
  }
  try {
    const ok = await setConversationConfig(params.id, body.configId, body.value);
    if (!ok) return data({ error: "conversation not found" }, { status: 404 });
    const option = getConversation(params.id)?.configOptions.find(option => option.id === body.configId);
    const isModel = option?.category === "model" || option?.id === "model";
    return data({ ok: true }, isModel && typeof body.value === "string" ? { headers: { "Set-Cookie": await modelPreference.serialize(body.value, { secure: new URL(request.url).protocol === "https:" }) } } : undefined);
  } catch (e) {
    return data({ error: "No pude cambiar la configuración." }, { status: 502 });
  }
}
