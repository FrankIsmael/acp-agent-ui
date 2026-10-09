/**
 * The map for a turn: the places found by the Google Maps tools, numbered,
 * and the routes drawn. Grounding Lite only provides distance and duration: the route itself
 * is requested by the browser from the Routes API with the same key, and discarded if it does not
 * match what the tool reported.
 *
 * The list is always shown with a link to each place: Google requires citing the source one click away from the content.
 * Routes are listed, with their link, by `RouteCard` above the answer; here they are only drawn.
 * The map is rendered only if there is a key (`window.ENV.GOOGLE_MAPS_KEY`) and we're already in the browser.
 */
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "~/i18n";
import { useGoogleMapsScript } from "~/hooks/useGoogleMapsScript";
import {
  decodePolyline,
  routeEndpoints,
  routeWaypoint,
  sameRoute,
  travelMode,
  waypoint,
  type MapData,
  type MapPlace,
  type MapRoute,
} from "~/lib/maps";

interface InnerMap {
  fitBounds(bounds: unknown, padding?: number): void;
  setCenter(center: LatLng): void;
  setZoom(zoom: number): void;
}
type LatLng = { lat: number; lng: number };
type Maps = {
  LatLngBounds: new () => { extend(p: LatLng): void };
  Polyline: new (options: Record<string, unknown>) => {
    setMap(map: InnerMap | null): void;
  };
};

/** A drawable path; `from`/`to` only when that endpoint is not already a numbered place. */
interface Path {
  url: string;
  points: LatLng[];
  from?: LatLng;
  to?: LatLng;
}

// One request per route and tab: repainting the thread doesn't consume quota again.
const paths = new Map<string, Promise<LatLng[] | null>>();

function fetchPath(apiKey: string, route: MapRoute, places: MapPlace[]) {
  const cached = paths.get(route.url);
  if (cached) return cached;
  const ends = routeEndpoints(route);
  const request = !ends
    ? Promise.resolve(null)
    : fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
          "x-goog-fieldmask":
            "routes.distanceMeters,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: routeWaypoint(route.origin, ends[0], places),
          destination: routeWaypoint(route.destination, ends[1], places),
          travelMode: travelMode(route),
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          const found = json?.routes?.[0];
          if (
            !found?.polyline?.encodedPolyline ||
            !sameRoute(found.distanceMeters, route.meters)
          )
            return null;
          return decodePolyline(found.polyline.encodedPolyline);
        })
        .catch(() => null);
  paths.set(route.url, request);
  return request;
}

