/**
 * The routes a turn computed with `compute_routes` (Google Maps Grounding Lite): duration and
 * distance, shown above the agent's answer like the Google Maps demo. The map below draws them;
 * this card carries the source link, which Google requires next to the content.
 */
import { Car, Footprints } from 'lucide-react';
import { useI18n } from '~/i18n';
import type { MapRoute } from '~/lib/maps';
import { travelMode } from '~/lib/maps';

// English reads miles, as in the demo; Spanish reads kilometres.
function distance(m: number, locale: string) {
  if (locale === 'en') {
    const mi = m / 1609.344;
    return mi < 0.1 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function duration(s: number, locale: string) {
  const min = Math.max(1, Math.floor(s / 60));
  const h = locale === 'en' ? 'hr' : 'h';
  return min < 60
    ? `${min} min`
    : `${Math.floor(min / 60)} ${h} ${min % 60} min`;
}

function RouteItem({ route }: { route: MapRoute }) {
  const { t, locale } = useI18n();
  const Mode = travelMode(route) === 'WALK' ? Footprints : Car;
  const stat = (label: string, value: string) => (
    <div className="flex flex-1 flex-col items-center gap-0.5 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-success">
        {label}
      </span>
      <span className="text-lg font-bold text-text-primary">{value}</span>
    </div>
  );
  return (
    <div
      className="rounded-xl border border-border-success bg-background-success/10 px-3 py-2 text-sm"
      aria-label={t('Route: {title}', { title: route.title })}
    >
      <a
        href={route.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 items-center gap-2 text-xs text-text-secondary hover:underline"
        title={route.title}
      >
        <Mode className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{route.title}</span>
      </a>
      <div className="mt-1 flex items-stretch divide-x divide-border-success">
        {stat(t('Duration'), duration(route.seconds, locale))}
        {stat(t('Distance'), distance(route.meters, locale))}
      </div>
    </div>
  );
}

export function RouteCard({ routes }: { routes: MapRoute[] }) {
  return (
    <div className="mb-3 flex flex-col gap-2">
      {routes.map((route) => (
        <RouteItem key={route.url} route={route} />
      ))}
    </div>
  );
}
