# An agent on its own machine

A web interface for an agent that **does not run on yours**: it lives inside a microVM, runs its
own disk, and you interact with it through the [Agent Client Protocol](https://agentclientprotocol.com) over
WebSocket.

```text
[ Browser ]
     │  SSE — events already translated, the browser never speaks ACP
[ This app ]         React Router · SSR · Express
     │  wss://sb-<id>-3000.sandboxes.easybits.cloud/acp
[ The box ]          goose serve · EasyBits microVM · own LLM
```

## Branches

| Branch | What's in it |
|---|---|
| `main` | The app at the end of **session 1**: a full turn against the agent. Starting point. |
| `sesion-2` | `main` + what's in **session 2**: conversation hub, tool and thought cards, model selector. |

```sh
git clone https://github.com/blissito/acp-agent-ui
git switch sesion-2      # or stay on main to start from scratch
```

## The workshop

Material from **[Sistemas Agénticos](https://www.fixtergeek.com/sistemas-agenticos)**, six sessions,
one document per session in [`docs/`](docs/).

| | Session | Document | Status |
|---|---|---|---|
| 1 | Lives outside your computer and wakes up when you call it | [`spec1-agente-fuera.md`](docs/spec1-agente-fuera.md) | ✅ |
| 2 | Its own UI, showing what it's doing as it does it | [`spec2-ui-solida.md`](docs/spec2-ui-solida.md) | ✅ |
| 3 | You kill it mid-task and it resumes where it left off | [`spec3-revivir.md`](docs/spec3-revivir.md) | planned |
| 4 | Answers via WhatsApp and asks for permission there | [`spec4-permisos-extensiones.md`](docs/spec4-permisos-extensiones.md) | extensions and permissions ✅ · WhatsApp planned |
| 5 | Robust, running, and able to detect if it breaks | [`spec5-operacion.md`](docs/spec5-operacion.md) | planned |
| 6 | Doing your thing: skills | [`spec6-habilidades.md`](docs/spec6-habilidades.md) | planned |

Day-to-day operational status lives in [`ESTADO.md`](ESTADO.md). An early attempt at the
interface, as SPA, ended up in [`legacy/`](legacy/).

## Running it

On the other side, you need an agent that speaks ACP. Two ways:

- **[Ghosty Lite](https://www.easybits.cloud/docs#ghosty-lite)** — the shortcut. A Rust agent that
  already speaks native ACP, runs in its own microVM with persistent `/data`, and uses your EasyBits key as
  its brain (no extra OpenAI or Anthropic credentials). Create it with a `POST /api/v2/agents` and
  `template: "ghosty-lite"`; when it's `running`, its `agentUrl` and its `embedToken` are the two
  variables below. It sleeps after 2 hours idle and wakes up in ~1s with its disk intact.
- **goose in your own box** — the long path, session 1.
  [`scripts/install-goose-unit.mjs`](scripts/install-goose-unit.mjs) readies it and creates the
  `.env`.

```sh
npm install
cp .env.example .env      # and fill it in
npm run dev               # http://localhost:5173
npm run build && npm start   # production
```

You only need two variables:

```sh
ACP_WS_URL=wss://acp-<agentId>.sandboxes.easybits.cloud/acp   # the agent's `agentUrl`
ACP_TOKEN=<the agent's token>                                  # `embedToken` from Ghosty Lite, or ACP_AGENT_TOKEN if using goose
```

Optional: `ACP_CWD` (defaults to `/data/work`), and `AGENT_BOX_ID` + `EASYBITS_API_KEY` so the
app can wake and suspend the box for you. Without these two, the agent must already be up.

Node ≥ 22.22. `react-router dev` doesn't read `.env` on its own: scripts pass `--env-file`.

## How it's built

The chat includes [Artifacts](docs/artifacts.md): a panel with preview, editing,
download, and a local library for code, documents, SVG graphics, and HTML apps.

| Path | Description |
|---|---|
| `app/.server/acp.ts` | The engine: one ACP connection per conversation, box lifecycle. |
| `app/routes/api.conversations.$id.events.ts` | SSE as a resource route. |
| `app/routes/_shell.tsx` | Layout with navigation panel. |
| `app/routes/hub.tsx` · `chat.tsx` | Home and conversation. |
| `app/lib/theme.ts` | Theme stored in a cookie — with SSR, it can't live in `localStorage`. |
| `server.js` | Express for production. |
| `scripts/` | Startup audit and the systemd unit for the agent. |

The UI layer is a port of [goose Desktop](https://github.com/block/goose) (Apache-2.0); attribution is in [`NOTICE`](NOTICE).

## Three things that will cost you a day if no one tells you

- **`goose serve` listens on `127.0.0.1:3284`.** The sandbox proxy reaches the microVM's IP,
  not its loopback: without `--host 0.0.0.0` it won't be reachable.
- **The token is not the box's `GOOSE_SERVER__SECRET_KEY`.** That one is internal, regenerated at
  every startup, and never leaves the microVM; sending it will get you a 401 that looks like a credentials error.
- **The theme can't live in `localStorage` with SSR.** The script that sets the class before
  hydration causes server HTML mismatch and React breaks the page — and it only happens to users who’ve already chosen a theme, so it all looks fine on first visit.


## Languages

English is the default. Choose English or Spanish in **Settings → Language**.
The preference persists across reloads. See [i18n documentation](docs/i18n.md) for translation catalogs and checks.

## Public demo

Enable `DEMO=true` for one conversation and a shared guest allowance across web chat and individually linked WhatsApp accounts. Turn it off to restore the existing behavior. See [setup, limits, and replacement notes](docs/public-demo.md).
