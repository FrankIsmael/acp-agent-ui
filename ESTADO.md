# Where we are

> Updated September 19, 2026. This file is the operational snapshot: what is running, where, and what
> you need to know to resume without rereading everything. Conceptual notes are in [`docs/`](docs/).

## What works today

A full turn from the browser: reaches the agent, the agent writes to the disk of its box,
responds in markdown and reports tokens and cost. Verified August 31 with
`/root/web3-ok.txt` → `WEB3_OK`.

| Piece | Where | Status |
|---|---|---|
| Interface | repo root | ✅ SSR, 9 routes |
| ACP engine | `app/.server/acp.ts` | ✅ one connection per conversation |
| SSE | `app/routes/api.conversations.$id.events.ts` | ✅ with heartbeat every 25 s |
| Agent | `mi-agente-claude` (`sb_76f0708e-…`), ghosty-lite 1.48.0, `claude-acp`/sonnet, `GOOSE_MODE=approve` | ✅ `ghosty-lite-runtime` |
| Extensions | `/extensions`, SQLite at `.data/extensions.db` | ✅ http and stdio, in `session/new` and hot-reloaded |
| Permissions | `PermissionCard`, `/api/conversations/:id/permissions` | ✅ turn waits for decision |
| WhatsApp | `/whatsapp`, `app/.server/whatsapp.ts` (Baileys), `whatsapp_*` tables in same SQLite | ✅ QR or code, groups with switch, bursts, photos and reactions |
| Google Maps | `google-maps` extension (Grounding Lite), `app/lib/maps.ts`, `MapCard` in chat | ✅ places, weather, routes; map with markers and route line |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | public |

## To start

```sh
npm install
npm run dev        # needs .env
```

The `.env` (outside the repo) should have `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD`, `AGENT_BOX_ID`, and
`EASYBITS_API_KEY`. For WhatsApp in prod, also `WHATSAPP_ADMIN_KEY` (a long random string): without this `/whatsapp` will not open in production; enter once with `/whatsapp?key=<key>`
and the browser is authorized for 30 days by cookie. **Without the key the app works but doesn't manage the box** (the log says
"no SDK"); `@easybits.cloud/sdk` is already a dependency.

