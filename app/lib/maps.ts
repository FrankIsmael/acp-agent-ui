/**
 * Lo que el chat pinta en un mapa a partir de las herramientas de Google Maps Grounding Lite
 * (`scripts/install-maps-mcp.mjs`). goose entrega el resultado de la tool como texto JSON en el
 * `content[]` del `tool_call_update`; de ahí salen los lugares de `search_places` (con
 * coordenadas) y las rutas de `compute_routes` (sólo distancia y duración, sin geometría).
 *
 * Se reconoce por la forma del JSON, no por el nombre de la extensión: quien la dé de alta a
 * mano puede llamarla como quiera.
 */

export interface MapPlace { id: string; name: string; lat: number; lng: number; url: string }
export interface MapRoute { title: string; meters: number; seconds: number; url: string }
export interface MapData { places: MapPlace[]; routes: MapRoute[] }

const SUFFIX = / - Google Maps$/;

// Sólo enlaces https a Google: el JSON viene del MCP y acaba como `href` en la página.
function googleUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)google\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function place(raw: any): MapPlace | null {
  const lat = raw?.location?.latitude, lng = raw?.location?.longitude;
  const url = googleUrl(raw?.googleMapsLinks?.placeUrl) ?? googleUrl(raw?.attribution?.url);
  const name = typeof raw?.attribution?.title === "string" ? raw.attribution.title.replace(SUFFIX, "").trim() : "";
  if (typeof raw?.id !== "string" || !Number.isFinite(lat) || !Number.isFinite(lng) || !url || !name) return null;
  return { id: raw.id, name, lat, lng, url };
}

function route(raw: any): MapRoute | null {
  const url = googleUrl(raw?.attribution?.url);
  const meters = Number(raw?.distanceMeters);
  const seconds = Number.parseFloat(String(raw?.duration ?? "")); // "320s"
  const title = typeof raw?.attribution?.title === "string" ? raw.attribution.title.replace(SUFFIX, "").trim() : "";
  if (!url || !title || !Number.isFinite(meters) || !Number.isFinite(seconds)) return null;
  return { title, meters, seconds, url };
}

/** Lugares y rutas del `content[]` de un `tool_call_update`; `null` si no trae nada de mapas. */
export function mapDataFromToolContent(content: unknown): MapData | null {
  if (!Array.isArray(content)) return null;
  const data: MapData = { places: [], routes: [] };
  for (const block of content) {
    const text = block?.type === "content" && block.content?.type === "text" ? block.content.text : undefined;
    if (typeof text !== "string" || !text.trimStart().startsWith("{")) continue;
    let json: any;
    try { json = JSON.parse(text); } catch { continue; }
    if (Array.isArray(json?.places)) for (const raw of json.places) { const p = place(raw); if (p) data.places.push(p); }
    if (Array.isArray(json?.routes)) for (const raw of json.routes) { const r = route(raw); if (r) data.routes.push(r); }
  }
  return data.places.length || data.routes.length ? data : null;
}

/** Junta lo de varias tools del mismo turno sin repetir lugares ni rutas. */
export function mergeMapData(base: MapData | undefined, next: MapData): MapData {
  const places = [...(base?.places ?? [])], routes = [...(base?.routes ?? [])];
  for (const p of next.places) if (!places.some(x => x.id === p.id)) places.push(p);
  for (const r of next.routes) if (!routes.some(x => x.url === r.url)) routes.push(r);
  return { places, routes };
}

// ── Trazo de las rutas ──────────────────────────────────────────────────────────────────────
// `compute_routes` no devuelve geometría ni los argumentos con que se llamó (goose manda
// `rawInput: {}`). Lo que sí trae es el enlace `…/maps/dir/<origen>/<destino>`: de ahí salen los
// extremos, y el navegador le pide el trazo a Routes API. Un nombre suelto ("Café Negro") no lo
// resuelve Routes, así que si coincide con un lugar del mismo turno se usa su place id.

export type Waypoint = { placeId: string } | { address: string };

/** Origen y destino tal como el agente se los dio a `compute_routes`. */
export function routeEndpoints(route: MapRoute): [string, string] | null {
  try {
    const parts = new URL(route.url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("dir");
    if (at === -1 || parts.length < at + 3) return null;
    const [origin, destination] = parts.slice(at + 1, at + 3).map(decodeURIComponent);
    return origin && destination ? [origin, destination] : null;
  } catch { return null; }
}

const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

export function waypoint(name: string, places: MapPlace[]): Waypoint {
  const match = places.find(p => normalize(p.name) === normalize(name));
  return match ? { placeId: match.id } : { address: name };
}

/** Caminando ronda 1.4 m/s; nada en coche va tan lento salvo en un atasco imposible. */
export function travelMode(route: MapRoute): "WALK" | "DRIVE" {
  return route.seconds > 0 && route.meters / route.seconds < 2.5 ? "WALK" : "DRIVE";
}

/** El trazo vale si recorre lo mismo que dijo la tool (±20 %): si no, se resolvió otro sitio. */
export function sameRoute(meters: number, expected: number) {
  return expected > 0 && Math.abs(meters - expected) / expected <= 0.2;
}

/** Polyline codificada de Google → puntos. https://developers.google.com/maps/documentation/utilities/polylinealgorithm */
export function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}
