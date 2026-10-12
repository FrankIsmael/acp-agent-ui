# Agent box: what we install and how to redo it

The agent runs on an EasyBits `ghosty-lite` box (`AGENT_BOX_ID`, reached at `ACP_WS_URL`).
Everything we add to it lives on the box's disk, so **a recreated box starts without it**.
Rebooting is fine; recreating the box or rebaking the template is not.

## What lives where

| Piece | Where | Survives a new box? | Installed by |
|---|---|---|---|
| **System prompt** (persona, tools, output format by channel, widget rules, reply language) | the EasyBits agent (`systemPrompt`, mode `replace`) → `/data/agent/PROMPT.md` | Set again on create | `scripts/agent-prompt.mjs` ← `scripts/system-prompt.md` |
| Agent icon (Robbie) | `/data/work/robbie.png` ← `public/favicon.png` | **No** | `scripts/agent-prompt.mjs` (`/files` API) |
| Hooks without their own paragraph | `/usr/local/bin/ghosty-prompt-hooks` | **No** | `scripts/agent-prompt.mjs` (exec) |
| Skill descriptions in English | `description:` in each `/opt/goose/skills/<name>/SKILL.md` | **No** | `scripts/translate-skills.mjs` ← `scripts/skill-translations.json` |
| Image MCP (`generate_image`) | `image.service` → `/data/workspace/image.ts`, port 4123 | **No** | `scripts/install-image-mcp.mjs` |
| Project skills (`trip-planner`, …) | `/data/repo` (clone of `SKILLS_REPO_URL`), linked into `/data/work/.agents/skills`; re-run by the box's boot script (`eb_boot`) | **No** | `scripts/bootstrap-memory.mjs --apply` |
| `image` / `google-maps` extension rows | the app's `.data/extensions.db` | Yes (app side) | `install-image-mcp.mjs`, `install-maps-mcp.mjs` |
| `GS_RENDER_URL` (PDF / PNG / slides through our render-svc) | `/etc/ghosty-lite-runtime/.env` | **No** | by hand, see [render-svc.md](render-svc.md) |
| Storage keys for delivered files (`TIGRIS_*`, `STORAGE_*` → our Oracle bucket) | `/etc/ghosty-lite-runtime/.env` | **No** | by hand, see [agent-storage.md](agent-storage.md) |

**`scripts/system-prompt.md` is the only system prompt.** Everything the agent is told lives
there: who it is, its tools, how to format by channel (web artifacts, `[channel:
whatsapp-group]`, `[channel: portfolio-widget]`), and the reply-language rule. It goes through
the EasyBits agents API in `replace` mode, so the template's Ghosty house prompt
(`/opt/goose/goosehints.md`) is left out entirely. On the box, `ghosty-prompt-hooks` writes it to
`/data/agent/PROMPT.md` and builds the three copies the brain reads (`/data/work/CLAUDE.md`,
`/data/work/.goosehints`, `/data/ghosty/config/.goosehints`) from it. The hooks would also append
their own `hilos` / disk paragraph in Spanish; that text is in the doc instead, so
`agent-prompt.mjs` empties the hooks' heredoc and the copies end up exactly the doc. Never edit
the copies by hand. `tests/artifacts.test.mjs` checks that the doc keeps
the exact rules and markers the server sends.

The facts about Ismael are not in the prompt. On the first turn of a widget conversation the app
reads his public profile from the portfolio's MCP (`get_website_info` at `PORTFOLIO_MCP_URL`,
default `https://ismaelfrancisco.tech/mcp`, cached 10 min) and sends it between
`[portfolio-profile]` tags (`app/.server/portfolio-profile.ts`). If the MCP fails, the next turn
tries again. Edit the portfolio, not this repo, to change what the widget knows.

The prompt API needs the **agent id**, not the sandbox id in `AGENT_BOX_ID` (`/agents/sb_…/prompt`
answers 500). `agent-prompt.mjs` looks it up by sandbox; set `AGENT_ID` to skip that.

The `/opt` skills are the template's. Our own skills live in this repo under
`.agents/skills/` and reach the box differently: `bootstrap-memory.mjs` clones the repo
(`SKILLS_REPO_URL`, branch `SKILLS_REPO_BRANCH`) to `/data/repo`, links its `.agents/skills`
into `/data/work/.agents/skills`, and saves itself as the box's boot script so every wake
pulls the latest commit. Only pushed commits count: a skill that exists only locally never
reaches the box. The boot script is box metadata, so a new box has neither the clone nor the
boot step, and its project skills silently disappear from the app.

