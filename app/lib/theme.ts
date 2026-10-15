/**
 * El tema viaja en cookie, no en localStorage: con SSR el servidor tiene que
 * poder escribir la clase correcta en el HTML. Leerla en el cliente después de
 * pintar provoca un desajuste de hidratación y la página se cae.
 */
export type ThemeId = "light" | "dark" | "aura" | "robbie";
export type ThemePreference = ThemeId | "system";

export const THEME_COOKIE = "theme";

/** Lo que ve quien llega sin cookie: el tema de marca. */
export const DEFAULT_THEME: ThemePreference = "robbie";

export function parseTheme(value: string | null | undefined): ThemePreference {
  return value === "light" ||
    value === "dark" ||
    value === "aura" ||
    value === "robbie" ||
    value === "system"
    ? value
    : DEFAULT_THEME;
}

/** Lee la preferencia del encabezado Cookie (servidor). */
export function themeFromCookies(cookieHeader: string | null): ThemePreference {
  const match = cookieHeader?.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  return parseTheme(match ? decodeURIComponent(match[1]) : null);
}

/**
 * La clase que va en <html>. Sólo "system" va sin clase: ahí manda
 * prefers-color-scheme. "light" necesita la suya para ganarle a esa media query
 * cuando el sistema está en oscuro.
 */
export function themeClass(preference: ThemePreference): string {
  if (preference === "system") return "";
  // Robbie es oscuro: lleva también .dark para heredar los ajustes de app.css
  // (scrollbars, código, burbujas) y la variante dark: de Tailwind.
  return preference === "robbie" ? "dark robbie" : preference;
}

/** Guarda la preferencia y la aplica en vivo (cliente). */
export function applyTheme(preference: ThemePreference) {
  document.cookie = `${THEME_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`;
  const root = document.documentElement;
  root.classList.remove("light", "dark", "aura", "robbie");
  const cls = themeClass(preference);
  if (cls) root.classList.add(...cls.split(" "));
}
