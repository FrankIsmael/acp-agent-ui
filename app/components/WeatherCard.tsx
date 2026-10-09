/**
 * The weather a turn looked up with `lookup_weather` (Google Maps Grounding Lite): one card per
 * lookup, shown above the agent's answer, like the Google Maps demo. The source link goes with
 * the card: Google requires citing it next to the content.
 */
import { useI18n } from "~/i18n";
import type { MapWeather } from "~/lib/maps";

// The API says "NORTH_EAST"; the card says "North east".
const cardinal = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

function when(value: string, locale: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(value.length === 10 ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}

function WeatherItem({ weather: w }: { weather: MapWeather }) {
  const { t, locale } = useI18n();
  const degrees = (n: number) => `${Math.round(n)}°`;
  return (
    <div
      className="rounded-xl border border-border-info bg-background-info/20 p-3 text-sm text-text-primary"
      aria-label={
        w.place ? t("Weather for {place}", { place: w.place }) : t("Weather")
      }
    >
      {(w.place || w.when) && (
        <div className="flex items-baseline justify-between gap-2">
          {w.place && (
            <p className="truncate text-base font-semibold" title={w.place}>
              {w.place}
            </p>
          )}
          {w.when && (
            <p className="shrink-0 text-xs text-text-secondary">
              {when(w.when, locale)}
            </p>
          )}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* `{iconBaseUri}[_dark].svg`: the theme is a `.dark` class, not the system setting. */}
          {w.icon && (
            <>
              <img
                src={`${w.icon}.svg`}
                alt=""
                className="h-10 w-10 shrink-0 dark:hidden"
                loading="lazy"
              />
              <img
                src={`${w.icon}_dark.svg`}
                alt=""
                className="hidden h-10 w-10 shrink-0 dark:block"
                loading="lazy"
              />
            </>
          )}
          <div className="min-w-0">
            <p className="text-xl font-bold sm:text-2xl">
              {degrees(w.temperature)}
              {w.unit}
              {w.low !== undefined && (
                <span className="ml-1 text-sm font-normal text-text-primary">
                  / {degrees(w.low)}
                </span>
              )}
            </p>
            <p className="truncate text-xs text-text-primary first-letter:uppercase">
              {w.condition}
            </p>
          </div>
        </div>
        <div className="shrink-0 space-y-0.5 pl-2 text-right text-xs text-text-primary">
          {w.feelsLike !== undefined && (
            <p>
              {t("Feels like {degrees}", { degrees: degrees(w.feelsLike) })}
            </p>
          )}
          {w.humidity !== undefined && (
            <p>{t("Humidity: {value}%", { value: w.humidity })}</p>
          )}
          {w.rain !== undefined && (
            <p>{t("Rain: {value}%", { value: w.rain })}</p>
          )}
          {w.uvIndex !== undefined && (
            <p>{t("UV index: {value}", { value: w.uvIndex })}</p>
          )}
          {w.wind && (
            <p>
              {t("Wind: {value}", {
                value: `${Math.round(w.wind.speed)} ${w.wind.unit}`,
              })}
              {w.wind.direction && <> · {cardinal(w.wind.direction)}</>}
            </p>
          )}
        </div>
      </div>
      {w.url && (
        <a
          href={w.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-[11px] text-text-tertiary hover:underline"
        >
          Google Maps
        </a>
      )}
    </div>
  );
}

export function WeatherCard({ weather }: { weather: MapWeather[] }) {
  return (
    <div className="mb-3 flex flex-col gap-2">
      {weather.map((w, i) => (
        <WeatherItem key={`${w.place ?? ""}|${w.when ?? i}`} weather={w} />
      ))}
    </div>
  );
}
