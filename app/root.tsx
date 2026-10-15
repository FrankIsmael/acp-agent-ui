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
import { DEFAULT_THEME, themeClass, themeFromCookies } from './lib/theme';

export const middleware = [demoMiddleware];

export function loader({ request }: Route.LoaderArgs) {
  const cookies = request.headers.get('cookie');
  return {
    demo: demoEnabled(),
    theme: themeFromCookies(cookies),
    locale: localeFromCookies(cookies),
    origin: publicOrigin(request),
    ENV: {
      GOOGLE_MAPS_KEY: process.env.GM_DEMO_KEY,
    },
  };
}

// Link previews (WhatsApp, LinkedIn, X…) need absolute URLs. Behind Caddy with DEMO on,
// Express does not trust the proxy, so request.url says http: prefer the configured domain.
function publicOrigin(request: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.APP_DOMAIN) return `https://${process.env.APP_DOMAIN}`;
  return new URL(request.url).origin;
}

const SITE_TITLE = 'Robbie · Your AI agent, on its own machine';
const SITE_DESCRIPTION =
  'Robbie is an AI agent that works on its own machine: it runs tools, writes code, builds apps and researches the web. Chat with it from the web or WhatsApp.';

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
    block('.robbie', themes.robbie.tokens),
    // Without an explicit class, the system preference is used.
    `@media (prefers-color-scheme: dark){${block(
      ':root:not(.light):not(.dark):not(.aura):not(.robbie)',
      themes.dark.tokens,
    )}}`,
  ].join('\n');
}

export function links() {
  return [
    { rel: 'icon', type: 'image/png', href: '/favicon.png' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  ];
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout also renders error pages, where the loader may not have run;
  // in those cases it falls back to the system theme.
  const data = useRouteLoaderData<typeof loader>('root');
  const locale = data?.locale ?? DEFAULT_LOCALE;
  const ogImage = `${data?.origin ?? ''}/og.png`;
  return (
    <I18nProvider locale={locale}>
      <html lang={locale} className={themeClass(data?.theme ?? DEFAULT_THEME)}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <Meta />
          <title>Robbie</title>
          <meta name="description" content={SITE_DESCRIPTION} />
          <meta name="application-name" content="Robbie" />
          <meta name="apple-mobile-web-app-title" content="Robbie" />
          <meta name="author" content="Ismael Francisco" />
          <meta name="theme-color" content="#111214" />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="Robbie" />
          <meta property="og:title" content={SITE_TITLE} />
          <meta property="og:description" content={SITE_DESCRIPTION} />
          {data?.origin && <meta property="og:url" content={data.origin} />}
          <meta property="og:image" content={ogImage} />
          <meta property="og:image:type" content="image/png" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta
            property="og:image:alt"
            content="Robbie, a pixel-art robot: your AI agent, on its own machine"
          />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={SITE_TITLE} />
          <meta name="twitter:description" content={SITE_DESCRIPTION} />
          <meta name="twitter:image" content={ogImage} />
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
