/**
 * Slack channel integration via Socket Mode (no public endpoint needed).
 * Replies to @mentions or DMs in invited channels, always threading responses.
 * Access is controlled by `SLACK_ALLOWED_USERS` (user IDs) and `SLACK_ALLOWED_CHANNELS` (channel IDs); others are ignored.
 * Disabled if missing tokens or allowlists. In the public demo (`DEMO=true`) it speaks as its own
 * full-access guest (`demoChannelOwner('slack')`): its own agent thread, without guest limits.
 */
import { App, LogLevel } from '@slack/bolt';
import { askFromChannel, type PromptImage } from './acp';
import { demoChannelOwner, demoEnabled } from './demo';
import { splitFiles } from '../lib/files';

/** Slack refuses a message over ~40k characters; long answers are split. */
const TEXT_MAX = 3900;

interface SlackFile {
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

interface SlackMessage {
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
  files?: SlackFile[];
  team?: string;
  user_team?: string;
}

/** Comma-separated Slack ids from the environment. */
function ids(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * The agent's text as Slack's mrkdwn understands it. Same translation as `paraWhatsApp`, plus
 * links: Slack writes `<url|text>` instead of `[text](url)`.
 */
export function paraSlack(text: string) {
  const withLinks = splitFiles(text)
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : `\n📎 <${part.file.url}|${part.file.name}>\n`,
    )
    .join('');
  return withLinks
    .replace(
      /<artifact\b[^>]*?\btitle\s*=\s*"([^"]*)"[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi,
      (_, title) => `📎 _${title || 'File'}_ (see it in the web chat)`,
    )
    .replace(
      /<artifact\b[^>]*>[\s\S]*?(?:<\/artifact\s*>|$)/gi,
      '📎 _File_ (see it in the web chat)',
    )
    .replace(/!?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits on paragraph boundaries so no message goes over `TEXT_MAX`. */
function chunks(text: string) {
  const out: string[] = [];
  let rest = text;
  while (rest.length > TEXT_MAX) {
    let cut = rest.lastIndexOf('\n\n', TEXT_MAX);
    if (cut < TEXT_MAX / 2) cut = rest.lastIndexOf('\n', TEXT_MAX);
    if (cut < TEXT_MAX / 2) cut = TEXT_MAX;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class SlackChannel {
  private app: App;
  private names = new Map<string, string>();
  private users = ids(process.env.SLACK_ALLOWED_USERS);
  private channels = ids(process.env.SLACK_ALLOWED_CHANNELS);
  /** The workspace the bot belongs to, from `auth.test` when starting. */
  private team: string | undefined;
  /** Demo only: the guest whose thread Slack turns go to. */
  private owner = demoEnabled() ? demoChannelOwner('slack') : undefined;

  constructor(token: string, appToken: string) {
    this.app = new App({
      token,
      appToken,
      socketMode: true,
      // Otherwise the constructor checks the token in a promise nobody awaits, and a bad token
      // takes the whole server down. `start()` runs that check where it can be caught.
      deferInitialization: true,
      logLevel: (process.env.SLACK_LOG?.toLowerCase() as LogLevel) || LogLevel.WARN,
    });
    // In a channel, only @mentions. Mentions also arrive as `message.channels` when that event
    // is subscribed; ignoring them there avoids answering twice.
    this.app.event('app_mention', ({ event }) =>
      this.turn(event as unknown as SlackMessage),
    );
    this.app.message(async ({ message }) => {
      const m = message as unknown as SlackMessage;
      if (m.channel_type !== 'im') return;
      if (m.subtype && m.subtype !== 'file_share') return;
      await this.turn(m);
    });
    this.app.error(async (error) => {
      console.warn('[slack]', error.message);
    });
  }

  async start() {
    await this.app.init();
    const auth = await this.app.client.auth.test();
    this.team = auth.team_id;
    await this.app.start();
    console.log('[slack] connected (socket mode)');
  }

  private async name(user: string | undefined) {
    if (!user) return 'someone';
    const known = this.names.get(user);
    if (known) return known;
    try {
      const info = await this.app.client.users.info({ user });
      const name =
        info.user?.profile?.display_name ||
        info.user?.real_name ||
        info.user?.name ||
        user;
      this.names.set(user, name);
      return name;
    } catch {
      return user;
    }
  }

  /** Photos attached to the message. `url_private` needs the bot token (scope `files:read`). */
  private async images(files: SlackFile[] = []) {
    const images: PromptImage[] = [];
    for (const file of files) {
      const url = file.url_private_download ?? file.url_private;
      if (!url || !file.mimetype?.startsWith('image/')) continue;
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        images.push({
          mimeType: file.mimetype,
          data: Buffer.from(await response.arrayBuffer()).toString('base64'),
        });
      } catch (error) {
        console.warn(
          '[slack] could not download image:',
          (error as Error).message,
        );
      }
    }
    return images;
  }

  private async react(m: SlackMessage, name: string) {
    try {
      await this.app.client.reactions.add({
        channel: m.channel,
        timestamp: m.ts,
        name,
      });
    } catch {}
  }

  private allowed(m: SlackMessage) {
    if (!m.user) return false;
    // Fails closed until `auth.test` said which workspace is ours.
    const team = m.user_team ?? m.team;
    if (!this.team || team !== this.team) return false;
    if (this.users.has(m.user)) return true;
    return m.channel_type !== 'im' && this.channels.has(m.channel);
  }

  private async turn(m: SlackMessage) {
    if (m.bot_id) return;
    if (!this.allowed(m)) {
      console.warn(
        `[slack] ignored message from ${m.user ?? '?'} in ${m.channel}: not in SLACK_ALLOWED_USERS / SLACK_ALLOWED_CHANNELS.`,
      );
      return;
    }
    // The mention itself is not part of what the person said.
    const text = (m.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
    const images = await this.images(m.files);
    if (!text && !images.length) return;
    const thread_ts = m.thread_ts ?? m.ts;
    void this.react(m, 'eyes');
    const from = await this.name(m.user);
    try {
      const answer = await askFromChannel(
        `${from}: ${text}`.trim(),
        'slack',
        from,
        images,
        this.owner,
      );
      await this.deliver(m.channel, thread_ts, answer);
      void this.react(m, 'white_check_mark');
    } catch (error) {
      console.warn('[slack] turn failed:', (error as Error).message);
      await this.app.client.chat
        .postMessage({
          channel: m.channel,
          thread_ts,
          text: `⚠️ ${error instanceof Response ? await error.text() : (error as Error).message || 'Could not answer.'}`,
        })
        .catch(() => {});
      void this.react(m, 'x');
    }
  }

  private async deliver(
    channel: string,
    thread_ts: string,
    answer: { text: string; images: PromptImage[] },
  ) {
    const text = paraSlack(answer.text);
    // Images from tools go as uploads in the same thread, the text as their comment.
    if (answer.images.length) {
      await this.app.client.filesUploadV2({
        channel_id: channel,
        thread_ts,
        ...(text && text.length <= TEXT_MAX ? { initial_comment: text } : {}),
        file_uploads: answer.images.map((image, index) => ({
          file: Buffer.from(image.data, 'base64'),
          filename: `image-${index + 1}.${image.mimeType.split('/')[1] || 'png'}`,
        })),
      });
      if (!text || text.length <= TEXT_MAX) return;
    }
    for (const part of chunks(text || '(no response)'))
      await this.app.client.chat.postMessage({
        channel,
        thread_ts,
        text: part,
        unfurl_links: false,
      });
  }
}

// One socket per process, in `globalThis` for the same reason as WhatsApp: Vite reevaluates the
// module on every edit in development, and two sockets would both answer every message.
const GLOBAL_KEY = Symbol.for('acp-agent-ui.slack');
export function startSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) return;
  const globals = globalThis as { [GLOBAL_KEY]?: SlackChannel };
  if (globals[GLOBAL_KEY]) return;
  if (
    !ids(process.env.SLACK_ALLOWED_USERS).size &&
    !ids(process.env.SLACK_ALLOWED_CHANNELS).size
  ) {
    console.warn(
      '[slack] off: set SLACK_ALLOWED_USERS and/or SLACK_ALLOWED_CHANNELS to say who may use the agent.',
    );
    return;
  }
  const channel = new SlackChannel(token, appToken);
  globals[GLOBAL_KEY] = channel;
  channel.start().catch((error) => {
    console.warn('[slack] could not connect:', (error as Error).message);
    globals[GLOBAL_KEY] = undefined;
  });
}
