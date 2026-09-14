export function assertSameOrigin(request: Request) {
  // `Sec-Fetch-Site` lo pone el navegador y no se puede falsificar desde una página; es la
  // señal fiable. Sólo si falta (clientes viejos) se cae a comparar `Origin` con el host de
  // la petición — por host, no por origen completo, porque detrás de un proxy TLS el
  // esquema que ve el servidor (http) no es el que ve el navegador (https).
  const site = request.headers.get("sec-fetch-site");
  if (site) {
    if (site === "cross-site") throw new Response("Solicitud de otro origen rechazada", { status: 403 });
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try { originHost = new URL(origin).host; } catch { throw new Response("Solicitud de otro origen rechazada", { status: 403 }); }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  if (originHost !== host) throw new Response("Solicitud de otro origen rechazada", { status: 403 });
}
