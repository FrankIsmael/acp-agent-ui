import { I18nProvider, useI18n } from '~/i18n';
import { DEFAULT_LOCALE, localeFromCookies } from './lib/i18n';
import { demoMiddleware } from './.server/demo-middleware';
import { demoEnabled } from './.server/demo';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from 'react-router';

import type { Route } from './+types/root';
import './app.css';
import { themes } from './theme/theme-tokens';
import { themeClass, themeFromCookies } from './lib/theme';

export const middleware = [demoMiddleware];

export function loader({ request }: Route.LoaderArgs) {
  const cookies = request.headers.get('cookie');
  return {
    demo: demoEnabled(),
    theme: themeFromCookies(cookies),
    locale: localeFromCookies(cookies),
    ENV: {
      GOOGLE_MAPS_KEY: process.env.GM_DEMO_KEY,
    },
  };
}

// Theme tokens are static CSS; server sets the theme class on <html> from cookies to prevent SSR mismatch.
function tokensToCss(): string {
  const block = (selector: string, tokens: Record<string, string>) =>
    `${selector}{${Object.entries(tokens)
      .map(([k, v]) => `${k}:${v};`)
      .join('')}}`;
  return [
    block(':root', themes.light.tokens),
    block('.dark', themes.dark.tokens),
    block('.aura', themes.aura.tokens),
    // Without an explicit class, the system preference is used.
    `@media (prefers-color-scheme: dark){${block(
      ':root:not(.light):not(.dark):not(.aura)',
      themes.dark.tokens,
    )}}`,
  ].join('\n');
}

export function links() {
  return [{ rel: 'icon', type: 'image/png', href: '/favicon.png' }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout also renders error pages, where the loader may not have run;
  // in those cases it falls back to the system theme.
  const data = useRouteLoaderData<typeof loader>('root');
  const locale = data?.locale ?? DEFAULT_LOCALE;
  return (
    <I18nProvider locale={locale}>
      <html lang={locale} className={themeClass(data?.theme ?? 'system')}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <Meta />
          <title>Agent</title>
          <meta
            name="description"
            content="UI for an Agent running inside a microVM, communicating via ACP"
          />
          <Links />
          <style dangerouslySetInnerHTML={{ __html: tokensToCss() }} />
        </head>
        <body className="bg-background-primary text-text-primary antialiased">
          {children}
          <ScrollRestoration />
          <script
            dangerouslySetInnerHTML={{
              __html: `window.ENV = ${JSON.stringify(data?.ENV)};`,
            }}
          />
          <Scripts />
        </body>
      </html>
    </I18nProvider>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useI18n();
  let message = t('Something went wrong');
  let details = t('An unexpected error occurred.');
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details =
      error.status === 404
        ? t('This page does not exist.')
        : typeof error.data === 'string'
          ? t(error.data)
          : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-4xl font-light">{message}</h1>
      <p className="text-text-secondary">{details}</p>
      {stack && (
        <pre className="w-full max-w-2xl overflow-x-auto rounded-lg border border-border-primary p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
