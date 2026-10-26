import {
  type RouteConfig,
  index,
  layout,
  route,
} from '@react-router/dev/routes';

export default [
  // Resource routes: the API consumed by the browser (including SSE).
  route('api/demo', 'routes/api.demo.ts'),
  route('api/model-preference', 'routes/api.model-preference.ts'),
  route('api/extensions', 'routes/api.extensions.ts'),
  route('api/whatsapp', 'routes/api.whatsapp.ts'),
  route('api/lathe/jobs', 'routes/api.lathe.jobs.ts'),
  route('api/whatsapp/events', 'routes/api.whatsapp.events.ts'),
  route('api/conversations', 'routes/api.conversations.ts'),
  route(
    'api/conversations/:id/events',
    'routes/api.conversations.$id.events.ts',
  ),
  route(
    'api/conversations/:id/messages',
    'routes/api.conversations.$id.messages.ts',
  ),
  route(
    'api/conversations/:id/uploads',
    'routes/api.conversations.$id.uploads.ts',
  ),
  route('api/conversations/:id/close', 'routes/api.conversations.$id.close.ts'),
  route(
    'api/conversations/:id/cancel',
    'routes/api.conversations.$id.cancel.ts',
  ),
  route(
    'api/conversations/:id/config',
    'routes/api.conversations.$id.config.ts',
  ),
  route(
    'api/conversations/:id/permissions',
    'routes/api.conversations.$id.permissions.ts',
  ),

  // Same hub and chat, without shell: to embed in an iframe (see lib/embed.ts).
  route('embed', 'routes/_embed.tsx', [
    index('routes/hub.tsx', { id: 'embed/hub' }),
    route('c/:id', 'routes/chat.tsx', { id: 'embed/chat' }),
  ]),

  layout('routes/_shell.tsx', [
    index('routes/hub.tsx'),
    route('c/nuevo', 'routes/new-chat.tsx'),
    route('c/:id', 'routes/chat.tsx'),
    route('artifacts', 'routes/artifacts.tsx'),
    route('sessions', 'routes/sessions.tsx'),
    route('recipes', 'routes/recipes.tsx'),
    route('skills', 'routes/skills.tsx'),
    route('apps', 'routes/apps.tsx'),
    route('schedules', 'routes/schedules.tsx'),
    route('extensions', 'routes/extensions.tsx'),
    route('whatsapp', 'routes/whatsapp.tsx'),
    route('settings', 'routes/settings.tsx'),
    route('gmaps', 'routes/gmaps.tsx'),
  ]),
  // Lathe simulator: full screen, outside the shell (docs/lathe/plan.md).
  route('lathe', 'routes/lathe.tsx'),
  route('lathe/guide.md', 'routes/lathe.guide.ts'),
  route('test', 'routes/test.tsx'),
] satisfies RouteConfig;
