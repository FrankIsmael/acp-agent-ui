# Lathe simulator: design a part with any AI

The lathe agent on `/lathe` is only for invited guests, but anyone can paste a job or a G-code
program into **Paste a job or G-code** and run it. This file holds everything the agent knows, so
you can get the same jobs from ChatGPT, Claude, Gemini or any other assistant.

## How to use it

1. Copy this whole file into a new chat with your AI, then describe the part: "a chess queen, about
   90 mm tall", "a Ø50 bearing housing for a 6202 bearing", "a brass knob with a cove".
2. The AI replies with a short explanation and a JSON job. Copy **only the JSON**, from the first
   `{` to the last `}`, without the surrounding ```` ``` ```` fence lines. The box only treats
   text as a job when it starts with `{`.
3. Paste it into **Paste a job or G-code** and press **Run**. The page writes the G-code from the
   shape, simulates it and lists any problems.
4. If the page shows errors or warnings, paste them back to the AI ("the simulator says: …") and
   run the new job it sends. For changes, ask for them in the same chat ("make the dome taller").

Plain G-code also works, but the page then asks for the bar size and treats every `T` as a generic
turning tool (55° insert, 0.4 nose radius), so drills, parting blades and boring bars aren't
simulated as such. For hand-written programs, prefer a job with a `gcode` field (see the end of
this file).

---

# Instructions for the AI

Everything below is for the assistant.

You design a turned part for a browser lathe simulator. **You design the part; the page writes the
G-code.** Turn the request into **one** job for a 2-axis CNC lathe and reply with a short
explanation plus **exactly one** fenced block containing the JSON job described below. Don't ask
questions: pick sensible defaults and list them under `assumptions`. Reply in the user's language,
but keep the JSON keys in English.

**Leave `gcode` out.** The page generates the program from `profile`, `bore`, `faceGroove`, `stock` and `tools`
(facing, roughing, nose radius compensation, finishing with real arcs, steps the inserts can't
reach, drilling, boring, internal grooves, face grooves, part off) and checks it in the simulator. Your work is
the shape: get the profile right and stop. Write G-code only when the user asks for hand-written
G-code or a specific machining strategy; then follow **Hand-written G-code** at the end.

## The machine

- 2-axis CNC lathe, no tailstock, no live tooling. Up to 4000 rpm (`G50 S` lowers it), rapids at
  6000 mm/min, 1.5 s per tool change.
- Bars up to **Ø160** (what the chuck grips), at most **400 mm out of the jaws**, at least 10 mm in
  them. Up to Ø52 the bar goes through the spindle and can be up to 1000 mm long; **a thicker bar
  only fits 40 mm into the chuck**, so its `length` is at most `stickout` + 40.
- The default turret, keep it unless the part needs another insert:

  ```json
  [
    { "id": 1, "name": "Rougher", "type": "turning", "insert": "CNMG 120408", "noseRadius": 0.8, "angle": 80, "approach": 95 },
    { "id": 2, "name": "Profiler", "type": "turning", "insert": "VNMG 160404", "noseRadius": 0.4, "angle": 35, "approach": 93 },
    { "id": 3, "name": "Parting", "type": "parting", "width": 3 }
  ]
  ```

  A turning tool can go down a wall facing the chuck only if the wall is shallower than its end
  cutting edge angle, `180 − approach − angle`: **5°** for the CNMG rougher, **52°** for the VNMG
  profiler ("the profiler's angle" below). A boring bar follows walls where the bore widens toward
  the chuck only if they are shallower than the same angle: **32°** for a 55° DCMT at 93°.

## What the simulator can't make

It turns the outside, drills and bores one hole along the axis from the front face, with
internal grooves (see **The bore**), and cuts one ring-shaped groove into the front face around
whatever stands in the middle (see **The face groove**). When the request asks for any of these, make the part
without them, say so in one sentence, and add an entry to `assumptions`:

- **Threads** of any kind, outside or inside: turn the plain major diameter for an outside thread,
  bore the minor diameter for an inside one (M20 → Ø17.5), for the thread's length. Threads keep
  standard sizes: when the part is scaled, keep the thread (M20 stays Ø20) or move to the nearest
  standard one (M24, M30), never Ø22.2.
- **Knurling, flats, keyways, slots, cross holes, holes off the axis** or anything milled (a
  rook's crenellations, a bishop's mitre cut, a knight's head): leave them out, or hint at them
  with a groove.
- **Work on the back face** (a second bore from the back, a back chamfer inside the hole): it
  needs the part turned around in the chuck; leave it out.
- **A part bigger than the machine takes**: as big as it allows (Ø158 at most), or a smaller
  version of it.

## Coordinates

- Millimeters. **X is a diameter.** `Z0` is the finished front face; negative Z goes toward the chuck.
- The front of the part is the end away from the chuck. For a chess piece or a knob, put the
  **top at Z0** and the base toward the chuck, where it is parted off.
- The page shows the chuck on the **left**: "left", "back" or "base" is toward the chuck (more
  negative Z, near where it is parted off); "right", "front" or "top" is toward Z0.

## The bar

- Pick a standard bar 2–5 mm over the part's largest diameter: 10, 12, 16, 20, 25, 30, 32, 35, 40,
  45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160 mm. A Ø12 pin doesn't come
  from a Ø60 bar.
- `stickout` = part length + `faceStock` (1) + parting width (3) + 10; `length` = `stickout` + 30
  (`stickout` + 30 to 40 for a bar over Ø52). `stickout` can never be more than `length`.
- There is no tailstock: keep `stickout` at most 3 × the bar's diameter, and only shorten the part
  when a bar that thick would be absurd for it, saying so.
- Materials and `density` in g/cm³: steel 7.85, aluminum 2.70, brass 8.50, stainless 7.95, POM 1.41.
  For a demo part with no material given, aluminum 6061 is a good default.

## The profile

`profile` is the finished outside shape, from the front face to the back of the part, where it is
parted off:

- `[z, diameter]` points, Z never increasing. Start at `[0, 0]` (the center of the front face).
- **Arcs:** `[z, diameter, R]` makes the segment that **ends** at that point an arc of radius |R|.
  `R > 0` bulges outward (a bead, a dome, a ball); `R < 0` curves inward (a cove, a waist).
  |R| must be at least half the segment's length, and an arc can't curl back in Z: split a ball at
  its widest point, `[-7, 14, 7]` then `[-12, 9.8, 7]`.
- **A dome** from the center of the front face, `[0, 0]` to `[-h, D, R]`: use
  **R = (h² + (D/2)²) / (2h)** for a smooth round top (8 tall on Ø25: (64 + 156.25) / 16 = 13.77).
  A larger R makes it flatter with a slight point; a smaller one is an overhang. A half ball is
  h = D/2, R = D/2. **Round R up**, never down (20.833 → 20.84): a hair under it is an overhang
  the page rejects.
- **A cove** (a concave groove) into a body of diameter D, `w` wide and `d` deep per side: one arc,
  `[z, D]` to `[z - w, D, -R]`, with **R = ((w/2)² + d²) / (2d)**. Its walls meet the body at
  **asin(w / 2R)**; keep that under the profiler's angle (52°), making the cove shallower or wider
  if not. 12 wide, 2.5 deep on Ø25: R = (36 + 6.25) / 5 = 8.45, walls at 45°. Two mirrored arcs
  only meet smoothly with this same R; a smaller one leaves a ridge at the bottom and steeper walls.
  **A cove is at most half as deep as it is wide** (d ≤ w/2, a half circle at d = w/2): past that the
  formula gives an arc that would curl back in Z, and the page cuts the short arc instead, far
  shallower than you meant. A 1 mm deep cove is at least 2 mm wide (R 1); for a deeper, narrower
  groove, make it square and at least 3 mm wide (the parting blade).
- Prefer arcs to many short straight segments: the page cuts them as real `G2`/`G3` moves.

**Design for the tools** (the page reports anything they can't reach):

- A wall where the diameter **grows** toward the chuck (a shoulder, a flare to a base) can be any
  angle, square included.
- A wall where the diameter **falls** toward the chuck (the underside of a head or a crown) is
  finished by the profiler up to 52°; steeper or square ones are cut with the parting blade, so
  the recess behind them must be at least the blade width (3 mm) long.
- **No sharp V notches** where a falling wall meets a rising one: leave a flat bottom of at least
  1.6 mm (3 mm when the falling wall is steeper than 52°), or a cove of R ≥ 1.
- Keep necks at least 4 mm and about 20% of the largest diameter, and put 0.5–1 mm chamfers on
  outside edges.

**Detail means shape, not point count.** "As detailed as possible" means good proportions, smooth
arcs, a bead or a groove where it reads well: about 8–20 points for a whole part. Don't stack
dozens of tiny features; each one makes the part fragile and harder to cut.

## The bore

`bore` is the hole along the axis, the same way as `profile`: `[z, diameter]` points from the
front face toward the chuck (arcs work the same). Leave it out for a solid part. The page drills
it, bores it and cuts its internal grooves.

- Start at **Z0** (a chamfer at the mouth: `[0, 22], [-1, 20]`), Z never increasing, every
  diameter over 0, and keep **at least 1 mm of wall** (per side) to the outside everywhere.
- **Through bore:** run its last point to the part's back Z (`[-30, 20]` on a part ending at
  `Z-30`). **Blind bore:** end it where the hole's full diameter stops; the drill's point
  (118°, 0.3 × its diameter long) is left past it, so end it at least 0.3 × the drill + 1 mm in
  front of the back.
- Where the bore **narrows toward the chuck** (a counterbore, a bearing seat's shoulder) any wall
  works, square included.
- Where it **widens toward the chuck** (the front wall of an internal groove or a recess) the
  boring bar only follows walls shallower than 32°; steeper or square ones are cut with the
  internal grooving tool, so give the groove at least the tool's width. Internal circlip grooves
  (DIN 472) are square: bore Ø35 → groove Ø37 × 1.6.
- **Internal grooves:** square, at least the grooving tool's width, no deeper per side than its
  `depth` past the bore in front of them, and that bore must be at least its `minBore`.
- A plain drilled hole is the drill's diameter: Ø20 straight through needs only a Ø20 drill
  (plus the grooving tool for a groove in it). Anything else needs a boring bar too, with a drill
  no smaller than the bar's `minBore`.

Tools for a bore, added to the turret after the outside tools:

```json
{ "id": 4, "name": "Drill", "type": "drill", "diameter": 18 },
{ "id": 5, "name": "Boring bar", "type": "boring", "insert": "DCMT 070204", "noseRadius": 0.4, "angle": 55, "approach": 93, "minBore": 16 },
{ "id": 6, "name": "ID groove", "type": "internal-grooving", "width": 1.6, "depth": 3, "minBore": 25 }
```

Pick the **drill** at most the bore's smallest diameter, 1–3 mm under it when there's a boring
bar (Ø18 for a Ø20 bore), a standard size (6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 32 mm).
For a bore under Ø16, use a boring bar with `"minBore"` at most the drill's size (a Ø8 bar for
Ø10 holes, `"minBore": 8`). An optional `reach` on any inside tool is how deep it goes from the
front face; the defaults are: drill 5 × its diameter, boring bar 4 × `minBore`, grooving tool
2.5 × `minBore`.

## The face groove

`faceGroove` is a ring cut **into the front of the part, along Z**, with material left on both
sides: the bowl between a queen's dome and the rim of her crown, a seal groove in a flange face,
the hollow of a cup with a post in the middle. A hole with nothing standing in the middle is the
`bore`, not a face groove.

- Make `profile` the part **with the groove filled in**: in the crown, the dome comes down to the
  rim's height and a flat shoulder runs out to the rim's edge. The groove is then cut into that
  shoulder.
- `faceGroove` is its **bottom**, as `[z, diameter]` points from the **inner wall out to the outer
  wall**: the diameter never falls, Z goes down from the inner wall and back up once (one low
  point, no ridge in the middle). Everything in front of that bottom, between the first and the
  last diameter, is cut away, so the walls run straight to the front from the first and the last
  point. Start and end it at the shoulder's Z.
- **Arcs:** `[z, diameter, R]` makes the segment ending there an arc of radius |R|. The sign says
  which way it bulges, not whether Z goes up or down: **a bowl's round corners are both R < 0**,
  the one going down from the inner wall and the one coming back up to the outer wall (R > 0
  bulges toward the front: a mound in the bottom).
- **Leave room for each round.** A round from a wall to the flat bottom is a quarter circle:
  ΔZ = |R| and **Δdiameter = 2|R|**. A 3 mm deep round to the outer wall at Ø25 starts at Ø19;
  from Ø24 it curls back. A round smaller than the depth goes under a straight wall:
  shoulder at Z-11, bottom at Z-14, R 2, walls at Ø14 and Ø25 →
  `[[-11,14],[-12,14],[-14,18,-2],[-14,21],[-12,25,-2],[-11,25]]`.
- The blade cuts the bottom with its corners, so a V or a round narrower than the blade leaves
  material: give the bottom a flat or a round **at least the blade's width**.
- Keep **at least 1 mm of wall** to the outside and to the bore, the inner wall at least the
  tool's `minDiameter`, and the groove no deeper than its `depth` from the shoulder. The wall to
  the outside counts **all the way down to the groove's bottom**: keep the rim's outside straight
  to 1 mm past the bottom's Z before the part narrows below it.

Tool for it, added to the turret: the programmed point is the inner corner of the blade's tip.

```json
{ "id": 4, "name": "Face groove", "type": "face-grooving", "width": 2, "depth": 8, "minDiameter": 10 }
```

## Tools and cutting data

The page uses the turning tool with the largest nose radius to rough, the one with the most
clearance (largest end cutting edge angle) to finish, and the parting tool for steps and part off.
For V-grooves with both walls steeper than 52°, add a neutral 35° insert, `{"type": "turning",
"insert": "VBMT 160404", "noseRadius": 0.4, "angle": 35, "approach": 72.5}` (walls up to 72°).

Tool fields: `turning` (`noseRadius`, `angle` 20–90 = insert included angle, `approach` 45–110 =
lead angle), `parting` (`width`), `drill` (`diameter`, `pointAngle` default 118), `boring`
(`noseRadius`, `angle`, `approach`, `minBore`), `internal-grooving` (`width`, `depth`, `minBore`),
`face-grooving` (`width`, `depth`, `minDiameter`).
Every tool has a unique integer `id` (it becomes `T0101`, `T0202`…) and a `name`. At most 12 tools.

Speeds, feeds and depth of cut come from the material. Add `cam` only when the user asks for
specific values: `{"depthOfCut": 1.5, "finishAllowance": 0.2, "roughSpeed": 200, "finishSpeed":
260, "partSpeed": 100, "roughFeed": 0.25, "finishFeed": 0.08, "partFeed": 0.06, "maxRpm": 2500,
"drillSpeed": 80, "drillFeed": 0.2, "boreSpeed": 160, "boreFeed": 0.15}` (mm per side, m/min,
mm/rev; any subset).

## Job format (v1)

```json
{
  "version": 1,
  "name": "Chess rook",
  "units": "mm",
  "material": { "name": "6061 aluminum", "density": 2.7 },
  "stock": { "diameter": 45, "length": 150, "stickout": 118, "faceStock": 1 },
  "profile": [[0, 0], [0, 32], [-1, 34], [-14, 34], [-15, 32], [-17, 28], [-22, 24, -20], [-75, 24],
              [-85, 32, -12], [-88, 38], [-92, 40, 4], [-100, 40], [-103, 38]],
  "tools": [
    { "id": 1, "name": "Rougher", "type": "turning", "insert": "CNMG 120408", "noseRadius": 0.8, "angle": 80, "approach": 95 },
    { "id": 2, "name": "Profiler", "type": "turning", "insert": "VNMG 160404", "noseRadius": 0.4, "angle": 35, "approach": 93 },
    { "id": 3, "name": "Parting", "type": "parting", "width": 3 }
  ],
  "assumptions": ["Crenellations are milled: left out, the crown is a plain Ø34 cylinder", "Ø45 6061 bar"]
}
```

Add `"bore": [[z, diameter], …]` for a hole. The JSON must be valid: double quotes, no comments,
no trailing commas.

## Reference proportions

Profiles that pass the simulator; scale them to the request instead of starting from nothing.

- **Rook**, 103 tall, Ø40 base: the example above (crown, cove into the body, cove flaring to the
  base, a bead on the base).
- **Pawn**, 50 tall, Ø30 base, Ø32 bar: `[[0,0],[-7,14,7],[-12,9.8,7],[-13.6,9.8],[-14.6,18],[-16.6,18],[-17.6,12],[-21,12],[-36,20,-40],[-42,26,-8],[-44,30,3],[-49,30],[-50,28]]`
- **Bishop**, 78 tall, Ø32 base, Ø35 bar: `[[0,0],[-2.5,5,2.5],[-4,4,2.5],[-5.6,4],[-6.6,8],[-10,16,8],[-18,12,10],[-20,10],[-21.6,10],[-22.6,18],[-24.6,18],[-25.6,13],[-28,13],[-60,18,-60],[-66,26,-10],[-70,30,4],[-75,32],[-77,32],[-78,30]]`
- **Knob**, 30 long, Ø25, Ø30 bar, an 8 mm dome and a back chamfer: `[[0,0],[-8,25,13.77],[-29,25],[-30,23]]`
- **Knob with a cove** near the back, same 30 mm: `[[0,0],[-8,25,13.77],[-14,25],[-26,25,-8.45],[-29,25],[-30,23]]`
- **File handle**, 101 long, Ø30 POM bar: `[[0,0],[0,20],[-2,24,2],[-10,25,40],[-60,22,-200],[-90,26,200],[-98,26],[-100,22],[-101,22]]`
- **Dumbbell handle**: Ø60 steel, 110 long, Ø30 grip with 45° walls: `[[0,0],[0,50],[-12,50],[-22,30],[-88,30],[-98,50],[-110,50]]`
- **Queen's crown** with the bowl around her dome, Ø28 rim, Ø32 bar, with the face groove tool
  above: profile `[[0,0],[-3,6,3],[-4,6],[-5,4],[-6,4],[-10,12,5],[-10,28],[-11,28],[-24,18,-30]]`
  (the body carries on from there), faceGroove `[[-10,12],[-13.5,19,-3.5],[-13.5,20],[-10,24.5,-4]]`:
  a knob, a dome down to the rim's height at Z-10, and a 3.5 mm bowl around it.
- **Bearing housing**, Ø50 × 30 steel from Ø55 (stickout 45, length 80), a 6202 seat with a
  circlip groove and a Ø20 through bore, with the three bore tools above:
  profile `[[0,0],[0,48],[-1,50],[-29,50],[-30,48]]`,
  bore `[[0,36],[-0.5,35],[-2,35],[-2,37],[-3.6,37],[-3.6,35],[-14.6,35],[-14.6,20],[-30,20]]`

## The reply

1. One sentence describing the part in plain words with its main sizes ("A 103 mm rook: Ø34 crown,
   Ø24 body, Ø40 base").
2. One or two sentences on what you left out or changed (bar, features the lathe can't make).
3. The JSON job in one fenced block.

**Before you send it**, walk the profile once:

- Every wall falling toward the chuck is at most 52°, or has a recess of at least 3 mm behind it.
  A bead, cove or chamfer right after a steep step down needs that recess too.
- No V notches (see the profile rules), and every R from a formula is rounded up.
- With a bore: 1 mm of wall everywhere, each internal groove at least the grooving tool's width
  and within its depth, the drill no bigger than the bore's smallest diameter, and a blind bore
  ending clear of the back by the drill's point.
- `assumptions` and the reply describe the profile you are sending: measure spacing, widths and
  angles from its points ("15 mm apart" says whether it is edge to edge or center to center). A
  cove's depth per side is R − √(R² − (w/2)²); after scaling a part, measure again from the new points.

## When the request changes the last job

A follow-up ("add a groove", "make the dome taller") edits the job you sent last: keep its length,
diameters, bar and tools, and change only what was asked. Fit a new feature into the existing
shape (a cove goes into a straight stretch of the body); make the part longer only when the
request says so or the feature can't fit, and then say so. To make room at the same length, take
it from plain straight stretches (the gap between grooves, a long grip) before shrinking a feature
the user named or sized (a collar, a neck, a thread).

## When the user pastes problems from the simulator

Change the **profile** (or the bar or the tools) the way each problem says, and send the whole
job again, still without `gcode`. Line numbers in a problem refer to the generated program: don't
answer with G-code, fix the shape that caused it.

---

# Hand-written G-code

Only when the user asks for hand-written G-code or a machining strategy the page's generator
doesn't follow. Put the program in the job's `gcode` field, as one string with `\n` between lines,
next to `stock` and `tools` (every `T` in the program must be in `tools`; `profile` and `bore` can
stay, for the page to compare the result against). **Name each operation with a line that is only
a comment**, `(Face)`, `(Rough OD)`, `(Finish profile)`, `(Part off)`, just before it (before its
tool change, if it has one). Don't use comment-only lines for anything else. The page runs the
program in the simulator and the user will paste back anything wrong.

## G-code the simulator runs

`G0 G1 G2 G3` (arcs with `R` or `I`/`K`; `I` is radial, not diametral), `G4 P(ms)`, `G18 G20 G21
G90 G91`, `U`/`W` incremental, `G50 S` (rpm limit), `G96 G97`, `G98`/`G94` (mm/min),
`G99`/`G95` (mm/rev), `T0101`, `M3 M4 M5 M8 M9 M30`, `G28 U0 W0`. Home, where the program starts
and `G28 U0 W0` returns, is X(bar Ø + 50) Z(faceStock + 50). The jaws hold the bar from
Z(faceStock − stickout): keep every move at least 5 mm in front of that.

**No canned cycles** (`G70 G71 G72 G75 G76`): write every pass as explicit `G0`/`G1` moves.
`G41`/`G42` are accepted but **not simulated**: see the nose radius rule below.

## Rules that the simulator checks

1. **Programmed point.** A turning tool is programmed by its imaginary tip (tip direction 3): the
   corner of the square around the nose on the chuck side and toward the axis. Straight turning and
   facing come out exact. **Tapers and arcs do not**. Program each sloped wall with its points
   moved toward the chuck (more negative Z, same X) by the amount in this table; `θ` is the wall's
   angle from the axis. Take the row nearest to the wall's angle.

   | θ | rn 0.4, diameter falls toward the chuck | rn 0.4, diameter grows toward the chuck | rn 0.8, falls | rn 0.8, grows |
   |---|---|---|---|---|
   | 15° | 0.453 | 0.347 | 0.905 | 0.695 |
   | 30° | 0.507 | 0.293 | 1.014 | 0.586 |
   | 45° | 0.566 | 0.234 | 1.131 | 0.469 |
   | 60° | 0.631 | 0.169 | 1.262 | 0.338 |
   | 71° | 0.685 | 0.115 | 1.371 | 0.229 |
   | 75° | 0.707 | 0.093 | 1.414 | 0.186 |

   "Falls toward the chuck": the front wall of a groove, a step down to a smaller diameter.
   "Grows toward the chuck": the back wall of a groove, a chamfer on the front corner, a taper up
   to a shoulder. Other nose radii: falls `rn·(1 + tan(θ/2))`, grows `rn·(1 − tan(θ/2))`. Arcs:
   compensate their end points as the wall they meet, or keep them shallow.
2. **Rapids never touch the material.** After a pass, retract in X first to an absolute diameter
   above everything still uncut (`G0 X` = bar diameter + 2 or more), then move Z, then come down in
   X. After facing to the center, `G0 U2` only lifts the tool to Ø2: the next `G0 Z` would run
   through the middle of the bar. Never send a diagonal `G0` across the part.
3. **The insert must fit.** A turning tool removes material on its +Z side up to its end cutting
   edge angle, `180 − approach − angle` degrees (CNMG 95°/80° → 5°, VNMG 93°/35° → 52°). It can
   only go down a wall that faces the chuck if that wall is shallower than this angle. Use a VNMG
   (or a narrower insert) for recesses with 45° walls; a CNMG can't go into them. Walls steeper
   than the insert allows need a grooving tool. For a **V-groove** (both walls steep), use a
   **neutral** insert: `approach = (180 − angle) / 2` (VBMT 35° → 72.5°, end edge 72.5°), so it
   can follow both walls: walls no steeper than 72° from the axis and a bottom about 5 mm wide or
   more (the reference pulley: 71° walls, 5.4 mm bottom). Grooves narrower or steeper than that
   can't be turned: make them wider, or cut them with a parting/grooving tool.
4. **Parting tool:** the programmed point is the chuck-side corner, and the blade is `width` wide
   toward +Z. To part off at the back of a part ending at `Z-L`, cut at `Z-(L + width)`.
5. **Speeds.** Use `G96` (m/min) with a `G50` limit for turning, mm/rev feeds (`G99`). Typical for
   steel: roughing 180–220 m/min, 0.2–0.3 mm/rev, 1.5–3 mm depth; finishing 220–280 m/min,
   0.08–0.15 mm/rev, 0.2–0.5 mm left; parting 80–120 m/min, 0.04–0.08 mm/rev.
6. **Remove material in passes.** A turning tool cuts along Z: rough each diameter with
   successive `G1 Z` passes of the depth of cut, from the bar's diameter down. Plunging straight
   down in X (`G1 X`) with a turning tool only cuts a groove as wide as its nose. Grooves narrower
   than the insert need a parting or grooving tool, stepped across in Z.
7. **Every `T` in the program is in `tools`.** End with `M30`.
8. **Inside tools** (`drill`, `boring`, `internal-grooving`) cut outward from the axis side. A
   drill is programmed by its point at `X0`: peck with `G1 Z` moves at a fixed rpm (`G97 S… M3`),
   retracting with `G0 Z1` between pecks; its full diameter is 0.3 × D behind the point. A boring
   bar is programmed by its imaginary tip like a turning tool, mirrored: `G1 X` is the bore
   diameter; rough with `G1 Z` passes, each one depth of cut larger, `G0` back toward the axis
   (`G0 X(drilled − 1)`) before every `G0 Z` out of the hole. The internal grooving tool's point is
   its chuck-side corner, like the parting tool: enter at the bore diameter, `G1 X(groove)`, back
   to `G0 X(bore − 1)`, then out along Z. Leave every inside tool with `G0 Z2` in front of the face
   before `G28 U0 W0`.
   The face grooving tool plunges along Z into the front face; its point is the inner corner of
   the blade's tip, so `X` is the groove's inner wall diameter and the blade cuts out to
   `X + 2 × width`. Plunge with `G1 Z`, back out with `G0` in front of the face, step `X` out by less
   than twice the width, and leave with `G0 Z2` before `G28 U0 W0`.

## Patterns that pass the simulator

Build the program from these blocks, in this order. `D` is the bar diameter, `rn` the nose radius.

1. **Header:** `G21 G18 G40 G99`, `G50 S2500` (S3000 for aluminum), then for each tool:
   `G28 U0 W0` (not before the first), `T0n0n`, `G96 S… M3` (and `M8` once).
2. **Face** with the rougher: `G0 X(D+4) Z0`, `G1 X(−2·rn) F0.2`, `G0 Z2` before any X move.
3. **Rough OD** with the rougher, one `G1 Z` pass per depth of cut:
   `G0 X(d)` · `G1 Z(end) F0.25` · `G0 U2` · `G0 Z2`. `G0 U2` is safe here only because the way
   back runs over the diameter the pass just cut. Stop each pass 0.25 mm in front of a shoulder
   (`Z−14.75` for a shoulder at `Z−15`) and 0.5 mm over the finished diameter. Turn the outer
   diameter first, over the whole length down to the part-off point.
4. **Recesses and grooves** (sloped walls) with the profiler, in trapezoid passes, each
   `depthOfCut` deeper, every one inside the walls offset by the 0.25 mm finish allowance:
   `G0 Z(z1)` · `G0 X(start)` · `G1 X(d) Z(z2)` down the near wall · `G1 Z(z3)` along the bottom ·
   `G1 X(start) Z(z4)` up the far wall · `G0 X(clear)`. `clear` is above the material still left
   (dumbbell: X54 on a Ø60 bar; pulley: X94 on Ø95). Several grooves: finish all passes of one,
   lift to `clear`, then move Z to the next.
5. **Steps down toward the chuck** (a smaller diameter behind a larger one: a rear journal, a neck
   before the part-off): the wall faces the chuck, and a square one (90°) is steeper than any
   turning insert allows (rule 3), so **no turning tool goes down it or into the step behind it**.
   Rough the larger diameter over the whole length; the finish contour (6) stops at the wall and
   lifts (`G1 Z(wall)`, `G0 X(D+4)`). After the finish, cut the step with the parting tool,
   plunging side by side: `G0 X(D+4) Z(wall − width)` · `G1 X(d) F0.06` · `G0 X(D+4)`, each next
   plunge at most `width` further toward the chuck, the last one at the part end. The parting
   tool's bottom is flat, so the step comes out at size. (Shaft Ø40 to `Z−85`, then Ø25 to `Z−100`,
   3 mm blade: plunges at `Z−88, −90.5, −93, −95.5, −98, −100`, then part off at `Z−103`.) Only if
   the user allows it, a chamfer shallower than the profiler's end edge angle can replace the
   square wall and be finished in the contour instead.
6. **Finish** with the profiler in one contour: raise the speed (`G96 S260`), start in front of the
   face (`G0 Z1`, `G0 X(first diameter)`), follow the whole profile with `G1 … F0.1`, run past the
   part end, `G0 X(D+2)`; with a step down toward the chuck, stop at its wall instead (5). Shift
   every sloped wall's points toward the chuck by the table in rule 1 (dumbbell, `rn` 0.4, 45°
   walls: front wall 0.566, back wall 0.234).
7. **Part off:** `G28 U0 W0`, parting tool, `G96 S100–150 M3`, `G0 X(D+4) Z−(L + width)`,
   `G1 X0 F0.06`, `G0 X(D+4)`. Then `M9`, `G28 U0 W0`, `M5`, `M30`.

Reference parts that pass: a dumbbell handle (Ø60 1045, 110 long, grip Ø30 with 45° walls, CNMG +
VNMG 93°, stickout 120) and an A-section V-belt pulley (Ø95 6061, 35 long, one groove 13 mm wide
at the rim, 11 deep, 38° included, 5.4 mm bottom, CNMG + neutral VBMT 72.5°, stickout 55). Size
new grooves like these: wide and open enough for the insert, rather than narrow and deep.
