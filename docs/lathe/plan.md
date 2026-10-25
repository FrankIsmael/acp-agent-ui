# Lathe simulator: plan

A `/lathe` page in this app with a built-in 3D CNC lathe that simulates turning a part from bar stock. The machine, its motion and the material removal are coded once. The AI only supplies the job: the workpiece, the tooling and the toolpaths. This is the idea from [`cnc-lathe-analysis.md`](cnc-lathe-analysis.md): far fewer tokens than generating a whole animated machine each time, more realism, and instant re-runs when a parameter changes.

The AI comes from a **separate agent box** (ghosty-lite with Claude), not the chat's agent, through a `lathe-job` skill installed on that box.

| File | What it is |
|---|---|
| `docs/lathe/plan.md` | This plan |
| `docs/lathe/cnc-lathe-analysis.md` | The original analysis: why a dedicated simulator, and what other simulators exist |
| `docs/lathe/models/` | Model notes (`README.md`), the CNC model (`CNC.glb`, not used by the simulator) and the FBX → GLB converter (`fbx2glb.mjs`) |
| `public/models/lathe.glb` | The lathe model the page loads (converted from the old Unity project's `trn.fbx`: upright, in meters, operator side facing +Z) |

---

## 1. Goals

**First version must:**
- Show the lathe with a spinning chuck and workpiece, plus a carriage, cross-slide and tool that move.
- Run a job: play, pause, step one line, change speed and scrub through the toolpath, while material is removed from the bar live.
- Show live readouts: X (as diameter) and Z position, spindle speed, feed, tool, current G-code line, remaining weight and estimated cycle time.
- Get a job from the lathe agent from a plain description ("a steel dumbbell handle, 30 mm grip, 60 mm bar"), or from a job or G-code you paste or load.
- Use the same look as the model viewer artifact: a 3D stage with a readout overlay and a side panel.

**Later:**
- Chips and coolant.
- Collision warnings (tool holder against the chuck or the part).
- Canned cycles (`G71`, `G70`, `G75`, `G76`).
- Comparing two jobs, exporting G-code, saving jobs.

**Not planned:** milling, full controller emulation (Fanuc or Haas screens), or a CAM system.

---

## 2. Where it lives: a route in `acp-agent-ui`

**Decision:** build the simulator as a `/lathe` route in this app, not as a separate app.

**Why:**
- **No new server.** It uses the same box, domain, Caddy config, deploy (`git push` + rebuild) and logs.
- **The stack is already here.** React Router 8 (framework mode, Express), `@agentclientprotocol/sdk` and `ws`. A server is required either way, because the agent's secret can't be sent to the browser.
- **Shared protection.** It uses the same gate as `/whatsapp` now, and real login once that exists (`ESTADO.md`, pending item 1).

**Rules that keep it separate:**

1. **Its own ACP client.** `app/.server/lathe-agent.ts` doesn't import or change `app/.server/acp.ts`. That engine is built around one agent: `ACP_WS_URL` and `AGENT_BOX` are fixed when the module loads, and it holds in-memory state shared with WhatsApp, permissions and titles. The lathe client is about 150 lines and talks only to the lathe box.
2. **Its own environment variables, all starting with `LATHE_`** (section 4). The chat's `ACP_*` and `AGENT_BOX_ID` stay as they are.
3. **Its own folder.** Everything is under `app/lathe/` plus `routes/lathe.tsx` and `routes/api.lathe.*`. Moving it to its own app later means moving those files and nothing else.
4. **Loaded only on `/lathe`.** Three.js and React Three Fiber (about 1 MB) are imported only from the lathe route, and route code splitting keeps them out of the chat. Check this after M0 by comparing the chat's chunk sizes in `build/client/assets` before and after.
5. **Gated from the first commit.** `/api/lathe/*` calls `requireAdmin` (`app/.server/admin-gate.ts`), the same `WHATSAPP_ADMIN_KEY` gate as `/whatsapp`. Every request spends tokens on the lathe agent, and the rest of the app is still open to anyone with the link.

**Costs of sharing the app** (accepted for now):
- **Deploys are shared.** A broken lathe build, or a new package without `npm ci`, also takes down the chat and WhatsApp. Run `npm run build` and the lathe tests before every push.
- **Each deploy restarts the one process.** That drops WhatsApp for a moment and kills open chat streams, which don't reconnect yet.

**If any of these become true, move it to its own app:** the lathe goes public, it's shown to students, or it deploys much more often than the chat. Even then, it can run as a second service on the same app box (Caddy routes a subdomain to another port), so it still doesn't need a new box.

**New dependencies:** `three`, `@react-three/fiber` 9, `@react-three/drei` 10, `@types/three` and `zod` (none of them are in the repo yet). Pin exact versions released at least two weeks ago.

---

## 3. Architecture

```
┌──────────── Browser (/lathe) ────────┐   ┌──── acp-agent-ui server ──────┐   ┌──── Lathe agent box ───┐
│ 3D lathe (R3F)                       │   │ React Router + Express        │   │ ghosty-lite + Claude   │
│ Simulation engine (pure TS)          │   │                               │   │ (LATHE_AGENT_BOX_ID)   │
│ Job editor / G-code editor           │   │ POST /api/lathe/jobs ─────────┼──▶│ skill: lathe-job       │
│ "Describe the part" box ─────────────┼──▶│   lathe-agent.ts (wss+Bearer) │   │                        │
│                           ◀── SSE ───┼───│ GET /api/lathe/jobs/:id/events│◀──┤ ```lathe-job``` block  │
└──────────────────────────────────────┘   │ checks the job with zod       │   └────────────────────────┘
                                           │                               │
                                           │ acp.ts → chat agent (as now)  │──▶ chat agent box (unchanged)
                                           └───────────────────────────────┘
```

- **Simulation engine:** plain TypeScript in `app/lathe/sim/`, with no React or Three.js. It turns a job into a timeline of machine states, and the 3D scene just draws a given moment. That keeps it testable with `node --test` and makes scrubbing cheap.
- **The server is thin:** it calls the lathe agent, extracts the job from the reply, checks it, and streams progress to the browser. It doesn't simulate anything.
- **Works without the agent:** loading or pasting a job never touches the server, so the simulator still works when the lathe agent is asleep or down.

---

## 4. Talking to the lathe agent

### Server routes (all behind `requireAdmin`)

| Route | What it does |
|---|---|
| `POST /api/lathe/jobs` | Body `{ prompt, sessionId? }`. Starts a turn and returns `{ jobId, sessionId }`. |
| `GET /api/lathe/jobs/:jobId/events` | Server-sent events: `status` (`waking` · `thinking` · `writing`), `text` (streamed reply chunks), `job` (the checked job), `error`, `done`. Heartbeat every 25 s, like the chat's events route. |
| `POST /api/lathe/jobs/:jobId/cancel` | Sends `session/cancel`. |

Register them in `app/routes.ts` next to the other `api/*` routes.

The page itself goes outside the `_shell` layout, so the 3D stage gets the full screen. It has a link back to the hub.

### ACP client (`app/.server/lathe-agent.ts`)

Copy only the connection pieces of `acp.ts`, which are known to work against ghosty-lite:

1. Open a `ws` connection to `LATHE_ACP_WS_URL` with `Authorization: Bearer ${LATHE_ACP_SECRET}`, wrap it with `createWebSocketStream` from the SDK, and send `initialize` with `protocolVersion: 1` and `terminal: false`.
   - Keep the guard from `acp.ts` for a box that refuses the connection with an `id: null` JSON-RPC error. Otherwise `initialize` hangs until the time limit without saying why.
2. For the first request in a design session, send `session/new` with `cwd: LATHE_ACP_CWD` and no MCP servers. For follow-ups ("make the roughing passes 1.5 mm"), reuse the same `sessionId` so the agent keeps the context.
3. Send `session/prompt` with a tag line plus the user's text:
   ```
   [skill: lathe-job]
   <user prompt>
   ```
4. Collect `agent_message_chunk` text and pass it to the browser as `text` events. When the turn ends, extract the ```` ```lathe-job ```` block, parse it with zod, and send `job` or `error`.
5. Close the connection after `LATHE_ACP_IDLE_MS` of no activity, so the box can sleep.

### Things to handle, from `ESTADO.md`

| Issue | How to handle it |
|---|---|
| The box sleeps when idle, and the first turn takes about 19 s | The WebSocket `Upgrade` wakes the box. Show "Waking the agent…" right away, and retry once if the socket drops while connecting. `ensureAgentBox` in `agent-box.ts` only covers the chat box (it reads `AGENT_BOX_ID` when the module loads), so the lathe client relies on the wake-on-connect alone. Extending its TTL can come later, by taking a box id as a parameter. |
| A stuck `session/new` | Time limit from `LATHE_ACP_SESSION_TIMEOUT_MS` (default 60 s), with a clear error. |
| Permission requests | The skill needs no tools. Reject any `session/request_permission` automatically and note it in the log. `ESTADO.md` notes that ghosty with `claude-acp` doesn't deliver permission replies reliably, so also give the lathe box `GOOSE_MODE=approve`, like the chat box, and a skill that never needs tools. |
| A wrong or partial job | Return the zod errors to the agent as one automatic follow-up ("fix these fields"), then show whatever still fails to the user. |
| State held in one process | The same rule as the chat: one instance of the app. |
| Token cost | `requireAdmin` on every `/api/lathe/*` route, plus a simple limit (for example 20 jobs per hour) until there's real login. |

### Environment (the app's `.env`, never committed)

The lathe agent's values are currently in `/Users/ifrank/code/3D/.env`, under the same names the chat uses. Copy them into this app's `.env` **under new names**, so they don't replace the chat's:

| `/Users/ifrank/code/3D/.env` | This app's `.env` |
|---|---|
| `ACP_WS_URL` | `LATHE_ACP_WS_URL` |
| `ACP_SECRET` | `LATHE_ACP_SECRET` |
| `AGENT_BOX_ID` | `LATHE_AGENT_BOX_ID` |
| `ACP_IDLE_MS` | `LATHE_ACP_IDLE_MS` |
| (new) | `LATHE_ACP_CWD=/data/work` |
| (new, optional) | `LATHE_ACP_SESSION_TIMEOUT_MS=60000` |

Then delete `/Users/ifrank/code/3D/.env`, so the secret is kept in one place only. Add the `LATHE_*` names (without values) to `.env.example`. For the deployed app, also add them to `secretNames` in its `easybits.json`, which lives with the deployed app, not in this repo (`ESTADO.md`, "Production"). In production, set them with `set_machine_secrets` (value only) and restart, as `ESTADO.md` describes.

If `LATHE_ACP_WS_URL` is missing, the page still works for load/paste, and the Describe panel says the agent isn't set up.

---

## 5. The `lathe-job` skill (lathe agent side)

**File:** `.agents/skills/lathe-job/SKILL.md` in this repo, next to `trip-planner`.

### Installing it on the lathe box

The lathe box is a plain instabox box, so `bootstrap-memory.mjs` (EasyBits only) can't reach it. Its own `update-skills.sh` does the same job: it clones or fast-forwards this repo into `data/repo` and links each skill into `data/agent/skills`, which ghosty-lite merges into every conversation. Commit and push first (only pushed commits reach the box), then:

```sh
instabox exec "$CNC_AGENT_BOX_ID" -- 'cd /data/workspace/ghosty-lite && sudo ./update-skills.sh'
# skills @ aff12dd: lathe-job react-router trip-planner
```

Then open a new session. The script skips a skill whose entry in `data/agent/skills` is a real folder rather than a link; delete that folder first.

The links point at container paths (`/data/repo/...`), so they only resolve inside the container. To read what the agent gets:

```sh
instabox exec "$CNC_AGENT_BOX_ID" -- 'sudo docker exec gl cat /data/agent/skills/lathe-job/SKILL.md'
# on the box itself: /data/workspace/ghosty-lite/data/repo/.agents/skills/lathe-job/SKILL.md
```

**The chat agent gets the skill too.** Both boxes clone the same repo, so the chat agent will also list `lathe-job`. That's harmless, because the skill only runs for prompts tagged `[skill: lathe-job]`. To keep it off the chat box anyway, install the lathe box from its own branch: `sudo SKILLS_REPO_BRANCH=lathe ./update-skills.sh`.

### The lathe box's system prompt (optional)

The lathe box gets its own prompt, `scripts/lathe/system-prompt.md`: lathe jobs only, and load the `lathe-job` skill once per conversation (a follow-up that reloads it only gets "already loaded" back, an extra model call). Without it the box's `CLAUDE.md` was Robbie's whole chat persona (15 KB). The lathe box is a plain instabox box running ghosty-lite in Docker (container `gl`), not an EasyBits agent, so `update-agent-prompt.mjs` can't reach it. Write the file (without its leading comment) to `/data/agent/PROMPT.md` in the container and rebuild the copies:

```sh
perl -0pe 's/^<!--.*?-->\s*//s' scripts/lathe/system-prompt.md |
  instabox ssh "$CNC_AGENT_BOX_ID" -- "sudo docker exec -i gl sh -c 'cat > /data/agent/PROMPT.md && ghosty-prompt-hooks'"
```

Robbie's prompt that was there before is saved in `/data/agent/PROMPT.md.robbie-20261025`.

### No todo list on the lathe box

ghosty starts with the built-in `todo` extension (`ghosty-lite-start` passes `--with-builtin "${GHOSTY_BUILTINS:-developer,todo,chatrecall}"`), which adds "Current tasks and notes: Once given a task, immediately update your todo…" to every turn's `<turn-context>`. The lathe agent uses no tools, so leave it out in the box's `lite.env`, then recreate the container (`lite.env` is only read when it is created; `todo: enabled: false` in ghosty's `config.yaml` does nothing, the flag wins):

```sh
instabox ssh "$CNC_AGENT_BOX_ID" -- 'cd /data/workspace/ghosty-lite &&
  (grep -q "^GHOSTY_BUILTINS=" lite.env || echo "GHOSTY_BUILTINS=developer,chatrecall" >> lite.env) &&
  sudo ./run.sh'
```

`run.sh` also runs `update-skills.sh`. Check with `sudo docker exec gl sh -c 'ps aux | grep "ghosty serve"'`: the flag should read `--with-builtin developer,chatrecall`.

**Warning about `new-ghosty-agent.mjs`:** never run it for the lathe box as it is. It always rewrites `.env` (`const file = '.env'`), which would replace the **chat's** `AGENT_BOX_ID`, `ACP_SECRET` and `ACP_WS_URL`, and it always sends the chat's `system-prompt.md`. Before using it for a lathe box, add `--env-out` and `--prompt` options to it (left for later, since the box already exists).

### What the skill tells the agent

- You're a CNC lathe programmer. Turn the request into one job, and reply with a short explanation plus exactly one fenced block tagged `lathe-job` that follows the schema below.
- Pick sensible defaults and list them under `assumptions` instead of asking questions: material, bar size, tooling, depth of cut, feeds and speeds.
- Coordinate rules: millimeters, X as a diameter, `Z0` at the finished front face, negative Z toward the chuck.
- In version 1, write out every roughing pass as explicit `G0`/`G1` moves, with no canned cycles.
- Don't use tools or files. The whole answer is text.
- Check the work before replying: the G-code stays inside the stock and the chuck clearance, the profile is reachable with the chosen insert, and every tool used is in `tools`.

### Job format, draft v1 (`app/lathe/sim/job-schema.ts`)

```jsonc
{
  "version": 1,
  "name": "Dumbbell handle",
  "units": "mm",
  "material": { "name": "AISI 1045 steel", "density": 7.85 },        // density in g/cm³
  "stock":    { "diameter": 60, "length": 160, "stickout": 120 },     // stickout = length out of the chuck
  "profile":  [[0, 0], [0, 50], [-12, 50], [-14, 30], [-96, 30], [-98, 50], [-110, 50]],
                                                                      // finished part: [z, diameter] from the front face
  "bore":     [[0, 22], [-1, 20], [-40, 20]],                           // optional hole along the axis, the same way; drilled,
                                                                      // bored and grooved with drill / boring / internal-grooving tools
  "tools": [
    { "id": 1, "name": "Rougher",   "type": "turning", "insert": "CNMG 120408", "noseRadius": 0.8, "angle": 80, "approach": 95 },
    { "id": 2, "name": "Finisher",  "type": "turning", "insert": "VNMG 160404", "noseRadius": 0.4, "angle": 35, "approach": 93 },
    { "id": 3, "name": "Parting",   "type": "parting", "width": 3 }
  ],
  "operations": [                                                     // summary for the side panel, in order
    { "name": "Face",          "tool": 1, "lines": [5, 14] },
    { "name": "Rough OD",      "tool": 1, "lines": [15, 88], "depthOfCut": 2.0 },
    { "name": "Finish OD",     "tool": 2, "lines": [89, 120] },
    { "name": "Part off",      "tool": 3, "lines": [121, 130] }
  ],
  "gcode": "O1001\nG21 G18 G40 G99\nG50 S2500\nT0101\nG96 S200 M3\n…\nM30",
  "assumptions": ["Bar is 60 mm cold-drawn 1045", "2 mm depth of cut, 0.25 mm/rev roughing feed"]
}
```

**The G-code is what gets simulated.** `profile` is the target shape: the app overlays it as a ghost outline and reports the leftover stock ("0.38 mm left on Ø30"). `operations` drives the panel and the timeline markers; a job may leave it out, and the app then reads the operations from the comment-only lines (`(Rough OD)`) and the tool changes of its G-code.

### G-code supported in version 1

| Codes | Meaning |
|---|---|
| `G0`, `G1`, `G2`, `G3` (`R`, or `I`/`K`), `G4` | Moves, arcs, dwell |
| `G18`, `G21`/`G20`, `G90`/`G91` (`U`/`W` incremental), `G40`/`G41`/`G42` | Plane, units, absolute/incremental, nose radius compensation |
| `G50 S…`, `G96`, `G97`, `G98`/`G99` (also `G94`/`G95`) | Spindle limit, constant surface speed or fixed rpm, feed per minute or per revolution |
| `T0101`, `M3`/`M4`/`M5`, `M8`/`M9`, `M30` | Tool and offset, spindle, coolant, end of program |
| `G28 U0 W0` | Return home |

The app shows a warning, not an error, for codes it doesn't know.

---

## 6. Simulator

### Material removal

The part is round, so the workpiece is just a radius at each point along its length: a `Float32Array r[z]` at 0.05 mm steps (3,200 values for a 160 mm bar).

- **Cutting:** for each move, the tool's cutting shape (nose radius plus insert outline) is swept along the move, and the radius is lowered wherever the tool reaches inside it. That's a 2D calculation, with no CSG and no voxels.
- **Drawing:** a `LatheGeometry`, made from the radius profile and rebuilt only over the changed range, inside a mesh that spins with the spindle. The cut surface gets a light turned-finish texture.
- **Weight:** `Σ π r² dz × density`, updated live, like the video in the original post.
- **Rewinding:** the engine stores a profile snapshot every N moves, so scrubbing backwards is instant.

### Motion

- **From G-code to motion:** a parser turns the program into blocks, and a planner turns the blocks into segments with times.
  - Rapids use set axis speeds.
  - Feed moves use the feed rate: per revolution × rpm, where rpm comes from constant surface speed at the current diameter and is capped by `G50`.
  - Arcs are split into short straight pieces.
- **Cycle time:** the sum of the segment times, shown per operation and in total.
- **Time:** playback is a single time value `t`. `stateAt(t)` returns the tool position, rpm, feed, current line, coolant and the profile. The 3D scene, the readouts and the code editor all read from it.

### The 3D machine

- **Fixed parts:** the static lathe body comes from `public/models/lathe.glb` (1.82 × 1.25 × 0.93 m, 141 meshes). The headstock is at −X, the lead screws are at the front (+Z), and the bed ways sit at about 0.85 m.
- **Matching the model:** the first job is to find the spindle center line, the bed height and the chuck face in the model. Its parts are mostly unnamed (`Body_N`, `3DGeom-N`), so this means checking each part's size and position, as was done to find which way is up (see `models/README.md`).
- **Moving parts:** the model's own chuck, carriage and tool post are hidden or replaced with procedural parts at those positions: a 3-jaw chuck, the workpiece, the carriage (Z), the cross-slide (X), the tool post, and the tool (insert plus holder).
- **Speed:** the chuck spins visually at a capped speed, since real rpm is just a blur. The real rpm shows in the readout.

### Interface (same look as the viewer artifact)

- **Stage:** the 3D view with a coordinates readout in the corner (`X Ø30.000  Z −42.150  S 1,240  F 0.25  T01`) and a status chip (Running · Paused · Done · Warning).
- **Bottom bar:** play/pause, step one line, a speed setting (0.25× to 50×), and a timeline with operation markers and a scrub bar.
- **Side panel:**
  - **Describe:** a text box with a Generate button that streams the agent's reply. A follow-up keeps the same session.
  - **Job:** stock, material and tools, plus the operations list (click one to jump to it).
  - **G-code:** the program with the current line highlighted. You can edit it, and the simulation reruns.
  - **Results:** weight before and after, material removed, cycle time, and leftover stock against the target profile.
  - **Load / paste:** a job JSON or plain G-code (plain G-code needs a stock size), plus example jobs.
- **Views:** camera presets (operator, top, close-up on the tool), a cut-away of the part, and a 2D profile view.
- **Theme and language:** use the app's theme tokens (`app/theme`) and translated strings (`app/i18n.tsx`, `app/locales/en.json` and `es.json`), so the page matches the rest of the app in both languages.

---

## 7. Project layout (inside `acp-agent-ui`)

```
acp-agent-ui/
├── .agents/skills/lathe-job/SKILL.md        ← the skill (installed on the lathe box)
├── app/
│   ├── routes.ts                            ← + lathe, api/lathe/jobs, …/events, …/cancel
│   ├── routes/
│   │   ├── lathe.tsx                        the simulator page (outside _shell)
│   │   ├── api.lathe.jobs.ts                POST /api/lathe/jobs
│   │   ├── api.lathe.jobs.$id.events.ts     SSE
│   │   └── api.lathe.jobs.$id.cancel.ts
│   ├── .server/lathe-agent.ts               ACP client for the lathe box (server only)
│   └── lathe/
│       ├── sim/                             pure TS, unit tested
│       │   ├── job-schema.ts                zod schema + types
│       │   ├── gcode/parse.ts, plan.ts      parser, motion planner, timing
│       │   ├── stock.ts                     radius profile, cutting, weight
│       │   ├── tool-shapes.ts               insert outlines
│       │   └── timeline.ts                  stateAt(t), snapshots
│       ├── scene/                           R3F, client only
│       │   ├── LatheScene.tsx, MachineModel.tsx, Chuck.tsx, Workpiece.tsx, Carriage.tsx, Tool.tsx
│       │   └── calibration.ts               spindle center line, bed height, chuck face in model coordinates
│       ├── ui/                              side panel, readout, timeline, editors
│       └── examples/                        dumbbell.json, shaft-with-groove.json, thread.json
├── public/models/lathe.glb                  ← already here
├── docs/lathe/                              ← plan, analysis, model notes, converter
└── tests/lathe/*.test.mjs                   node --test for app/lathe/sim
```

Add a `test:lathe` script to `package.json`, alongside the existing `test:*` scripts.

---

## 8. Milestones

Each milestone ends with something you can run.

| # | Milestone | What it delivers | Done when |
|---|---|---|---|
| **M0** | Route and scene | `/lathe` route outside `_shell`, new dependencies, the lathe model loading upright and lit, the viewer's look with the app's theme | `npm run dev` → `/lathe` shows the lathe, and the chat's bundle size is unchanged |
| **M1** | Match the model | Spindle center line, bed height and chuck face found in the model; procedural chuck, carriage, cross-slide and tool in place | The tool can be moved to X/Z by hand and lines up with the model |
| **M2** | Motion | G-code parser and planner, playback controls, coordinates readout, G-code with the current line highlighted | A hand-written program plays with correct moves and cycle time (`npm run test:lathe`) |
| **M3** | Cutting | Radius profile, tool shapes, live material removal, weight, leftover stock against the target profile, scrubbing | The dumbbell example cuts correctly and the weight matches the expected value within 1 % |
| **M4** | Jobs | zod schema, load/paste, example jobs, job and operations panels | A pasted job JSON runs from start to end |
| **M5** | Agent | `lathe-agent.ts`, `api/lathe/*` routes behind `requireAdmin`, Describe panel, `lathe-job` skill installed with `update-skills.sh`, automatic fix-up turn | "Steel dumbbell handle, 30 mm grip" gives a job that simulates without errors, end to end against the live lathe box, and the chat still works |
| **M6** | Polish | Chips (particles from the tool tip, sized by feed), coolant, collision warnings, camera presets, 2D profile view | — |
| **M7** | Later | `G71`/`G70`/`G75`/`G76`, threading, saving jobs, `--env-out`/`--prompt` options for `new-ghosty-agent.mjs`, a job limit per hour | — |

M0 to M4 don't touch any agent. M5 is the only step that needs the lathe box. No milestone changes `acp.ts` or the chat's environment.

---

## 9. Risks

| Risk | How to reduce it |
|---|---|
| A lathe change breaks the chat or WhatsApp (shared build and process) | Lathe code stays in its own folder and routes, never imports `acp.ts`, and is checked with `npm run build` plus `npm run test:lathe` before every push. |
| The lathe's secret ends up replacing the chat's | Only `LATHE_*` names, and never run `new-ghosty-agent.mjs` for the lathe box until it has `--env-out`. |
| The lathe model's parts are unnamed and might not separate cleanly into moving parts | Use procedural moving parts placed at the matched positions, and keep the model for the fixed body only. |
| The agent writes G-code that doesn't fit the job (out of the stock, crashes into the chuck) | Checks in the skill, plus zod and the simulator's warnings, plus one automatic fix-up turn. |
| The lathe box sleeps, or gets recreated and loses the skill | Show a wake-up status, and keep load/paste so the page works anyway. Recreating the box means running `update-skills.sh` again (section 5). |
| Token cost | `requireAdmin` plus a per-hour job limit. Real login replaces the gate later. |
| Speed with fine resolution | Rebuild only the changed part of the geometry, take snapshots every N moves, and cap the visual spindle speed. |
| Agent API names marked `_unstable` change | Use only stable methods (`initialize`, `session/new`, `session/prompt`, `session/cancel`). |

---

## 10. Open questions

1. **Skill install:** should the skill go on the main branch (so the chat agent sees it too, which is harmless), or on a `lathe` branch only?
2. **Units:** metric only, or also inches (`G20`)?
3. **Controller dialect:** plain Fanuc-style G-code, or a specific controller (Haas, Fanuc 0i, Siemens)?
4. **Hub entry:** should `/lathe` get a card on the hub page, or stay a direct link for now?
