/**
 * What the chat displays on a map based on the Google Maps Grounding Lite tools
 * (`scripts/install-maps-mcp.mjs`). Goose returns the output of the tool as JSON text in the
 * `content[]` of the `tool_call_update`; from there come the places from `search_places`
 * (with coordinates) and the routes from `compute_routes` (only distance and duration, no geometry).
 *
 * Recognition is by the shape of the JSON, not by the extension name: whoever registers it
 * manually can name it however they want.
 */

export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  url: string;
}

export interface RoutePoint {
  name: string;
  placeId?: string;
  lat?: number;
  lng?: number;
}
export interface MapRoute {
  title: string;
  meters: number;
  seconds: number;
  url: string;
  origin?: RoutePoint;
  destination?: RoutePoint;
  mode?: 'DRIVE' | 'WALK';
}

export interface MapWeather {
  /** Where, if the tool provides it; Grounding Lite does not always return the name of the place. */
  place?: string;
  /** For a forecast, when (ISO or "YYYY-MM-DD"); if not set, these are the current conditions. */
  when?: string;
  condition: string;
  /** `https://maps.gstatic.com/weather/v1/<tipo>` . */
  icon?: string;
  temperature: number;
  low?: number;
  unit: 'C' | 'F';
  feelsLike?: number;
  humidity?: number;
  uvIndex?: number;
  rain?: number;
  wind?: { speed: number; unit: string; direction?: string };
  url?: string;
}
export interface MapData {
  places: MapPlace[];
  routes: MapRoute[];
  weather?: MapWeather[];
}

const SUFFIX = / - Google Maps$/;

function googleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)google\.com$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function place(raw: any): MapPlace | null {
  const lat = raw?.location?.latitude,
    lng = raw?.location?.longitude;
  const url =
    googleUrl(raw?.googleMapsLinks?.placeUrl) ??
    googleUrl(raw?.attribution?.url);
  const name =
    typeof raw?.attribution?.title === 'string'
      ? raw.attribution.title.replace(SUFFIX, '').trim()
      : '';
  if (
    typeof raw?.id !== 'string' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !url ||
    !name
  )
    return null;
  return { id: raw.id, name, lat, lng, url };
}

function route(raw: any): MapRoute | null {
  const url = googleUrl(raw?.attribution?.url);
  const meters = Number(raw?.distanceMeters);
  const seconds = Number.parseFloat(String(raw?.duration ?? '')); // "320s"
  const title =
    typeof raw?.attribution?.title === 'string'
      ? raw.attribution.title.replace(SUFFIX, '').trim()
      : '';
  if (!url || !title || !Number.isFinite(meters) || !Number.isFinite(seconds))
    return null;
  return { title, meters, seconds, url };
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function weatherIcon(value: unknown): string | undefined {
  const url = text(value);
  return url && /^https:\/\/maps\.gstatic\.com\/weather\/[\w/.-]+$/.test(url)
    ? url
    : undefined;
}

function weatherWhen(raw: any): string | undefined {
  const d = raw?.displayDateTime ?? raw?.displayDate;
  if (
    Number.isFinite(d?.year) &&
    Number.isFinite(d?.month) &&
    Number.isFinite(d?.day)
  ) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
    return Number.isFinite(d.hours) ? `${date}T${pad(d.hours)}:00` : date;
  }
  return text(raw?.interval?.startTime);
}

/**
 * An entry matching the shape of the Weather API: either `currentConditions`, an hour (`temperature`),
 * or a day (`daytimeForecast` + `maxTemperature`). The exact shape of the wrapper changes between
 * current and forecast requests, so the entry is searched for instead of using a fixed path.
 */
