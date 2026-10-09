# Agent box: what we install and how to redo it

The agent runs on an EasyBits `ghosty-lite` box (`AGENT_BOX_ID`, reached at `ACP_WS_URL`).
Everything we add to it lives on the box's disk, so **a recreated box starts without it**.
Rebooting is fine; recreating the box or rebaking the template is not.

## What lives where

| Piece | Where | Survives a new box? | Installed by |
|---|---|---|---|
| House hints in English + `HINTS_BLOCK` | `/opt/goose/goosehints.md`, `/usr/local/bin/ghosty-prompt-hooks` | **No** | `scripts/install-hints.mjs` |
| Skill descriptions in English | `description:` in each `/opt/goose/skills/<name>/SKILL.md` | **No** | `scripts/install-hints.mjs` |
| Image MCP (`generate_image`) | `image.service` → `/data/workspace/image.ts`, port 4123 | **No** | `scripts/install-image-mcp.mjs` |
| Project skills (`trip-planner`, …) | `/data/repo` (clone of `SKILLS_REPO_URL`), linked into `/data/work/.agents/skills`; re-run by the box's boot script (`eb_boot`) | **No** | `scripts/bootstrap-memory.mjs --apply` |
| `image` / `google-maps` extension rows | the app's `.data/extensions.db` | Yes (app side) | `install-image-mcp.mjs`, `install-maps-mcp.mjs` |

The agent reads three generated copies (`/data/work/CLAUDE.md`, `/data/work/.goosehints`,
`/data/ghosty/config/.goosehints`). `ghosty-prompt-hooks` rebuilds them from the two `/opt` and
`/usr/local/bin` sources on every boot, so never edit the copies by hand. The English house
prompt is kept in `scripts/house-hints.md` and the skill descriptions in
`scripts/skill-descriptions.json`; `install-hints.mjs` puts both on the box. Skills are
symlinked from `/opt/goose/skills` into `~/.claude/skills`, so only the `/opt` copy is edited.

Those `/opt` skills are the template's. Our own skills live in this repo under
`.agents/skills/` and reach the box differently: `bootstrap-memory.mjs` clones the repo
(`SKILLS_REPO_URL`, branch `SKILLS_REPO_BRANCH`) to `/data/repo`, links its `.agents/skills`
into `/data/work/.agents/skills`, and saves itself as the box's boot script so every wake
pulls the latest commit. Only pushed commits count: a skill that exists only locally never
reaches the box. The boot script is box metadata, so a new box has neither the clone nor the
boot step, and its project skills silently disappear from the app.

## After the box is recreated

1. **Point the app at the new box.** A new box has a new id and a new URL. Update
   `AGENT_BOX_ID` and `ACP_WS_URL` (and `ACP_SECRET` if it changed) in `.env`, and in the
   deployed app's `.env` on the VM (see [oracle-deployment.md](oracle-deployment.md)).

2. **Hints and skills** (English house prompt, output-format / reply-language rules, English
   skill descriptions):

   ```sh
   node --experimental-strip-types --env-file=.env scripts/install-hints.mjs
   ```

   Run this first: `install-image-mcp` appends its own section to the same baked file.

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

6. **Open a new thread.** Open threads keep the hints and MCP connections they started with.

All three scripts are idempotent. `bootstrap-memory.mjs` refreshes the clone and replaces
only its own section of the boot script. The other two, run again on a box that already has
everything, only print `up to date` / `hints already there`. Each skill prints `translated`, `up to date`, or
`description changed upstream, skipped` (see below).

## Checking a box

```sh
node --env-file=.env --input-type=module -e "
import { easybitsClient } from './scripts/lib/easybits.mjs';
console.log(await easybitsClient().exec(process.env.AGENT_BOX_ID, [
  'systemctl is-active image.service',
  'grep -c output-format /data/work/CLAUDE.md',
  'grep -c generate_image /data/work/CLAUDE.md',
  'head -1 /data/work/CLAUDE.md',
  'ls /data/work/.agents/skills',
].join('; ') + '; true'));"
```

Expect `active`, `1`, `1`, `# House tools (Ghosty)` and the list of `.agents/skills/` in this
repo (including `trip-planner`). `No such file or directory` on the last line means step 4
never ran on this box.

## When the template changes

**Skills.** A skill whose Spanish description changed upstream is skipped (not an error); the
rest still get translated. To update it: translate the new description into
`scripts/skill-descriptions.json` and set its `es` to the md5 of the new `description:` block
(the `description:` line plus its indented continuation lines, joined with `\n`). Keep Spanish
trigger phrases as quoted examples, and keep tool names, binaries and block tags verbatim.

**House prompt.**

`install-hints.mjs` only replaces the baked prompt if it is the exact Spanish original it knows
(md5 in the script) or already English. If EasyBits ships a new template it stops with
"the template changed" and writes nothing. To update: diff the new `/opt/goose/goosehints.md`
against `/opt/goose/goosehints.md.bak` from an old box, apply the changes to
`scripts/house-hints.md` in English, and update `ES_BAKED` (md5 and byte size of the new
Spanish file). Keep commands, tool names, paths and `[TU MODELO: …]` verbatim, and do not add
a reply-language line (see [Reply language](#reply-language)).

## Reply language

The agent should reply in the language of the user's latest message (or the conversation's,
for an image or code alone), on web and WhatsApp alike; the UI locale does not choose it. The
only rule for this is the `## Reply language` section of `HINTS_BLOCK`
(`app/.server/artifact-instructions.ts`). The app sends no per-turn language marker.

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
