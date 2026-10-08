/**
 * El mapa de un turno: los lugares que encontraron las herramientas de Google Maps, numerados,
 * y las rutas trazadas. Grounding Lite sólo da distancia y duración: el trazo lo pide el navegador a
 * Routes API con la misma llave, y se descarta si no recorre lo mismo que dijo la tool.
 *
 * La lista va siempre y con enlace a cada lugar: Google pide la fuente a un clic del contenido.
 * El mapa sólo si hay llave (`window.ENV.GOOGLE_MAPS_KEY`) y ya en el navegador.
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '~/i18n';
import { useGoogleMapsScript } from '~/hooks/useGoogleMapsScript';
import {
  decodePolyline, routeEndpoints, sameRoute, travelMode, waypoint,
  type MapData, type MapPlace, type MapRoute,
} from '~/lib/maps';

const distance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const duration = (s: number) => {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

interface InnerMap {
  fitBounds(bounds: unknown, padding?: number): void;
  setCenter(center: LatLng): void;
  setZoom(zoom: number): void;
}
type LatLng = { lat: number; lng: number };
type Maps = {
  LatLngBounds: new () => { extend(p: LatLng): void };
  Polyline: new (options: Record<string, unknown>) => { setMap(map: InnerMap | null): void };
};

/** Un trazo dibujable; `from`/`to` sólo cuando ese extremo no es ya un lugar numerado. */
interface Path { url: string; points: LatLng[]; from?: LatLng; to?: LatLng }

// Una petición por ruta y pestaña: volver a pintar el hilo no gasta cuota otra vez.
const paths = new Map<string, Promise<LatLng[] | null>>();

function fetchPath(apiKey: string, route: MapRoute, places: MapPlace[]) {
  const cached = paths.get(route.url);
  if (cached) return cached;
  const ends = routeEndpoints(route);
  const request = !ends ? Promise.resolve(null) : fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
      'x-goog-fieldmask': 'routes.distanceMeters,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({ origin: waypoint(ends[0], places), destination: waypoint(ends[1], places), travelMode: travelMode(route) }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      const found = json?.routes?.[0];
      if (!found?.polyline?.encodedPolyline || !sameRoute(found.distanceMeters, route.meters)) return null;
      return decodePolyline(found.polyline.encodedPolyline);
    })
    .catch(() => null);
  paths.set(route.url, request);
  return request;
}

function RoutesMap({ apiKey, places, routes }: { apiKey: string; places: MapPlace[]; routes: MapRoute[] }) {
  const { t } = useI18n();
  const loaded = useGoogleMapsScript(apiKey);
  const ref = useRef<HTMLElement>(null);
  const [drawn, setDrawn] = useState<Path[]>([]);
  // Con el elemento ya definido, React 19 pone `center` y `position` como propiedades, y Google
  // rechaza ahí el texto "lat,lng": van como LatLngLiteral. Un objeto nuevo en cada render
  // volvería a centrar el mapa encima del encuadre, así que se calcula una vez por lista de
  // lugares. Sin lugares el centro da igual: el encuadre llega con el primer trazo.
  const center = useMemo(() => places.length
    ? { lat: places.reduce((sum, p) => sum + p.lat, 0) / places.length, lng: places.reduce((sum, p) => sum + p.lng, 0) / places.length }
    : { lat: 20, lng: 0 }, [places]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(routes.map(async (route): Promise<Path | null> => {
      const points = await fetchPath(apiKey, route, places);
      const ends = routeEndpoints(route);
      if (!points?.length || !ends) return null;
      const isPlace = (name: string) => 'placeId' in waypoint(name, places);
      return {
        url: route.url, points,
        from: isPlace(ends[0]) ? undefined : points[0],
        to: isPlace(ends[1]) ? undefined : points[points.length - 1],
      };
    })).then((all) => { if (!cancelled) setDrawn(all.filter((p): p is Path => !!p)); });
    return () => { cancelled = true; };
  }, [apiKey, places, routes]);

  // Trazos y encuadre. `innerMap` aparece cuando el elemento ya se definió.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let lines: { setMap(map: InnerMap | null): void }[] = [];
    customElements.whenDefined('gmp-map').then(() => {
      const map = (ref.current as (HTMLElement & { innerMap?: InnerMap }) | null)?.innerMap;
      const maps = (window as { google?: { maps?: Maps } }).google?.maps;
      if (cancelled || !map || !maps) return;
      lines = drawn.map((p) => new maps.Polyline({ path: p.points, map, strokeColor: '#1a73e8', strokeOpacity: 0.9, strokeWeight: 5 }));
      const points = [...places, ...drawn.flatMap((p) => p.points)];
      if (points.length === 1) {
        map.setCenter(points[0]);
        map.setZoom(15);
      } else if (points.length > 1) {
        const bounds = new maps.LatLngBounds();
        for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng });
        map.fitBounds(bounds, 24);
      }
    });
    return () => { cancelled = true; for (const line of lines) line.setMap(null); };
  }, [loaded, places, drawn]);

  if (!loaded) return <div className="h-80 animate-pulse bg-background-secondary" />;
  const pin = (label: string) => (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-background-inverse text-xs font-semibold text-text-inverse shadow">
      {label}
    </span>
  );
  return (
    <div className="h-80" role="region" aria-label={t('Map of the places mentioned')}>
      <gmp-map ref={ref} center={center} zoom={places.length ? 13 : 2} map-id="DEMO_MAP_ID" style={{ height: '100%' }}>
        {places.map((p, i) => (
          <gmp-advanced-marker key={p.id} position={{ lat: p.lat, lng: p.lng }} title={p.name}>
            {pin(String(i + 1))}
          </gmp-advanced-marker>
        ))}
        {drawn.flatMap((p) => [
          p.from && <gmp-advanced-marker key={`${p.url}:a`} position={p.from}>{pin('A')}</gmp-advanced-marker>,
          p.to && <gmp-advanced-marker key={`${p.url}:b`} position={p.to}>{pin('B')}</gmp-advanced-marker>,
        ])}
      </gmp-map>
    </div>
  );
}

// Un fallo de Google Maps (llave, cuota, un valor que no acepta) se queda en el mapa: la lista
// de lugares sigue y el resto del hilo no se cae.
class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[maps]', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function MapCard({ data }: { data: MapData }) {
  // `window` sólo existe en el navegador: leer la llave tras montar evita que el HTML del
  // servidor y el primer render del cliente no coincidan.
  const [apiKey, setApiKey] = useState('');
  useEffect(() => setApiKey(window.ENV?.GOOGLE_MAPS_KEY ?? ''), []);
  const { places, routes } = data;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border-secondary">
      {apiKey && (places.length > 0 || routes.length > 0) && (
        <MapBoundary>
          <RoutesMap apiKey={apiKey} places={places} routes={routes} />
        </MapBoundary>
      )}
      <ol className="divide-y divide-border-secondary text-sm">
        {places.map((p, i) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background-inverse text-[11px] font-semibold text-text-inverse">
              {i + 1}
            </span>
            <a href={p.url} target="_blank" rel="noopener noreferrer" className="truncate text-text-primary hover:underline">
              {p.name}
            </a>
          </li>
        ))}
        {routes.map((r) => (
          <li key={r.url} className="flex items-center justify-between gap-3 px-3 py-2 text-text-secondary">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">
              {r.title}
            </a>
            <span className="shrink-0 text-xs text-text-tertiary">
              {distance(r.meters)} · {duration(r.seconds)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
