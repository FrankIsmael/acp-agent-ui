/**
 * Ajustes. El tema es real (escribe la clase en <html> y la recuerda); la
 * conexión con el agente se muestra en modo lectura porque vive en variables
 * de entorno del servidor.
 */
import { useI18n } from "~/i18n";
import { demoEnabled } from "~/.server/demo";
import { useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/settings";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { config } from "~/.server/acp";
import { cn } from "~/lib/utils";
import { applyTheme, themeFromCookies, type ThemePreference } from "~/lib/theme";
import { applyLocale, locales } from "~/lib/i18n";

export async function loader({ request }: Route.LoaderArgs) {
  return {
    theme: themeFromCookies(request.headers.get("cookie")),
    demo: demoEnabled(),
    wsUrl: demoEnabled() ? "" : config.wsUrl,
    cwd: demoEnabled() ? "" : config.cwd,
    agentBox: demoEnabled() ? "" : config.agentBox,
    idleMinutes: Math.round(config.idleMs / 60000),
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border-secondary py-3 last:border-b-0">
      <span className="text-xs uppercase tracking-wider text-text-tertiary">{label}</span>
      <span className="break-all font-mono text-sm text-text-primary">{value}</span>
    </div>
  );
}

export default function Settings() {
  const { locale, t } = useI18n();
  const OPCIONES: { id: ThemePreference; label: string }[] = [
    { id: "system", label: t("System") },
    { id: "light", label: t("Light") },
    { id: "dark", label: t("Dark") },
    { id: "aura", label: "aura" },
  ];
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  // Aplica en vivo y revalida para que el servidor vuelva a leer la cookie.
  const apply = (next: ThemePreference) => {
    applyTheme(next);
    revalidator.revalidate();
  };

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">{t("Settings")}</h1>

        <section className="mt-8" aria-labelledby="language-heading">
          <h2 id="language-heading" className="mb-1 text-sm font-semibold text-text-primary">{t("settings.language")}</h2>
          <p className="mb-3 text-xs text-text-secondary">{t("settings.languageHelp")}</p>
          <div className="flex flex-wrap gap-2">
            {locales.map(language => (
              <button
                key={language.id}
                lang={language.id}
                aria-pressed={locale === language.id}
                disabled={revalidator.state !== "idle"}
                onClick={() => { applyLocale(language.id); void revalidator.revalidate(); }}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm transition-colors disabled:opacity-50",
                  locale === language.id
                    ? "border-border-inverse bg-background-inverse text-text-inverse"
                    : "border-border-primary text-text-secondary hover:bg-background-secondary"
                )}
              >{language.label}</button>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">{t("Theme")}</h2>
          <div className="flex flex-wrap gap-2">
            {OPCIONES.map((opcion) => (
              <button
                key={opcion.id}
                onClick={() => apply(opcion.id)}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm transition-colors",
                  data.theme === opcion.id
                    ? "border-border-inverse bg-background-inverse text-text-inverse"
                    : "border-border-primary text-text-secondary hover:bg-background-secondary"
                )}
              >
                {opcion.label}
              </button>
            ))}
          </div>
        </section>

        {!data.demo && <section className="mt-10">
          <h2 className="mb-1 text-sm font-semibold text-text-primary">{t("Agent")}</h2>
          <p className="mb-3 text-xs text-text-secondary">
            {t("Configured using server environment variables: ACP_WS_URL, ACP_CWD, AGENT_BOX_ID, ACP_IDLE_MS.")}
          </p>
          <div className="rounded-xl border border-border-primary px-4">
            <Row label={t("ACP endpoint")} value={data.wsUrl} />
            <Row label={t("Working directory")} value={data.cwd} />
            <Row label={t("Agent box")} value={data.agentBox} />
            <Row label={t("Suspend after")} value={t("{minutes} min of inactivity", { minutes: data.idleMinutes })} />
          </div>
        </section>}
      </div>
    </MainPanelLayout>
  );
}
