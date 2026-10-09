# Plan: translation keys instead of English text

> Status: proposed, not started (October 8, 2026). Current behaviour is described in
> [`i18n.md`](i18n.md); this file is what to change and in what order.

## Why

Today `app/locales/*.json` mixes two conventions:

- **302 of 323 entries use the English sentence as the key**, so in `en.json` the key and the
  value are the same text.
- **18 use namespaced keys** (`settings.language`, `messages.count.one`,
  `errors.connectionLost`…), mainly for plurals and server errors.

English-text keys cost us in three ways:

1. **Editing English silently breaks Spanish.** Change the wording in the component and the old
   key in `es.json` no longer matches, so `t()` falls back to English with no warning. This
   happened with the Teotihuacán starter question in `hub.tsx`: its text changed in the catalogs
   but not in `STARTERS`.
2. **Typos are not caught.** `t("Duraton")` renders "Duraton"; nothing fails.
3. **Long keys.** Starter questions are 50–130 character keys.

Separately, `app/lib/i18n.ts` is harder to follow than it needs to be because the server still
throws Spanish error text (`AgentError("No hay un hilo abierto con el agente.")`). The translator
reverse-maps Spanish values back to keys (`legacyMessageKeys`) and regex-matches templated errors
to recover `{code}`/`{attempts}` (`legacyErrorPatterns`).

## Goal

- One convention: **dotted keys grouped by area**, e.g. `chat.weather.feelsLike`,
  `hub.starters.weather`, `routes.duration`.
- **`t()` only accepts keys that exist in `en.json`**, so `tsc` rejects typos and missing keys.
- **The server sends error codes, not text**, and the client translates them. The reverse
  lookup and regex matching in `i18n.ts` are deleted.

## Steps

### 1. Typed keys (no catalog changes yet)

- In `app/lib/i18n.ts`, export `type MessageKey = keyof typeof en` and type the translator as
  `(key: MessageKey, values?, fallback?) => string`.
- Plural keys: allow the base key when `en.json` has `${key}.one`/`${key}.other`, e.g. with a
  template literal type that strips `.one|.other`.
- Calls that pass a runtime string (`t(error)`, `t(starter)`) need a cast or a separate
  `tDynamic`; list them, as they are the places that need a different design in steps 3–4.
- Done when `npx tsc --noEmit` passes. This alone catches typos.

### 2. Rename keys with a script

All ~266 `t("…")` calls in 26 files use literal strings, so this can be done mechanically:

- Script in `scripts/` that, for each English-text key, builds a dotted key from the file
  (`app/routes/hub.tsx` → `hub.`, `app/components/WeatherCard.tsx` → `weather.`) plus a short
  camelCase slug of the text, and writes a `old → new` map for review before applying.
- Rewrite the `t("…")` calls, `defineMessages` ids and both catalogs from that map.
- Strings used in more than one file go under `common.` (`common.cancel`, `common.save`).
- Keep `es.json` values unchanged; `en.json` values stay the current English text.
- Review the generated names by hand before applying: they become permanent.

### 3. Starters and other lists

Lists such as `STARTERS` in `hub.tsx` store keys, not text:

```ts
const STARTERS = ['hub.starters.weather', 'hub.starters.coffee', /* … */] as const;
```

The key no longer changes when the English wording does, so the drift described above can't
happen.

### 4. Server errors as codes

Six `AgentError("…")` messages in `app/.server/acp.ts`, plus the templated connection errors,
send Spanish text to the client today.

- Give `AgentError` a `code: MessageKey` and optional `values`; API routes return
  `{ error: code, values }`.
- `useAcpStream` / route components call `t(code, values)`.
- Delete `legacyMessageKeys`, `legacyErrorPatterns` and the `"sin código"` special case from
  `createTranslator`.
- This touches the server and the SSE/API contract, so it is the riskiest step: do it in its
  own commit, and check a reconnect/error flow by hand.

### 5. Clean up

- Update [`i18n.md`](i18n.md): key naming convention, how to add a string, typed `t()`.
- Extend `tests/i18n.test.mjs`: every key in `en.json` exists in `es.json` and vice versa, and
  the placeholders (`{name}`) match between the two.

## Verification

- `npx tsc --noEmit`
- `npm run test:i18n`
- `npm run build && npm run test:chat:browser` (needs `CHAT_TEST_BROWSER`)
- By hand: switch English ↔ Spanish in Settings, open the hub (starter chips), a chat with
  weather/route cards, and trigger a connection error.

## Out of scope

- Adding more languages.
- Translating agent replies or user content (they stay as supplied).
