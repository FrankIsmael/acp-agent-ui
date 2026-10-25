# CLAUDE.md

## Context hygiene (project specifics — general rules live in ~/.claude/CLAUDE.md)

- Large files — grep and slice, don't read in full:
  `app/.server/acp.ts`, `app/.server/whatsapp.ts`, `app/app.css`, `app/routes/chat.tsx`,
  `app/lathe/ui/LatheApp.tsx`, `app/lathe/sim/gcode/generate.ts`, `app/theme/theme-tokens.ts`,
  `app/locales/en.json`, `app/locales/es.json` (look up keys with `grep -n '"key"'`).
- Never read: `legacy/**/package-lock.json`, `docs/lathe/models/*.glb`, `public/models/*.glb`.
- Tests: run single files with `node --experimental-strip-types --test tests/<file> 2>&1 | grep -E "^not ok|# (pass|fail)"`.
