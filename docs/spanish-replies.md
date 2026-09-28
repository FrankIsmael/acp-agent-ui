# The agent answers in Spanish to English messages

Status: **per-turn marker removed; existing box instructions verified via EasyBits MCP
on 2026-09-28; live reply validation pending**.
Historical measurements below were taken 2026-09-23 on the agent box `sb_76f0708e-…`.

## Current policy (2026-09-28)

The agent replies in the language of the user's latest message, unless the user explicitly
requests another language. For messages with no clear language (such as an image or code
alone), it follows the conversation's language. This applies to both web chat and WhatsApp.
The UI locale only controls the interface; it does not select the agent's reply language.

The shared rule lives in the `## Reply language` section of `HINTS_BLOCK` in
`app/.server/artifact-instructions.ts`, installed in the agent's `CLAUDE.md` / `.goosehints`.
The app no longer reads the locale cookie when sending a message or prepends a
`[reply-language: …]` marker. Format and language instructions are owned by the box;
there is no inline-instruction fallback. Only the channel marker travels with a messaging
turn, since web chat and WhatsApp can share a conversation.

Read-only inspection via EasyBits MCP confirmed that the configured agent box already has
this fallback in its `## Reply language` section: "With no such line, answer in the language
of the user's message." It appears in `/data/work/CLAUDE.md`, `/data/work/.goosehints`, and
`/data/ghosty/config/.goosehints` at line 153, and in the baked `/opt/goose/goosehints.md` at
line 137. Removing the app's marker activates that existing rule; no box update is required
for the basic behavior. No remote files were changed during this verification.

The installed section still describes the old marker override. Future cleanup can replace
it with the current `HINTS_BLOCK` language rule in all four files, including the baked copy. The
installer skips blocks whose marker already exists, so rerunning it alone does not update
an existing block. Checking the files does not establish how reliably the model follows
the rule; live reply validation remains pending.

## Symptom

The web chat is English, the user writes `hello`, the agent answers `¡Hola! ¿En qué te ayudo hoy?`.

## What is actually in the model's context

Pulled from the Claude Code transcript of a failing session
(`/data/ghosty/home/.claude/projects/-data-work/<session>.jsonl`, `prompt_snapshot` +
`attachment` entries). Spanish is counted in lines containing `[áéíóúñ¿¡]`:

| block | size | Spanish lines |
|---|---|---|
| systemPrompt (14 blocks, Claude Code's own) | 53 KB | 0 |
| mcp_instructions (deepwiki) | 2.1 KB | 0 |
| **skill_listing** | 16.8 KB | **17** → 10 after the rewrite |
| instructions (`/data/work/CLAUDE.md`) | 10.2 KB | 1 → 0 |

Claude Code's own system prompt contains **no language instruction at all** — no "reply in the
user's language", no locale setting. Language mirroring is emergent, which is why any
conversational prose in another language competes with it.

## A/B, same prompts as the failing chats

Run with the `claude` CLI inside the box, `cwd=/data/work`, all files already 100% English:

| variant | "hello" | "what do you do?" | "who are you… emojis" |
|---|---|---|---|
| A as-is | ES, ES | EN, EN | ES, ES |
| B no skills | ES | EN | ES |
| C no CLAUDE.md | EN | EN | EN |
| D neither | EN | EN | EN |

**The skills are not the cause** (C has all 21 skills and is English throughout). `CLAUDE.md`
is. Greetings and identity questions fail; task questions do not.

## Bisecting CLAUDE.md

| variant | "hello" | "who are you… emojis" | Spanish |
|---|---|---|---|
| orig (full `## Language` block) | ES, ES | EN, ES | 3/4 |
| E (section deleted) | EN, ES | EN, EN | 1/4 |
| G (one line, no language named) | ES, ES | ES, ES | 4/4 |

The `## Language` block is **counterproductive**: naming Spanish four times to forbid Spanish
primes it. Deleting it is the best of the three, and still not deterministic — the residue is
the persona (`Ghosty`, `Ghosty Studio`, a Spanish-market brand) with nothing else to go on.

Sample size is 4 runs per cell. The orig-vs-E gap is a signal, not a measurement; G is the
only unambiguous result.

## Done so far

- Hints translated to English, including the baked `/opt/goose/goosehints.md` and the `hilos`
  heredoc in `/usr/local/bin/ghosty-lite-start` (the launcher overwrites the `/data` copies on
  every boot, so an edit that skips the baked copy is lost at the next restart).
- 17 of 21 `SKILL.md` descriptions rewritten as English spec prose, keeping Spanish trigger
  phrases as quoted examples. Backup at `/opt/goose/skills.bak-es`.
- The `"tú"/"usted"` line removed from all four hint files.

Skill **bodies** are still Spanish (~200 KB). They only enter context when a skill fires.

## Superseded approach

The previous proposal removed the old `## Language` section and added a per-turn
`[reply-language: en]` marker from the UI locale. That marker was implemented, but it tied
replies to the interface setting instead of the language the user typed and repeated
metadata in every turn. It has now been removed. The small historical samples above do
not establish deterministic behavior for either policy; validate the current rule on a
live agent with greetings, language switches, and a UI locale different from the message.