function RoutesMap({
  apiKey,
  places,
  routes,
  known,
}: {
  apiKey: string;
  places: MapPlace[];
  routes: MapRoute[];
  known: MapPlace[];
}) {
  const { t } = useI18n();
  // Route endpoints: first the pins of this round, then the places from previous rounds.
  // `known` is a new array on each streaming patch: it is checked by ids to avoid repeating the path.
  const knownIds = known.map((p) => p.id).join();
  const lookup = useMemo(() => [...places, ...known], [places, knownIds]);
  const loaded = useGoogleMapsScript(apiKey);
  const ref = useRef<HTMLElement>(null);
  const [drawn, setDrawn] = useState<Path[]>([]);
  // With the element already defined, React 19 sets `center` and `position` as properties,
  // and Google rejects the text "lat,lng" there: they must be LatLngLiteral.
  // Creating a new object on each render would re-center the map on the frame every time,
  // so it's calculated once per list of places. Without any places, the center doesn't matter:
  // the frame will be set with the first drawn path.
  const center = useMemo(
    () =>
      places.length
        ? {
            lat: places.reduce((sum, p) => sum + p.lat, 0) / places.length,
            lng: places.reduce((sum, p) => sum + p.lng, 0) / places.length,
          }
        : { lat: 20, lng: 0 },
    [places],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      routes.map(async (route): Promise<Path | null> => {
        const points = await fetchPath(apiKey, route, lookup);
        const ends = routeEndpoints(route);
        if (!points?.length || !ends) return null;
        // Show A/B only when the endpoint does not already have its numbered pin in this map.
        const isPlace = (name: string, id?: string) =>
          (!!id && places.some((p) => p.id === id)) ||
          "placeId" in waypoint(name, places);
        return {
          url: route.url,
          points,
          from: isPlace(ends[0], route.origin?.placeId) ? undefined : points[0],
          to: isPlace(ends[1], route.destination?.placeId)
            ? undefined
            : points[points.length - 1],
        };
      }),
    ).then((all) => {
      if (!cancelled) setDrawn(all.filter((p): p is Path => !!p));
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, places, routes, lookup]);

  // Paths and framing. `innerMap` appears when the element is already defined.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let lines: { setMap(map: InnerMap | null): void }[] = [];
    customElements.whenDefined("gmp-map").then(() => {
      const map = (
        ref.current as (HTMLElement & { innerMap?: InnerMap }) | null
      )?.innerMap;
      const maps = (window as { google?: { maps?: Maps } }).google?.maps;
      if (cancelled || !map || !maps) return;
      lines = drawn.map(
        (p) =>
          new maps.Polyline({
            path: p.points,
            map,
            strokeColor: "#1a73e8",
            strokeOpacity: 0.9,
            strokeWeight: 5,
          }),
      );
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
    return () => {
      cancelled = true;
      for (const line of lines) line.setMap(null);
    };
  }, [loaded, places, drawn]);

  if (!loaded)
    return <div className="h-80 animate-pulse bg-background-secondary" />;
  const pin = (label: string) => (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-background-inverse text-xs font-semibold text-text-inverse shadow">
      {label}
    </span>
  );
  return (
    <div
      className="h-80"
      role="region"
      aria-label={t("Map of the places mentioned")}
    >
      <gmp-map
        ref={ref}
        center={center}
        zoom={places.length ? 13 : 2}
        map-id="DEMO_MAP_ID"
        style={{ height: "100%" }}
      >
        {places.map((p, i) => (
          <gmp-advanced-marker
            key={p.id}
            position={{ lat: p.lat, lng: p.lng }}
            title={p.name}
          >
            {pin(String(i + 1))}
          </gmp-advanced-marker>
        ))}
        {drawn.flatMap((p) => [
          p.from && (
            <gmp-advanced-marker key={`${p.url}:a`} position={p.from}>
              {pin("A")}
            </gmp-advanced-marker>
          ),
          p.to && (
            <gmp-advanced-marker key={`${p.url}:b`} position={p.to}>
              {pin("B")}
            </gmp-advanced-marker>
          ),
        ])}
      </gmp-map>
    </div>
  );
}

// A Google Maps error (such as with the API key, quota limits, or an unacceptable value) will only affect the map itself:
// the list of places continues to display and the rest of the UI remains functional.
class MapBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[maps]", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function MapCard({
  data,
  known = [],
}: {
  data: MapData;
  known?: MapPlace[];
}) {
  // `window` only exists in the browser: reading the key after mount prevents the server HTML and the first client render from mismatching.
  const [apiKey, setApiKey] = useState("");
  useEffect(() => setApiKey(window.ENV?.GOOGLE_MAPS_KEY ?? ""), []);
  const { places, routes } = data;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border-secondary">
      {apiKey && (places.length > 0 || routes.length > 0) && (
        <MapBoundary>
          <RoutesMap
            apiKey={apiKey}
            places={places}
            routes={routes}
            known={known}
          />
        </MapBoundary>
      )}
      {places.length > 0 && (
        <ol className="divide-y divide-border-secondary text-sm">
          {places.map((p, i) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background-inverse text-[11px] font-semibold text-text-inverse">
                {i + 1}
              </span>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-text-primary hover:underline"
              >
                {p.name}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
