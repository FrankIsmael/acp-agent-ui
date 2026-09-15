/** GET /api/whatsapp/events — SSE con el estado del canal y la lista de grupos. */
import { whatsappChannel, type WaEvent } from "~/.server/whatsapp";
import { requireAdmin } from "~/.server/admin-gate";

export async function loader({ request }: { request: Request }) {
  requireAdmin(request);
  const channel = whatsappChannel();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => { try { controller.enqueue(encoder.encode(chunk)); } catch {} };
      const send = (event: WaEvent) => { const { type, ...rest } = event; write(`event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`); };
      write(": connected\n\n");
      const beat = setInterval(() => write(": ping\n\n"), 25_000);
      channel.on("event", send);
      // Estado inicial: el navegador se pinta sin esperar al próximo cambio. Los grupos salen
      // de la base, nunca de WhatsApp: el SSE no debe pegarle al servidor por cada pestaña.
      send({ type: "status", status: channel.status });
      channel.groups(false).then(groups => send({ type: "groups", groups })).catch(() => {});
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(beat);
        channel.off("event", send);
      };
      request.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch {} });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
