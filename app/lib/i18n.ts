import en from "../locales/en.json" with { type: "json" };
import es from "../locales/es.json" with { type: "json" };

export type Locale = "en" | "es";
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";
export const locales: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];
export type MessageValues = Record<string, string | number>;
const catalogs: Record<Locale, Record<string, string>> = { en, es };
// The ACP server still emits app-owned Spanish errors. Resolve those at the UI
// boundary without changing the protocol or translating agent/user content.
const legacyMessageKeys = new Map(Object.entries(es).map(([key, value]) => [value, key]));
const lookup = (catalog: Record<string, string>, key: string) =>
  Object.hasOwn(catalog, key) ? catalog[key] : undefined;
const legacyErrorPatterns = Object.entries(es)
  .filter(([key, value]) => key.startsWith("errors.") && value.includes("{"))
  .map(([key, value]) => {
    const names: string[] = [];
    const pattern = value.split(/(\{\w+\})/g).map(part => {
      if (/^\{\w+\}$/.test(part)) {
        names.push(part.slice(1, -1));
        return "(.*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    return { key, names, pattern: new RegExp(`^${pattern}$`, "s") };
  });

export function parseLocale(value: unknown): Locale {
  return value === "es" ? "es" : DEFAULT_LOCALE;
}

export function localeFromCookies(cookieHeader: string | null): Locale {
  const value = cookieHeader?.match(/(?:^|;\s*)locale=([^;]*)/)?.[1];
  try { return parseLocale(value ? decodeURIComponent(value) : null); }
  catch { return DEFAULT_LOCALE; }
}

export function applyLocale(locale: Locale) {
  const next = parseLocale(locale);
  document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

export function createTranslator(locale: Locale) {
  const catalog = catalogs[locale];
  const plurals = new Intl.PluralRules(locale);
  return (key: string, values?: MessageValues, fallback?: string): string => {
    key = legacyMessageKeys.get(key) ?? key;
    if (!lookup(en, key) && !values) {
      for (const entry of legacyErrorPatterns) {
        const match = key.match(entry.pattern);
        if (!match) continue;
        key = entry.key;
        values = Object.fromEntries(entry.names.map((name, index) => [name, match[index + 1]]));
        if (values.code === "sin código") values.code = catalogs[locale]["no code"];
        break;
      }
    }
    const pluralKey = typeof values?.count === "number"
      ? `${key}.${plurals.select(values.count)}` : key;
    const raw = lookup(catalog, pluralKey) ?? lookup(catalog, key)
      ?? lookup(en, pluralKey) ?? lookup(en, key) ?? fallback ?? key;
    return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
      values && Object.hasOwn(values, name) ? String(values[name]) : match);
  };
}
