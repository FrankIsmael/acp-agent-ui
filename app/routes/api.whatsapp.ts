import { consumeDemoIp } from '~/.server/demo-ip';
/**
 * /api/whatsapp — GET state + groups; POST `intent`: connect | pair | disconnect | logout | group.
 * The response always includes the full state, just like /api/extensions: the UI is updated
 * without a second round-trip.
 */
import {
  demoDb,
  demoUser,
  demoStatus,
  demoMessage,
  isFullAccess,
} from '~/.server/demo';
import { data } from 'react-router';
import type { Route } from './+types/api.whatsapp';
import { assertSameOrigin } from '~/.server/request-validation';
import { requireAdmin } from '~/.server/admin-gate';
import { whatsappChannel } from '~/.server/whatsapp';

async function respond(
  request: Request,
  intent: string | null,
  error: string | null = null,
  status = 200,
) {
  const channel = whatsappChannel(demoUser(request));
  // GET does refresh the group list (with a 60s cache); SSE never does.
  const groups = await channel.groups(intent === null);
  return data(
    { status: channel.status, groups, intent, ok: !error, error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function loader({ request }: Route.LoaderArgs) {
  if (!demoUser(request)) requireAdmin(request);
  return respond(request, null);
}

export async function action({ request }: Route.ActionArgs) {
  if (!demoUser(request)) requireAdmin(request);
  if (request.method !== 'POST')
    return respond(request, null, 'Method not allowed', 405);
  try {
    assertSameOrigin(request);
  } catch {
    return respond(request, null, 'Request from another origin rejected', 403);
  }
  const form = await request.formData().catch(() => null);
  if (!form) return respond(request, null, 'Invalid form', 400);
  const intent = form.get('intent');
  if (typeof intent !== 'string')
    return respond(request, null, 'Invalid operation', 400);
  const owner = demoUser(request);
  if (
    owner &&
    !['disconnect', 'logout'].includes(intent) &&
    demoStatus(owner).exhausted
  )
    return respond(request, intent, demoMessage(), 429);
  if (owner && !isFullAccess(owner) && ['connect', 'pair'].includes(intent))
    consumeDemoIp(demoDb(), request, 'whatsapp');
  const channel = whatsappChannel(owner);
  try {
    if (intent === 'connect') {
      void channel.connect();
    } else if (intent === 'pair') {
      const phone = String(form.get('phone') ?? '').replace(/[^\d]/g, '');
      if (phone.length < 8 || phone.length > 15)
        return respond(
          request,
          intent,
          'Enter the number with country code, digits only (e.g., 5215512345678)',
          400,
        );
      void channel.connect(phone);
    } else if (intent === 'disconnect') {
      await channel.disconnect(false);
    } else if (intent === 'logout') {
      await channel.disconnect(true);
    } else if (intent === 'group') {
      const jid = form.get('jid');
      const enabled = String(form.get('enabled'));
      if (
        typeof jid !== 'string' ||
        !jid ||
        jid.length > 128 ||
        !['true', 'false'].includes(enabled)
      )
        return respond(request, intent, 'Invalid group', 400);
      if (!channel.setGroup(jid, enabled === 'true'))
        return respond(
          request,
          intent,
          'That group is no longer in the list',
          404,
        );
    } else {
      return respond(request, intent, 'Invalid operation', 400);
    }
    // The connect is async: allow a pause so the state reports "connecting".
    await new Promise((resolve) => setTimeout(resolve, 50));
    return respond(request, intent);
  } catch (error) {
    return respond(
      request,
      intent,
      (error as Error).message || 'Could not change channel.',
      500,
    );
  }
}