function weatherEntry(
  raw: any,
  inherited: { place?: string; url?: string },
): MapWeather | null {
  const daily = raw?.daytimeForecast && raw?.maxTemperature;
  const condition = (daily ? raw.daytimeForecast : raw)?.weatherCondition;
  const temp = daily ? raw.maxTemperature : raw?.temperature;
  const degrees = num(temp?.degrees);
  const description = text(condition?.description?.text);
  if (degrees === undefined || !description) return null;
  const precipitation = (daily ? raw.daytimeForecast : raw)?.precipitation;
  const wind = (daily ? raw.daytimeForecast : raw)?.wind;
  const speed = num(wind?.speed?.value);
  return {
    place: inherited.place,
    when: weatherWhen(raw),
    condition: description,
    icon: weatherIcon(condition?.iconBaseUri),
    temperature: degrees,
    low: daily ? num(raw.minTemperature?.degrees) : undefined,
    unit: temp?.unit === 'FAHRENHEIT' ? 'F' : 'C',
    feelsLike: num(
      (daily ? raw.feelsLikeMaxTemperature : raw?.feelsLikeTemperature)
        ?.degrees,
    ),
    humidity: num((daily ? raw.daytimeForecast : raw)?.relativeHumidity),
    uvIndex: num((daily ? raw.daytimeForecast : raw)?.uvIndex),
    rain: num(precipitation?.probability?.percent),
    wind:
      speed === undefined
        ? undefined
        : {
            speed,
            unit: wind?.speed?.unit === 'MILES_PER_HOUR' ? 'mph' : 'km/h',
            direction: text(wind?.direction?.cardinal),
          },
    url: inherited.url,
  };
}

function weatherContext(raw: any, inherited: { place?: string; url?: string }) {
  const title = text(raw?.attribution?.title)?.replace(SUFFIX, '').trim();
  return {
    place:
      text(raw?.formattedAddress) ??
      text(raw?.location?.formattedAddress) ??
      text(raw?.address) ??
      text(raw?.displayName?.text) ??
      (typeof raw?.displayName === 'string'
        ? text(raw.displayName)
        : undefined) ??
      inherited.place ??
      title,
    url: googleUrl(raw?.attribution?.url) ?? inherited.url,
  };
}

function collectWeather(
  raw: any,
  inherited: { place?: string; url?: string },
  out: MapWeather[],
  depth = 0,
) {
  if (!raw || typeof raw !== 'object' || depth > 4) return;
  if (Array.isArray(raw)) {
    for (const item of raw) collectWeather(item, inherited, out, depth + 1);
    return;
  }
  const context = weatherContext(raw, inherited);
  const entry = weatherEntry(raw, context);
  if (entry) {
    out.push(entry);
    return;
  }
  for (const value of Object.values(raw))
    collectWeather(value, context, out, depth + 1);
}

function routePoint(raw: any): RoutePoint | undefined {
  const name = text(raw?.name) ?? text(raw?.address);
  if (!name) return undefined;
  const lat = num(raw?.lat_lng?.latitude ?? raw?.latLng?.latitude);
  const lng = num(raw?.lat_lng?.longitude ?? raw?.latLng?.longitude);
  const placeId = text(raw?.place_id) ?? text(raw?.placeId);
  return {
    name,
    ...(placeId && { placeId }),
    ...(lat !== undefined && lng !== undefined && { lat, lng }),
  };
}

/**
 * The other form of `compute_routes`: `{response: {route: {distanceMeters, duration, origin,
 * destination, travelMode}}}`, without attribution link. The link is constructed to Google Maps using
 * the place ids, which is what Google requests to be quoted alongside the route.
 */
function resolvedRoute(raw: any): MapRoute | null {
  const origin = routePoint(raw?.origin),
    destination = routePoint(raw?.destination);
  const meters = Number(raw?.distanceMeters);
  const seconds = Number.parseFloat(String(raw?.duration ?? ''));
  if (
    !origin ||
    !destination ||
    !Number.isFinite(meters) ||
    !Number.isFinite(seconds)
  )
    return null;
  const mode =
    raw?.travelMode === 'WALK'
      ? 'WALK'
      : raw?.travelMode === 'DRIVE'
        ? 'DRIVE'
        : undefined;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin.name);
  if (origin.placeId) url.searchParams.set('origin_place_id', origin.placeId);
  url.searchParams.set('destination', destination.name);
  if (destination.placeId)
    url.searchParams.set('destination_place_id', destination.placeId);
  if (mode)
    url.searchParams.set('travelmode', mode === 'WALK' ? 'walking' : 'driving');
  return {
    title: `${origin.name} → ${destination.name}`,
    meters,
    seconds,
    url: url.href,
    origin,
    destination,
    mode,
  };
}

