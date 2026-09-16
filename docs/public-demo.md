# Public demo

A removable guest policy for sharing this app from one server. No signup, passwords, or external auth service.

## Enable

Set these environment variables and restart the app:

```dotenv
PUBLIC_DEMO=true
DEMO_TOKEN_LIMIT=16000
DEMO_TURN_LIMIT=4
DEMO_CONTACT_URL=mailto:ismaelfcom93@gmail.com
```

The defaults allow **one conversation per browser guest**, with up to four prompts and 16,000 estimated tokens shared between the web chat and that guest's WhatsApp. Start with an image request and a few short questions; adjust the limits after trying the model you host. The contact banner includes the configured email and [Ismael's LinkedIn](https://www.linkedin.com/in/ismaelfcom/). WhatsApp sends the same invitation and contact URL.

`PUBLIC_DEMO=true` replaces the WhatsApp admin key check with guest ownership. Existing owner WhatsApp credentials are never given to guests. Leave the owner key configured so switching demo mode off restores the gate.

Use a **separate demo agent/VM containing only public material**, with a provider spending cap. This layer isolates HTTP conversations and WhatsApp credentials, but the current ACP agent still has a shared filesystem, skills, memory, and tool access. It is not a tenant sandbox: visitors can ask its tools to access whatever that agent can access. Do not point a public demo at a private working agent.

## Guest behavior

- A random HttpOnly cookie identifies a persistent guest record. The browser keeps it for 30 days. No login or cross-device recovery.
- “Nueva conversación” returns that guest's existing conversation. Opening, closing, or reloading it does not consume prompts or tokens and does not reset the quota.
- Conversation lists, page loaders, mutations, and event streams enforce ownership. An unowned or another guest's conversation returns 404.
- Each guest links their own WhatsApp using the existing QR/code flow. Credentials and group settings live in a separate SQLite file per guest. All enabled groups and web chat share that guest's single conversation and quota.
- Clearing cookies loses access to the guest. A previously linked WhatsApp number cannot claim a fresh guest allowance; its normalized number is stored as a hash with its original owner. For recovery, contact the owner and unlink the demo device from the phone if needed.
- WhatsApp disconnect/logout remains available after quota exhaustion. The limit invitation is sent at most once per group per running process to avoid replying to every message after exhaustion. After a server restart a guest must open WhatsApp in the web app to resume their connection.
- The agent still runs one active conversation at a time. A different guest cannot interrupt a running reply; they get a busy response and can retry when it finishes. This is intended for a small shared demo.
- Recetas, Apps, and Agenda are unavailable in demo mode. Habilidades and Extensions remain available as catalogs of the skills and tools guests can ask the agent to use; shared configuration stays owner-managed. The unfinished sections are otherwise unchanged. Model switching is disabled in the demo so visitors use the server's configured model.

## What “tokens” means here

ACP's `usage_update.used` measures context occupancy, not cumulative billable usage. The demo therefore uses an explicit **estimate**, separate from the existing model usage display:

- Input and previous conversation text: UTF-8 bytes / 3, rounded up.
- Each prompt reserves 2,048 units for instructions/tool schemas, plus input/context and 2,048 per input/context image.
- Streamed answer and reasoning text consume units as they arrive. Each new tool call consumes a fixed 1,024 units, including tools that generate images.
- Reservations and turn increments are atomic and persistent; interrupted/failed turns stay charged. A prompt that cannot fit is rejected before reaching the agent.
- At the estimated budget boundary or after 120 seconds, the app requests cancellation. This is cooperative: a remote agent may finish an already-running tool or ignore cancellation. The four-turn cap also stops further prompts when usage reporting is absent.

These are demo cost controls, **not an exact provider token or dollar cap**. Tool-internal model calls, image-generation pricing, remote system prompts, and cancellation overshoot are not fully measurable through this ACP connection. There is no hard “one generated image” limit. Use the provider's spending cap for a hard financial ceiling.

## Persistence and controls

Persist the directory containing `DEMO_DB` (default `.data/demo.db`). It contains the guest database and `whatsapp-guests/<guest-id>.db`. Guest tokens are stored hashed; WhatsApp credentials are server-only and files are mode 0600. Back up and protect the whole directory.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_DEMO` | `false` | Master toggle, only literal `true` enables it |
| `DEMO_DB` | `.data/demo.db` | Separate demo data store |
| `DEMO_TOKEN_LIMIT` | `16000` | Estimated lifetime token allowance per guest |
| `DEMO_TURN_LIMIT` | `4` | Lifetime prompt allowance, web + WhatsApp |
| `DEMO_GLOBAL_TOKEN_LIMIT` | `500000` | Combined estimated allowance across all guests |
| `DEMO_USER_LIMIT` | `200` | Maximum guest records in this demo database |
| `DEMO_CONTACT_URL` | `mailto:ismaelfcom93@gmail.com` | HTTPS or email contact link |

Guest token/turn limits and the global/user caps do not reset daily. Increasing them and restarting extends the allowance. Browser guests are intentionally lightweight: clearing cookies can create another web guest only within the per-IP guest allowance and global/user caps. Changing networks or using a VPN can still obtain another IP allowance. Run one app process/replica; ACP state and the WhatsApp socket registry are process-local.

## Per-IP protection

IP limits apply automatically when `PUBLIC_DEMO=true`; there is no additional service or signup flow.

| Variable | Default | Window / scope |
| --- | --- | --- |
| `DEMO_IP_GUEST_LIMIT` | `3` | New browser guests per 24 hours |
| `DEMO_IP_CHAT_LIMIT` | `10` | Message submission POSTs per minute |
| `DEMO_IP_WHATSAPP_LIMIT` | `5` | WhatsApp connect/pair attempts per hour, including invalid pairing attempts |
| `DEMO_IP_API_LIMIT` | `120` | API mutations per minute, excluding conversation creation/resume |
| `DEMO_TRUSTED_PROXIES` | empty | Actual reverse-proxy IPs/CIDRs allowed to supply forwarding headers |

Each window begins with the first accepted request for that IP and category. Rejected requests do not extend it. A known guest browsing the app does not consume another guest slot. Page loads, API reads, polling, SSE reconnects, and conversation creation/resume do not consume the chat or API request allowance. WhatsApp logout/disconnect is exempt from the pairing limit (the general API limit still applies). Phone messages use the guest token/turn allowance; IP limits apply to web HTTP requests, not to individual WhatsApp message senders.

Limits are stored in the demo SQLite database and survive restarts. Only a keyed hash of the normalized IP/network is stored in the rate-limit table; the random hashing key is persisted in the same database. Expired rate-limit rows are removed during subsequent accepted limiter checks. IPv4-mapped IPv6 addresses map to IPv4; native IPv6 addresses share a /64 allowance to discourage address rotation. People sharing a public IP or IPv6 /64 share its limits.

A rejected request returns HTTP 429 with `Retry-After` in seconds and `code: DEMO_IP_LIMIT` for API clients. Initial HTML visits get a contact message with a retry time. Other existing guest allowances are not reset or deleted.

### Reverse proxy setup (important behind Caddy)

The production Express adapter overwrites `x-demo-client-ip` with its resolved client IP. Visitor-supplied `x-demo-client-ip`, `CF-Connecting-IP`, and untrusted `X-Forwarded-For` values cannot choose the quota key. Vite development always uses the TCP peer and ignores forwarded IPs.

For direct hosting, leave `DEMO_TRUSTED_PROXIES` empty. If Caddy connects from the same machine, set:

```dotenv
DEMO_TRUSTED_PROXIES=loopback
```

For a separate proxy, list its actual IPs or narrowly scoped CIDRs, separated by commas. The proxy must sanitize/append forwarding headers appropriately. Do not trust `0.0.0.0/0`, `::/0`, arbitrary client networks, or a blanket number of hops. With no trusted proxy configured, requests arriving through one proxy safely share that proxy's IP allowance; configure the actual proxy addresses to distinguish visitors. Restrict direct access to the app port when hosted behind a proxy.

To change the limits, edit the values and restart. `PUBLIC_DEMO=false` disables all demo IP limits along with the existing demo policy. The replaceable limiter lives in `app/.server/demo-ip.ts`.

## Disable or replace later

Set `PUBLIC_DEMO=false` and restart. Demo middleware and agent quota checks become no-ops; the original WhatsApp admin gate and shared owner channel return. Guest data remains on disk, and guest channels are not started. This toggle restores the existing app's access behavior; it does not add a site-wide admin gate.

The policy lives in `app/.server/demo.ts`; the route boundary is `app/.server/demo-middleware.ts`. Future authentication can replace `demoUser` with a real user ID and migrate the conversation/WhatsApp ownership mappings. Future billing can replace the reservation and charging functions without redesigning chat. `DemoNotice` and `/api/demo` expose the small UI contract.

## Verification

```sh
npm run typecheck
npm run build
npm run test:demo
```

The integration test uses only a local mock ACP agent and temporary databases. It checks independent guest cookies, history/page/SSE/mutation ownership, repeated and concurrent creation, prompt limits before agent invocation, busy-session protection, private WhatsApp group state, persistent limits after restart, restoration of the owner gate, concurrent cookie-reset limits, spoofed IP headers, trusted-proxy handling, IP counters after restart, and repeated reloads/SSE reconnects without consuming interaction allowances. It does not link a real WhatsApp number or spend model/image tokens. Live pairing and model behavior need a manual smoke test with the demo agent.
