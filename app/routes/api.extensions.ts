import { data } from "react-router";
import type { Route } from "./+types/api.extensions";
import { changeSessionExtension, listClientExtensions, listSessionExtensions } from "~/.server/acp";
import { extensionStore, parseExtension } from "~/.server/extensions";
import { assertSameOrigin } from "~/.server/request-validation";

async function respond(intent: string | null, error: string | null = null, status = 200) {
  const [config, session] = await Promise.all([listClientExtensions(), listSessionExtensions()]);
  return data({ extensions: config.extensions, session, loadError: config.error,
    intent, ok: !error && !config.error, error: error ?? config.error }, {
    status: config.error && status === 200 ? 500 : status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function loader() { return respond(null); }

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return respond(null, "Método no permitido", 405);
  try { assertSameOrigin(request); }
  catch { return respond(null, "Solicitud de otro origen rechazada", 403); }
  const form = await request.formData().catch(() => null);
  if (!form) return respond(null, "Formulario inválido", 400);
  const intent = form.get("intent");
  if (typeof intent !== "string") return respond(null, "Operación inválida", 400);
  if (intent === "session-add" || intent === "session-remove") {
    const id = form.get("sessionId");
    const key = form.get("configKey");
    if (typeof id !== "string" || !id || id.length > 256 || typeof key !== "string" || !key || key.length > 256) return respond(intent, "Conversación o extensión inválida", 400);
    try {
      await changeSessionExtension(id, intent === "session-add" ? "add" : "remove", key);
      return respond(intent);
    } catch (error) {
      return respond(intent, error instanceof Response ? await error.text() : "No pude cambiar las herramientas de la conversación.", error instanceof Response ? error.status : 502);
    }
  }
  let extension: ReturnType<typeof parseExtension> | undefined;
  let configKey = "";
  try {
    if (intent === "add") extension = parseExtension(form);
    else if (intent === "remove" || intent === "set-enabled") {
      const key = form.get("configKey");
      if (typeof key !== "string" || !key || key.length > 256) throw new Error("Extensión inválida");
      configKey = key;
      if (intent === "set-enabled" && !["true", "false"].includes(String(form.get("enabled")))) throw new Error("Estado inválido");
    } else throw new Error("Operación inválida");
  } catch (error) {
    return respond(intent, error instanceof Error ? error.message : "Configuración inválida", 400);
  }
  try {
    const store = extensionStore();
    if (extension) store.add(extension);
    else {
      const changed = intent === "remove" ? store.remove(configKey) : store.setEnabled(configKey, form.get("enabled") === "true");
      if (!changed) return respond(intent, "La extensión ya no existe", 404);
    }
    return respond(intent);
  } catch (error) {
    return respond(intent, error instanceof Response ? await error.text() : "No pude guardar el cambio en este cliente. Inténtalo de nuevo.", error instanceof Response ? error.status : 500);
  }
}
