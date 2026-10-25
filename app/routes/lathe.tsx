/**
 * CNC lathe simulator (docs/lathe/plan.md). Everything lives in `app/lathe/`; this route only
 * mounts it outside the shell so the 3D stage gets the whole screen, and tells it whether the
 * lathe agent can be used from this browser (same owner gate as /whatsapp).
 */
import { redirect, useLoaderData } from 'react-router';
import { adminGate } from '~/.server/admin-gate';
import { latheAgentConfigured } from '~/.server/lathe-agent';
import { LatheApp, type AgentAccess } from '~/lathe/ui/LatheApp';
import type { Route } from './+types/lathe';

export function meta() {
  return [{ title: 'Lathe simulator · Robbie' }];
}

export function loader({ request }: Route.LoaderArgs) {
  if (!latheAgentConfigured()) return { agent: 'unconfigured' as AgentAccess };
  const gate = adminGate(request);
  // A good `?key=` sets the cookie; don't leave the key in the address bar or history.
  if (gate.ok && gate.setCookie) throw redirect('/lathe', { headers: { 'Set-Cookie': gate.setCookie } });
  return { agent: (gate.ok ? 'ready' : 'locked') as AgentAccess };
}

export default function Lathe() {
  const { agent } = useLoaderData<typeof loader>();
  return <LatheApp agent={agent} />;
}