If the box dies, [`scripts/new-ghosty-agent.mjs`](scripts/new-ghosty-agent.mjs) creates another
`ghosty-lite` agent with Claude (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`)
and rewrites the `.env`; saves `ACP_SECRET` and `AGENT_BOX_ID` right after creation, because `createAgent`
returns a URL like `sandbox://…` and the real `wss://` only shows up later in `getAgent`. It has happened
twice that the box disappears from host with 404 "sandbox not found" while showing as `running`
(2 Sep and 12 Sep); without `AGENT_SNAPSHOT_ID` there is no automatic recovery. For goose on DeepSeek use
[`scripts/new-goose-box.mjs`](scripts/new-goose-box.mjs).


```sh
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oa... node --env-file=.env scripts/new-ghosty-agent.mjs mi-agente-claude
```

## What you need to know

- **WhatsApp enters the same thread as the web chat** ([`docs/spec5-operacion.md`](docs/spec5-operacion.md)).
  `askFromChannel` in `acp.ts` puts the turn in the open thread (or opens one) and waits for the
  full response; the browser sees it as a bubble labeled "via WhatsApp" (event `user`)
  and tool images `mcp:` as `image` event. Baileys credentials live
  in `whatsapp_auth` inside `ACP_EXTENSIONS_DB`: when hosting, that path must be on persistent disk
  or you'll have to rescan after every deploy. When opening the thread, it forces
  `session/set_mode auto` (`ACP_MODE`; empty means don’t touch), because ghosty doesn't deliver
  the permission response with claude-acp and the tool gets stuck.

- **You can see tools and thought.** `tool_call` / `tool_call_update` arrive to
  the browser as event `tool` (upsert by id) and `agent_thought_chunk` as `thought`; the chat renders
  the thought collapsed and a row per tool with its state. Done Sep 2 for session 2.
- **`terminal: false` in `initialize`.** With `true` goose asks the client for `terminal/create` and,
  since we don’t implement it, every `shell` ends in `failed`. The shell runs inside the box.
- **`POST /extend` gives 500 on a box with expired TTL** (alive by nap): the host adds over the
  old `expiresAt` and rejects with 400, and EasyBits turns it into 500. Fixes pending in
  `sandbox-host` and `easybits` branches, yet to deploy.

- **The box suspends itself** when inactive. It is awoken by the `Upgrade` of the WebSocket
  itself (verified Sep 1, 2026); `ensureAgentBox` only extends TTL, suspends on idle and warns if
  box no longer exists. The systemd unit restarts `goose serve` when booting. Before that, every
  suspension would leave the app dead with a 401 that looked like a credentials error.
- **Node 22.16 versus 22.22.** React Router requires ≥ 22.22 and warns on every start; works anyway.
  Worth upgrading to stop seeing the warning.
- **Conversations do persist (verified prod Sep 14).** They live in the agent box (`/data/ghosty/data/sessions/sessions.db`, persistent root) and the list comes from
  `session/list`; restarting the app doesn't erase anything. What *looks* like loss is three things:
  1. all are called `New Chat` — agent isn't generating titles on this box (pending);
  2. when the box sleeps (15 min idle) WebSocket drops, server sends `closed`, and browser **does not reconnect** (`useAcpStream.ts`, handler `closed`): open chat remains dead until reload. Pending: reopen `EventSource` with backoff;
  3. first request after sleep takes ~19 s and `/sessions` shows "Loading..." empty.
  The only thing that is actually lost is the entire box (happened twice): `backup-sessions.mjs`
  exists but nobody schedules it.
- **Permission is not auto-approved anymore.** The turn waits for decision in chat; no timeout, it
  cancels when stopping, closing or disconnecting. See [`docs/permissions-extensions.md`](docs/permissions-extensions.md).
- **A stuck `session/new` no longer hangs the app.** Limit `ACP_SESSION_TIMEOUT_MS` (60 s); the
  error arrives to the browser naming active extensions, and the real cause to the server log
  (`[conversations] …`). Before, every error was "Check connection with agent".
- **The extension db is from branch `sesion-4-mcp`** (one col per field, `id` UUID,
  `name` unique, `ACP_EXTENSIONS_DB` / `.data/extensions.db`): a file written in one branch is
  read in another. A `.db` of intermediate format (`configuration` JSON) auto-converts on open.
- **`tests/permissions.integration.mjs` runs against `build/`**: if it fails after code changes,
  first `npm run build`.
- **Google Maps (Oct 7, 2026).** Grounding Lite MCP (`https://mapstools.googleapis.com/mcp`) as an
  http extension; register it with `scripts/install-maps-mcp.mjs` (uses `GM_MCP_KEY` or `GM_DEMO_KEY`)
  on each app box, then open a new thread. Skill `.agents/skills/trip-planner` plans around the weather
  forecast; it reaches the box only after push + `bootstrap-memory.mjs`. Tool results become a `map`
  event (places + routes) rendered by `MapCard`. Grounding Lite gives no route geometry: the
  browser asks Routes API for the line and drops it if the distance differs >20 %. No transit
  routes. `GM_DEMO_KEY` is exposed to the browser and the demo key is not for production.
- **The stop button does interrupt** (`session/cancel`).
- **The methods are `_unstable`.** Everything that fills empty views is named like that in goose:
  might change without warning.
- **EasyBits http MCP does not deliver tools with goose/ghosty — and is not the provider.** Investigated
  Sep 12, 2026. The server works (curl `tools/list` returns 87 tools, including
  `research_search` and `research_scrape`), goose accepts in `session/new`, but the model sees
  none; only `ui://easybits/*` resources arrive. The cause is in the box log
  (`/data/ghosty/state/logs/cli/<date>/*.log`, not journald):
  `extension_manager "Failed to list tools" error="Unexpected response type"`. It's rmcp 3.1.4
  (ghosty 1.48.0 MCP client) rejecting the `tools/list` response: EasyBits sends
  `"cacheScope":"connection"` and the rmcp enum —and MCP schema— only accepts `"public"` or
  `"private"`. `ListToolsResult` fails, untagged `ServerResult` falls through, and goose
  discards the list. `resources/list` doesn't have `cacheScope`, so resources show up. Same thing
  happens to the builtin `easybits` extension and the stdio package
  `@easybits.cloud/mcp` (proxy to same endpoint). Fix: EasyBits (a server-side change); meanwhile,
  a stdio proxy that rewrites `cacheScope` is the only way out from goose.
  - **Why it "worked" in branch `sesion-4-mcp` with `claude-acp` + Sonnet:** it’s not goose with
    another model, it's another agent with a different MCP client (the TypeScript SDK, tolerant of the enum).
    Same server, same bug; strict in only one client. The branch annotated as "it was the
    provider" is the same bug but from the other side.
  - **What did work from that session:** credential goes in the URL (`?token=`), not in
    `headers[]`. EasyBits responds to 401 with `WWW-Authenticate: Bearer resource_metadata=…` and
    goose sees it as OAuth: starts browser login (`If the browser did not open,
    authorize … at:` in journald) and `session/new` hangs. With `?token=` connects in 2 s.
    And with `claude-acp` you need `GOOSE_MODE=approve` or the turn dies with `Internal error`.
  - **Verified Sep 12 with agent (`claude-acp`/sonnet):** the http extension with
    `?token=` loads in 1 s and the model called `mcp__EasybitsTools__research_search` with real results.
    From goose/DeepSeek you also get output: the box includes
    `/data/tools/easybits-mcp-proxy.mjs`, which rewrites `cacheScope`; as stdio extension
    (`/usr/local/bin/node /data/tools/easybits-mcp-proxy.mjs`, env `EASYBITS_API_KEY` +
    `EASYBITS_MCP_URL=https://www.easybits.cloud/api/mcp?tools=web`) delivers the 11 `web` tools.
  - **But the agent does not use them on its own:** with `claude-acp` the brain only reads `/data/work/CLAUDE.md`
    (copy of `/data/ghosty/config/.goosehints` at startup), and there it is told to use
    `/opt/gs-sdk/web.mjs` and not the native tools — it obeys even if told otherwise, and
    `web.mjs` is broken on this box (missing `.gs-turn.json`). To make "search X" go to the MCP you
    have to change that rule in both files, with preference order (EasyBits MCP if in session →
    `web.mjs` → native). Applied Sep 13 in both files; text is in
    [spec 4](docs/spec4-permisos-extensiones.md). Applies for new conversations.
  - **Note: neither of these files is the source.** `/usr/local/bin/ghosty-lite-start` (comes
    in the template image, not this repo) does at every systemd unit start
    `cp /opt/goose/goosehints.md → /data/ghosty/config/.goosehints`, appends the `hilos` section
    from a heredoc in the script itself and copies the result to `/data/work/CLAUDE.md`. What you
    edit in `/data` lasts until the next boot: `restart_machine`, `systemctl restart`, or a
    crash of `ghosty serve` (`Restart=on-failure`). Suspend/wake does NOT count: it’s a memory
    snapshot, the script does not run (checked Sep 19: only one boot since Sep 12,
    `NRestarts=0`, 31 hr uptime in 6 days). The Sep 13 changes are still there for that reason, not
    because they persist. To make them last you have to also edit `/opt/goose/goosehints.md` (template disk root: survives reboots, not a new box or rebake).
  - **Sep 19:** both `/data` files translated to English (`.es.bak` copies next to them) and with
    the block `## Output format by channel` (`HINTS_BLOCK` in `artifact-instructions.ts`). The app
    no longer sends instructions on every `session/prompt`: whoever provisions the box installs them with
    `scripts/install-hints.mjs`, including the baked-in copy restored on startup.
    WhatsApp turns send just the line `[channel: whatsapp-group]`.
    There is no automatic check nor fallback for in-line instructions.

## Production

Two EasyBits boxes, and easy to confuse:

| | App | Agent |
|---|---|---|
| id | `sb_97a7e9bf-e516-453e-8acf-ddd54e6d1fdc` (template `node`) | `sb_dc72993b-5fd9-4f25-b9f0-b6078632f7cd` (ghosty-lite) |
| URL | https://acp-agent.ismaelfrancisco.tech (Caddy → :3000) | `wss://acp-6aa757c3…/acp` |
| persistent disk | `/app` (ext4, `/dev/vdb`); **no `/data`** | `/data` |
| what stores | repo + `build/` + `.data/extensions.db` | `sessions.db` |
| logs | `/var/log/easybits-app.log`, `journalctl -u easybits-app` | `/data/ghosty/state/logs/cli/…` |

The app runs as `easybits-app.service` (`Restart=always`), started by
`/app/.easybits-start.sh`, which loads `/app/.easybits.env` (the secrets from `easybits.json`) and does
`exec node server.js`. **Just one instance**: the ACP engine is single-process state (`connection`,
`active`, `history`); with two replicas SSE fails on one and POST on the other.

Deploy = push commit and rebuild in the box; a restart alone does not bring new code:

```sh
git push origin main
# on the app box (POST /api/v2/sandboxes/<app>/exec):
cd /app && git fetch -q origin main && git checkout -q -B main origin/main && (npm ci || npm install) && npm run build
# restart service: tool `restart_machine` from EasyBits MCP (?tools=sandbox,hosting,fleet)
# Without `npm ci` a commit adding packages starts with ERR_MODULE_NOT_FOUND and everything gives 500 (Sep 15).
```

Changing an environment variable = two steps, no build or git: (1) `set_machine_secrets` (EasyBits
MCP tool, or the dashboard) with **only the value** — on Sep 15 `WHATSAPP_ADMIN_KEY` was stored as
`' WHATSAPP_ADMIN_KEY=…'` for pasting the whole line and the key never matched; (2) restart
(`restart_machine`): `.easybits.env` is read once at startup and the process does not reread. A
new variable must also be in `secretNames` in `easybits.json`. Check with
`systemctl show easybits-app -p ActiveEnterTimestamp` (should be newer than the change) and `grep` in the file.

To look inside, `exec` with a command: `ls /app/.data`, `tail /var/log/easybits-app.log`, or the
extensions db with `node -e` and `node:sqlite` in `readOnly` mode (never `cp` with WAL open).

- **Behind Caddy, Express thought it was speaking http** (`req.protocol`) and `request.url` showed
  the wrong scheme: `assertSameOrigin` rejected with 403 the POST from the browser itself to
  `/api/extensions`. Fixed Sep 14 (`99470dc`): `app.set("trust proxy", true)` in
  `server.js` and the check now trusts `Sec-Fetch-Site` (set by the browser) and compares
  `Origin` only by host, not by scheme. In dev it wasn’t visible because there’s no proxy.

## Recommended pending items (Sep 15, 2026, after closing WhatsApp)

Ordered by what would hurt most if missing. The top three go before leaving the channel
working in prod unseen.

1. **Real auth.** Currently the gate is `WHATSAPP_ADMIN_KEY` + HMAC cookie
   (`app/.server/admin-gate.ts`) and only covers `/whatsapp` and its two APIs: chat,
   extensions and sessions are still open to anyone with the link. The natural way: a user session
   (passkey/OAuth or simple login) and same `requireAdmin` on all write routes. `admin-gate`
   is built so replacing it is just changing a function.
2. **Browser reconnection to chat.** When the box sleeps the server sends `closed` and
   `useAcpStream` does not reopen the `EventSource`: the chat is dead until reload. Backoff and
   `snapshot` on return. With WhatsApp entering the same thread this is felt more (the thread changes
   without the browser knowing).
3. **One turn at a time, even for groups.** `askFromChannel` enqueues; with two groups active and a
   slow agent the queue grows and the second group waits minutes with no notice. Measure, and if it's
   a problem, a "queued" message to the group or one thread per group (which breaks "only one live session").
4. **Channel scope.** Only groups; needs DM to owner (useful to operate without group),
   audios/voice notes (transcribe before sending), docs, quoted messages, edited and
   deleted. Each is a different message type in and out.
5. **Optional mention.** In groups with people, replying to everything is noise: a switch per
   group "only if mentioned or replying to agent".
6. **Channel security.** Limit incoming photo size (today it takes whatever comes),
   frequency cap per group, and remove credentials from the db when unpairing from phone (already done)
   and after 5 failed reconnects (currently stays). Review that `WHATSAPP_LOG=debug` is never active
   in prod: prints secrets.
7. **Operation** ([`docs/operacion.md`](docs/operacion.md) is still the plan): alert when the
   channel transitions to `failed` or `disconnected` unexpectedly (a DM to owner is enough),
   `/healthz` with channel and ACP connection state, and `backup-sessions.mjs` scheduled.
8. **Permission from group** (spec 4): blocked by ghosty (`No task waiting for
   confirmation`). Meanwhile, thread runs in `ACP_MODE=auto`: agent executes without asking,
   also anything that comes by WhatsApp. This is a deliberate choice; keep in mind when enabling a group with strangers.
9. **Tests.** The channel has none: at least `paraWhatsApp`, burst buffer,
   `authState` on sqlite (round-trip with `BufferJSON`) and `admin-gate` with `node --test`,
   like `titles.test.mjs`.
10. **Hygiene.** Update Node to ≥ 22.22 on the app box to stop seeing the React
    Router warning; `--env-file-if-exists` in `npm start` if anyone ever uses the Dockerfile;
    thread titles ("New Chat") waiting for agent; and a short `README` of "how to link WhatsApp".

## Next steps

Sessions 3 to 6 are sketched in `docs/`, each with what's already known about the protocol and
what still needs deciding. The natural order follows the syllabus: first revive (session 3), because all the rest
depends on persisting state.

Two loose notes before starting:

- `.agents/skills/react-router/` comes from scaffold. **Do not remove**: in session 1 it serves as
  a live example that skills come from the `cwd` that is sent in `session/new` — goose reads it
  from the project and announces it to the editor with `available_commands_update`.
- The `Dockerfile` **is not used in prod** (see "Production"). If it is ever used: `npm start` does
  `node --env-file=.env`, which blows up if file not present; change to `--env-file-if-exists=.env`.
