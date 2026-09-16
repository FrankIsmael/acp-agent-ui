import { consumeDemoIp } from "~/.server/demo-ip";
/**
 * /api/whatsapp — GET estado + grupos; POST `intent`: connect | pair | disconnect | logout | group.
 * La respuesta siempre trae el estado completo, como /api/extensions: la pantalla se pinta
 * sin segunda vuelta.
 */
import { demoDb, demoUser, demoStatus, demoMessage } from "~/.server/demo";
import { data } from "react-router";
import type { Route } from "./+types/api.whatsapp";
import { assertSameOrigin } from "~/.server/request-validation";
import { requireAdmin } from "~/.server/admin-gate";
import { whatsappChannel } from "~/.server/whatsapp";

async function respond(request: Request, intent: string | null, error: string | null = null, status = 200) {
  const channel = whatsappChannel(demoUser(request));
  // El GET sí refresca la lista de grupos (con caché de 60 s); el SSE nunca.
  const groups = await channel.groups(intent === null);
  return data({ status: channel.status, groups, intent, ok: !error, error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function loader({ request }: Route.LoaderArgs) { if (!demoUser(request)) requireAdmin(request); return respond(request, null); }

export async function action({ request }: Route.ActionArgs) {
  if (!demoUser(request)) requireAdmin(request);
  if (request.method !== "POST") return respond(request, null, "Método no permitido", 405);
  try { assertSameOrigin(request); }
  catch { return respond(request, null, "Solicitud de otro origen rechazada", 403); }
  const form = await request.formData().catch(() => null);
  if (!form) return respond(request, null, "Formulario inválido", 400);
  const intent = form.get("intent");
  if (typeof intent !== "string") return respond(request, null, "Operación inválida", 400);
  const owner = demoUser(request);
  if (owner && !["disconnect", "logout"].includes(intent) && demoStatus(owner).exhausted) return respond(request, intent, demoMessage(), 429);
  if (owner && ["connect", "pair"].includes(intent)) consumeDemoIp(demoDb(), request, "whatsapp");
  const channel = whatsappChannel(owner);
  try {
    if (intent === "connect") {
      void channel.connect();
    } else if (intent === "pair") {
      const phone = String(form.get("phone") ?? "").replace(/[^\d]/g, "");
      if (phone.length < 8 || phone.length > 15) return respond(request, intent, "Escribe el número con lada, sólo dígitos (por ejemplo 5215512345678)", 400);
      void channel.connect(phone);
    } else if (intent === "disconnect") {
      await channel.disconnect(false);
    } else if (intent === "logout") {
      await channel.disconnect(true);
    } else if (intent === "group") {
      const jid = form.get("jid");
      const enabled = String(form.get("enabled"));
      if (typeof jid !== "string" || !jid || jid.length > 128 || !["true", "false"].includes(enabled)) return respond(request, intent, "Grupo inválido", 400);
      if (!channel.setGroup(jid, enabled === "true")) return respond(request, intent, "Ese grupo ya no está en la lista", 404);
    } else {
      return respond(request, intent, "Operación inválida", 400);
    }
    // El connect es asíncrono: se da un respiro para que el estado ya diga "connecting".
    await new Promise(resolve => setTimeout(resolve, 50));
    return respond(request, intent);
  } catch (error) {
    return respond(request, intent, (error as Error).message || "No pude cambiar el canal.", 500);
  }
}