## Changing the prompt

Edit `scripts/system-prompt.md`, then:

```sh
node --env-file=.env scripts/agent-prompt.mjs --check   # compare with what is live
node --env-file=.env scripts/agent-prompt.mjs           # PATCH it (and the icon)
```

It takes effect without a reboot, on the next session: open threads keep the prompt they started
with.

## Creating a new agent

1. **Create it with the prompt** (POST, `SYSTEM_PROMPT` + `SYSTEM_PROMPT_MODE=replace`):

   ```sh
   node --env-file=.env scripts/agent-prompt.mjs --create mi-agente
   ```

   Then point the app at it: update `AGENT_BOX_ID` (the printed `sandboxId`) and `ACP_WS_URL`
   (and `ACP_SECRET` if it changed) in `.env`, and in the deployed app's `.env` on the VM (see
   [oracle-deployment.md](oracle-deployment.md)). Rerun `agent-prompt.mjs` without `--create` if
   the hooks patch or the icon failed while the box was starting.

2. **Skill descriptions in English** (the template's skills; the API cannot reach `/opt`):

   ```sh
   node --env-file=.env scripts/translate-skills.mjs
   ```

3. **Image MCP** (systemd unit on the box, plus its row in the local app database):

   ```sh
   node --env-file=.env scripts/install-image-mcp.mjs
   ```

   The deployed app keeps its own `.data/extensions.db`. The `image` row there points at
   `127.0.0.1:4123` on the box, so it does not change when the box does. Register it once on
   the VM if it was never added (see the extension scripts in oracle-deployment.md).

4. **Project skills** (`trip-planner` and anything else in `.agents/skills/`): clone the repo
   on the box, link the skills and save the boot step:

   ```sh
   node --env-file=.env scripts/bootstrap-memory.mjs --apply
   ```

   Without `--apply` it only prints the script. It stops, without touching anything, if
   `/data/repo` has uncommitted changes or points at another origin.

5. **Maps:** nothing to do. Google hosts that MCP; the extension row lives on the app side.
   The `trip-planner` skill that tells the agent how to use it comes from step 4.

6. **Rendering** (PDF, PNG, slides): add `GS_RENDER_URL` and restart the agent, as in
   [render-svc.md](render-svc.md#the-agent-box-side). Without it every `/opt/gs-sdk/render.mjs`
   call answers 503.

7. **File delivery** (the links to those PDFs and decks): add the five storage lines from
   [agent-storage.md](agent-storage.md#the-agent-box-side) and restart the agent. Without them
   rendering works but every `publish*()` call fails in `storage.mjs`. Restart once for both
   steps if you do them together.

8. **Open a new thread.** Open threads keep the hints and MCP connections they started with.

All of these scripts are idempotent. `bootstrap-memory.mjs` refreshes the clone and replaces
only its own section of the boot script. The others, run again on a box that already has
everything, only print `up to date`. Each skill prints `translated`, `up to date`, or
`description changed upstream, skipped` (see below).

## Checking a box

```sh
node --env-file=.env --input-type=module -e "
import { easybitsClient } from './scripts/lib/easybits.mjs';
console.log(await easybitsClient().exec(process.env.AGENT_BOX_ID, [
  'systemctl is-active image.service',
  'cat /data/agent/PROMPT.mode',
  'head -1 /data/work/CLAUDE.md',
  'grep -c portfolio-widget /data/work/CLAUDE.md',
  'ls /data/work/.agents/skills',
].join('; ') + '; true'));"
```

Expect `active`, `replace`, `# Robbie`, `1` and the list of `.agents/skills/` in this
repo (including `trip-planner`). `No such file or directory` on the last line means step 4
never ran on this box.

## When the template changes

**Skills.** A skill whose Spanish description changed upstream is skipped (not an error); the
rest still get translated. To update it: translate the new description into
`scripts/skill-translations.json` and set its `es` to the md5 of the new `description:` block
(the `description:` line plus its indented continuation lines, joined with `\n`). Keep Spanish
trigger phrases as quoted examples, and keep tool names, binaries and block tags verbatim.

**Prompt hooks.** `agent-prompt.mjs` stops with "the template changed" if
`ghosty-prompt-hooks` no longer has the `HINT` heredoc it empties. Diff the new script against
`/usr/local/bin/ghosty-prompt-hooks.bak` from an old box and adjust `HOOKS_HEREDOC`. If the
template's paragraph changed, carry the change into `scripts/system-prompt.md`.

## Attachments

Images go to the model as `image` blocks. Documents (PDF, Word, Excel, zip…, up to 5 per
message, 50 MB each, 100 MB together) do not: a `resource` block with a `blob` is accepted by the
box and never reaches the model. Instead the browser uploads each file as soon as it is
attached (`POST /api/conversations/:id/uploads`, the raw bytes; the chip spins until it is
done), and the message only names the uploads by id. The turn then carries one
`[attachments]` … `[/attachments]` text block with each file's path in the conversation's
`adjuntos/` folder, which the template's skills already read (`pdf-reader`, `office-reader`).
Each line also carries the marks the template's `big-files` skill triggers on: `GRANDE` (over
5 MB) and `COMPRIMIDO` (an archive). Replaying a thread turns that block back into the file
chips. The portfolio widget (`/embed`) does not take documents.

The app streams each file to the uploads bucket (`UPLOAD_*` in the app's `.env`, see
[agent-storage.md](agent-storage.md#user-uploads)); without those variables documents cannot be
attached. The file is not on the box yet: its line carries the exact
`curl -fsS --create-dirs -o adjuntos/<name> '<link>'` (a one-hour presigned link), which the
agent runs first. The app picks the path, `report-1.pdf` for a second `report.pdf` in the same
conversation. A recreated box loses its copy, not the file: it is in the bucket.

Before the bucket, the app wrote files to the box's front (`POST /adjunto`, the template's,
same host and token as `ACP_WS_URL`), in 10 MB pieces because the front refuses more than 12 MB
per upload, and the agent joined them with a `cat … >> <name> && rm …`. Threads from then still
replay their file chips; nothing in the app calls `/adjunto` any more.

Code: `app/.server/uploads.ts`, `app/lib/attachments.ts`, the upload route
`app/routes/api.conversations.$id.uploads.ts`. Tests: `npm run test:attachments`.

Checked end to end on 2026-10-12 (dev server, against the live box). The box runs are from
before the fallback was removed:

- Bucket: a 7,001,409-byte zip uploaded in 0.9 s; the agent ran the `curl` unprompted ("Descargado"),
  its sha256 on the box matched the original, and it listed the zip. About 24 s for the turn.
- Box: a 25,000,319-byte zip went up in 3 pieces; the agent ran the join command unprompted
  ("Joining the split parts as instructed"), the file on the box matched the original's sha256,
  the pieces were gone, and it listed the zip's contents. About 14 s for the turn. After the
  move to upload-on-attach, a 14,000,337-byte zip (2 pieces, 8.3 s to upload) did the same in 9 s.
- A message naming an unknown upload id answers 400.

## Reply language

The agent should reply in the language of the user's latest message (or the conversation's,
for an image or code alone), on web and WhatsApp alike; the UI locale does not choose it. The
only rule for this is the `## Reply language` section of `scripts/system-prompt.md`. The app
sends no per-turn language marker.

Keep every other language mention out of the hints and skills. Claude Code's own system prompt
has no language instruction, so language mirroring is emergent and any wording about
languages competes with it. Measured on 2026-09-23 with the `claude` CLI inside the box,
"hello" / "who are you" prompts, 4 runs per variant:

| `CLAUDE.md` variant | Spanish replies |
|---|---|
| a `## Language` block naming Spanish (to forbid it) | 3/4 |
| that section deleted | 1/4 |
| one line about reply language, no language named | 4/4 |
| no `CLAUDE.md` at all (separate run, 1 sample per prompt) | 0/3 |

Skill descriptions were not the cause (all English results with every skill loaded). The
residual Spanish comes from the persona itself (Ghosty, a Spanish-market brand). Samples are
small: the trend is a signal, not a measurement.

**Still open:** test the current rule on a live agent with greetings, a language switch
mid-thread, and a UI locale different from the message language.
