export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(request.url).origin)) {
    throw new Response("Solicitud de otro origen rechazada", { status: 403 });
  }
}
