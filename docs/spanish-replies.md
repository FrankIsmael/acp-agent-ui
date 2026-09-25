# The agent answers in Spanish to English messages

Status: **open**. Measured 2026-09-23 on the agent box `sb_76f0708e-…`.

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

## Next

1. Delete the `## Language` section — it measurably makes things worse.
2. Add a per-turn language marker in the app, next to the `CHANNEL_MARKER` that `prefixFor`
   already prepends (`app/.server/acp.ts`): `[reply-language: en]` from the UI locale. Recency
   beats a static block at the top of a 10 KB file, and it is deterministic.
