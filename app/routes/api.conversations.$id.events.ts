/**
 * GET /api/conversations/:id/events — SSE.
 *
 * Es una ruta de recurso: no renderiza nada, devuelve un ReadableStream que se
 * mantiene abierto mientras el navegador escuche.
 */
import type { Route } from "./+types/api.conversations.$id.events";
import {
  closeSse,
  getConversation,
  openSse,
  subscribe,
  type AcpEvent,
} from "~/.server/acp";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!getConversation(params.id)) {
    return new Response("conversation not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // el cliente ya se fue
        }
      };

      write(": connected\n\n");
      openSse();

      // Latido: mantiene viva la conexión frente a proxies impacientes.
      const beat = setInterval(() => write(": ping\n\n"), 25_000);
      let unsubscribe: (() => void) | null = null;

      // Las tres salidas (sesión cerrada, cliente desconectado, stream
      // cancelado) pueden solaparse: el desmontaje corre una sola vez.
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(beat);
        unsubscribe?.();
        unsubscribe = null;
        closeSse();
      };

      unsubscribe = subscribe(params.id, (e: AcpEvent) => {
        const { type, ...rest } = e;
        write(`event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`);
        // "done" cierra un turno; solo "closed" cierra la sesión — y con ella
        // la respuesta, porque el emisor ya no volverá a hablar.
        if (type === "closed") {
          cleanup();
          try {
            controller.close();
          } catch {}
        }
      });

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
