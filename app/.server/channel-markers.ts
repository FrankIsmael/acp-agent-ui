/**
 * Markers that the server puts at the beginning of a turn to tell the agent which channel
 * it is entering from. The rules for each channel live in the system prompt (`scripts/system-prompt.md`):
 * this file only contains the line stating which ones apply. The channel cannot be known from the prompt
 * because web, WhatsApp, and the widget share the same box. The test checks that the prompt
 * mentions each marker exactly as is.
 */

/** Turn for a messaging channel (WhatsApp): web and WhatsApp share the same thread. */
export const CHANNEL_MARKER = '[channel: whatsapp-group]';

/**
 * Turn for the embedded widget in the portfolio (`/embed`). The server adds this to each turn of
 * a conversation opened from the widget (see `embed-conversations.ts`), so the
 * visitor cannot remove it from the browser.
 */
export const EMBED_MARKER = '[channel: portfolio-widget]';

/**
 * Wraps Ismael's profile (`portfolio-profile.ts`), sent after `EMBED_MARKER` on the first widget
 * turn. The replay removes everything between the two tags.
 */
export const PROFILE_OPEN = '[portfolio-profile]';
export const PROFILE_CLOSE = '[/portfolio-profile]';

/**
 * Threads from before the system prompt had the full rules as the first block of the turn.
 * When replaying them, they are removed, from the phrase they started with to the phrase they ended with.
 */
export const LEGACY_INSTRUCTIONS: [start: string, end: string][] = [
  [
    'The chat UI supports an Artifacts side panel.',
    'without forcing an artifact.',
  ],
  [
    'You are replying inside a WhatsApp group;',
    'consecutive messages from the group members.',
  ],
];