/** Places, routes, and weather from the `content[]` of a `tool_call_update`; `null` if there is no map data. */
export function mapDataFromToolContent(content: unknown): MapData | null {
  if (!Array.isArray(content)) return null;
  const data: MapData = { places: [], routes: [] };
  const weather: MapWeather[] = [];
  for (const block of content) {
    const text =
      block?.type === 'content' && block.content?.type === 'text'
        ? block.content.text
        : undefined;
    if (typeof text !== 'string' || !text.trimStart().startsWith('{')) continue;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(json?.places))
      for (const raw of json.places) {
        const p = place(raw);
        if (p) data.places.push(p);
      }
    if (Array.isArray(json?.routes))
      for (const raw of json.routes) {
        const r = route(raw);
        if (r) data.routes.push(r);
      }
    const resolved = json?.response?.route ?? json?.route;
    if (resolved) {
      const r = resolvedRoute(resolved);
      if (r) data.routes.push(r);
    } else if (!json?.places && !json?.routes)
      collectWeather(json, {}, weather);
  }
  if (weather.length) data.weather = weather;
  return data.places.length || data.routes.length || weather.length
    ? data
    : null;
}

const weatherKey = (w: MapWeather) => `${w.place ?? ''}|${w.when ?? 'now'}`;

export function mergeMapData(
  base: MapData | undefined,
  next: MapData,
): MapData {
  const places = [...(base?.places ?? [])],
    routes = [...(base?.routes ?? [])];
  const weather = [...(base?.weather ?? [])];
  for (const p of next.places)
    if (!places.some((x) => x.id === p.id)) places.push(p);
  for (const r of next.routes)
    if (!routes.some((x) => x.url === r.url)) routes.push(r);
  for (const w of next.weather ?? []) {
    const at = weather.findIndex((x) => weatherKey(x) === weatherKey(w));
    if (at === -1) weather.push(w);
    else weather[at] = w;
  }
  return weather.length ? { places, routes, weather } : { places, routes };
}

// ── Route Path Drawing ───────────────────────────────────────────────────────────────
// `compute_routes` does not return geometry or the arguments it was called with (goose sends
// `rawInput: {}`). What it does provide is the link `…/maps/dir/<origin>/<destination>`: from there come
// the endpoints, and the browser requests the path from the Routes API. A standalone name ("Café Negro")
// cannot be resolved by Routes, so if it matches a place from the same turn, its place id is used.

export type Waypoint =
  | { placeId: string }
  | { address: string }
  | { location: { latLng: { latitude: number; longitude: number } } };

/** Origen y destino tal como el agente se los dio a `compute_routes`. */
export function routeEndpoints(route: MapRoute): [string, string] | null {
  if (route.origin && route.destination)
    return [route.origin.name, route.destination.name];
  try {
    const parts = new URL(route.url).pathname.split('/').filter(Boolean);
    const at = parts.indexOf('dir');
    if (at === -1 || parts.length < at + 3) return null;
    const [origin, destination] = parts
      .slice(at + 1, at + 3)
      .map(decodeURIComponent);
    return origin && destination ? [origin, destination] : null;
  } catch {
    return null;
  }
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** An endpoint for the Routes API: what the tool has already resolved takes precedence over searching by name. */
export function routeWaypoint(
  point: RoutePoint | undefined,
  name: string,
  places: MapPlace[],
): Waypoint {
  if (point?.placeId) return { placeId: point.placeId };
  if (point?.lat !== undefined && point.lng !== undefined)
    return {
      location: { latLng: { latitude: point.lat, longitude: point.lng } },
    };
  return waypoint(name, places);
}

export function waypoint(name: string, places: MapPlace[]): Waypoint {
  const match = places.find((p) => normalize(p.name) === normalize(name));
  return match ? { placeId: match.id } : { address: name };
}

/** Walking is about 1.4 m/s; nothing by car is that slow unless in an impossible traffic jam. */
export function travelMode(route: MapRoute): 'WALK' | 'DRIVE' {
  if (route.mode) return route.mode;
  return route.seconds > 0 && route.meters / route.seconds < 2.5
    ? 'WALK'
    : 'DRIVE';
}

/** The route is valid if it covers approximately the same distance as stated by the tool (±20%); otherwise, it resolved to a different place. */
export function sameRoute(meters: number, expected: number) {
  return expected > 0 && Math.abs(meters - expected) / expected <= 0.2;
}

/** Google encoded polyline → points. https://developers.google.com/maps/documentation/utilities/polylinealgorithm */
export function decodePolyline(
  encoded: string,
): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0,
    lat = 0,
    lng = 0;
  const next = () => {
    let result = 0,
      shift = 0,
      byte: number;
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
