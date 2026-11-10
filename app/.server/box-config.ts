/**
 * Which agent boxes the chat talks to. One box, from the ACP_* variables, unless ACP_BOXES names
 * several: `ACP_BOXES=chat,easy` reads ACP_CHAT_WS_URL, ACP_CHAT_TOKEN, ACP_CHAT_BOX_ID,
 * ACP_CHAT_SNAPSHOT_ID and ACP_CHAT_MAX_SESSIONS, and the same with EASY. Every shared box should run
 * the same agent (prompt, skills, model): a conversation stays on the box that holds it.
 *
 * `ACP_<NAME>_INVITE=<label>` reserves a box for one demo invite (scripts/demo-invite.mjs): only
 * that invite's guest opens conversations there, and only there. It can run its own agent.
 */
export interface BoxConfig {
  /** Short and URL-safe: it will tell conversations of different boxes apart. */
  name: string;
  url: string;
  token: string;
  /** For waking and suspending it (`m_…` is instabox, anything else EasyBits). Empty: not managed. */
  boxId: string;
  snapshotId: string;
  /** Open sessions at once, as the box relay's own ACP_MAX_SESSIONS. */
  maxSessions: number;
  /** Label of the one invite this box is reserved for. Empty: shared by everyone else. */
  invite: string;
}

const sessionsFrom = (value: string | undefined) =>
  Math.max(1, Number(value || 4) || 4);

export function readBoxConfigs(
  env: Record<string, string | undefined> = process.env,
): BoxConfig[] {
  const names = (env.ACP_BOXES ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0)
    return [
      {
        name: 'main',
        url: env.ACP_WS_URL ?? '',
        token: env.ACP_TOKEN ?? env.ACP_SECRET ?? '',
        boxId: env.AGENT_BOX_ID ?? '',
        snapshotId: env.AGENT_SNAPSHOT_ID ?? '',
        maxSessions: sessionsFrom(env.ACP_MAX_SESSIONS),
        invite: '',
      },
    ];
  for (const name of names)
    if (!/^[a-z0-9]+$/.test(name))
      throw new Error(
        `ACP_BOXES: "${name}" is not a valid box name (letters and digits only).`,
      );
  if (new Set(names).size !== names.length)
    throw new Error('ACP_BOXES: a box name is repeated.');
  // No fallback to the single-box variables: half a config would point a box at another's agent.
  const configs = names.map((name) => {
    const key = (field: string) => env[`ACP_${name.toUpperCase()}_${field}`];
    return {
      name,
      url: key('WS_URL') ?? '',
      token: key('TOKEN') ?? '',
      boxId: key('BOX_ID') ?? '',
      snapshotId: key('SNAPSHOT_ID') ?? '',
      maxSessions: sessionsFrom(key('MAX_SESSIONS')),
      invite: (key('INVITE') ?? '').trim(),
    };
  });
  // The first box holds the links from before app ids, and everyone else needs somewhere to go.
  if (configs[0].invite)
    throw new Error(`ACP_BOXES: the first box ("${configs[0].name}") cannot be reserved for an invite.`);
  const invites = configs.map((c) => c.invite).filter(Boolean);
  if (new Set(invites).size !== invites.length)
    throw new Error('ACP_BOXES: two boxes are reserved for the same invite.');
  return configs;
}

/**
 * Where a new conversation may open: the box reserved for this guest's invite, if any;
 * otherwise only the shared boxes. A reserved box never takes anyone else, even when the shared
 * ones are full, and its guest never spills onto a shared one.
 */
export function boxesFor<T extends { invite: string }>(
  boxes: T[],
  inviteLabel?: string | null,
): T[] {
  const reserved = inviteLabel
    ? boxes.filter((b) => b.invite === inviteLabel)
    : [];
  return reserved.length ? reserved : boxes.filter((b) => !b.invite);
}
