export function assertSameOrigin(request: Request) {
  // `Sec-Fetch-Site` is set by the browser and cannot be faked from a web page; it is the reliable signal.
  // Only if it's missing (older clients), we fall back to comparing the `Origin` header with the request host —
  // by host, not by full origin, because behind a TLS proxy the scheme the server sees (http) isn't what the browser sees (https).
  const site = request.headers.get('sec-fetch-site');
  if (site) {
    if (site === 'cross-site')
      throw new Response('Request from another origin rejected', {
        status: 403,
      });

    return;
  }
  const origin = request.headers.get('origin');
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new Response('Request from another origin rejected', { status: 403 });
  }
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  if (originHost !== host)
    throw new Response('Request from another origin rejected', { status: 403 });
}
