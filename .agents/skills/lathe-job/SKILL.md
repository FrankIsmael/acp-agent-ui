---
name: lathe-job
description: Design a turned part (bar stock, tools, the target profile with arcs, and an optional bore with internal grooves) as a `lathe-job` JSON block for the /lathe simulator, which writes the G-code from the profile. Use for prompts tagged [skill: lathe-job], or when asked to program a turned part for the lathe simulator.
effort: low
---

# Lathe job for the simulator

You design the part; the page writes the G-code. Turn the request into **one** job for a 2-axis CNC
lathe and reply with a short explanation plus **exactly one** fenced block tagged `lathe-job`
containing the JSON below. Don't use tools or files: the whole answer is text. Don't ask
questions: pick sensible defaults and list them under `assumptions`. Reply in the user's language,
but keep the JSON keys in English.

**Leave `gcode` out.** The page generates the program from `profile`, `bore`, `faceGroove`, `stock` and `tools`
(facing, roughing, nose radius compensation, finishing with real arcs, steps the inserts can't
reach, drilling, boring, internal grooves, face grooves, part off) and checks it in the simulator. Your work is the shape: get the profile right and stop. Write
G-code only when the request asks for hand-written G-code or for a specific machining strategy;
then read `gcode.md` in this skill's folder first.

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
- **A part bigger than the machine takes** (see **The bar**): as big as it allows, or a smaller
  version of it.

## Coordinates

- Millimeters. **X is a diameter.** `Z0` is the finished front face; negative Z goes toward the chuck.
- The front of the part is the end away from the chuck. For a chess piece or a knob, put the
  **top at Z0** and the base toward the chuck, where it is parted off.
- The page shows the chuck on the **left**: "left", "back" or "base" is toward the chuck (more
  negative Z, near where it is parted off); "right", "front" or "top" is toward Z0.

## The bar

- Use the loaded bar (`## The lathe right now`) when the part fits it and its largest diameter is
  at most 6 mm under the bar's. Otherwise pick a standard bar 2–5 mm over the largest diameter (10,
  12, 16, 20, 25, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150,
  160 mm) and say so. A Ø12 pin doesn't come from a Ø60 bar: if you leave the bar too big, the
  page swaps it for you.
- **The machine's limits** (also in the brief): bars up to **Ø160** (what the chuck grips), at
  most **400 mm out of the jaws**, at least 10 mm in them. A bar up to Ø52 goes through the spindle
  and can be up to 1000 mm long; **a thicker bar only fits 40 mm into the chuck**, so its `length`
  is at most `stickout` + 40. A part over Ø158 doesn't fit: make it Ø158 or less and say so.
- `stickout` = part length + `faceStock` (1) + parting width (3) + 10; `length` = `stickout` + 30
  (`stickout` + 30 to 40 for a bar over Ø52). `stickout` can never be more than `length`.
- The brief's "longest part" is for the loaded bar **as it sits**, not a limit of the machine. A
  longer part gets a longer `stickout` (and `length`) from the formula above, on the loaded bar or
  a new one. The simulator has no tailstock: keep `stickout` at most 3 × the bar's diameter, and
  only shorten the part when a bar that thick would be absurd for it, saying so.
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
  **asin(w / 2R)**; keep that under the profiler's angle in the brief (make the cove shallower or
  wider if not). 12 wide, 2.5 deep on Ø25: R = (36 + 6.25) / 5 = 8.45, walls at 45°. Two mirrored
  arcs only meet smoothly with this same R; a smaller one leaves a ridge at the bottom and steeper walls.
  **A cove is at most half as deep as it is wide** (d ≤ w/2, a half circle at d = w/2): past that the
  formula gives an arc that would curl back in Z, and the page cuts the short arc instead, far
  shallower than you meant. A 1 mm deep cove is at least 2 mm wide (R 1); for a deeper, narrower
  groove, make it square and at least 3 mm wide (the parting blade).
- Prefer arcs to many short straight segments: the page cuts them as real `G2`/`G3` moves.

**Design for the tools** (the page reports anything they can't reach):

- A wall where the diameter **grows** toward the chuck (a shoulder, a flare to a base) can be any
  angle, square included.
- A wall where the diameter **falls** toward the chuck (the underside of a head or a crown) is
  finished by the profiler up to its angle in the brief (52° for the usual VNMG); steeper or square
  ones are cut with the parting blade, so the recess behind them must be at least the blade width
  (3 mm) long.
- **No sharp V notches** where a falling wall meets a rising one: leave a flat bottom of at least
  1.6 mm (3 mm when the falling wall is steeper than the profiler allows), or a cove of R ≥ 1.
- Keep necks at least 4 mm and about 20% of the largest diameter, and put 0.5–1 mm chamfers on
  outside edges.

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
  boring bar only follows walls shallower than its angle in the brief (32° for a 55° DCMT);
  steeper or square ones are cut with the internal grooving tool, so give the groove at least the
  tool's width. Internal circlip grooves (DIN 472) are square: bore Ø35 → groove Ø37 × 1.6.
- **Internal grooves:** square, at least the grooving tool's width, no deeper per side than its
  `depth` past the bore in front of them, and that bore must be at least its `minBore`.
- A plain drilled hole is the drill's diameter: Ø20 straight through needs only a Ø20 drill
  (plus the grooving tool for a groove in it). Anything else needs a boring bar too, with a drill
  no smaller than the bar's `minBore`.

Tools for a bore, added to the turret (ids after the outside tools):

```json
{ "id": 4, "name": "Drill", "type": "drill", "diameter": 18 },
{ "id": 5, "name": "Boring bar", "type": "boring", "insert": "DCMT 070204", "noseRadius": 0.4, "angle": 55, "approach": 93, "minBore": 16 },
{ "id": 6, "name": "ID groove", "type": "internal-grooving", "width": 1.6, "depth": 3, "minBore": 25 }
```

Pick the **drill** at most the bore's smallest diameter, 1–3 mm under it when there's a boring
bar (Ø18 for a Ø20 bore), a standard size (6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 32 mm).
For a bore under Ø16, use a boring bar with `"minBore"` at most the drill's size (a Ø8 bar for
Ø10 holes, `"minBore": 8`). An optional `reach` on any inside tool is how deep it goes from the
front face; the defaults (drill 5 × its diameter, boring bar 4 × `minBore`, grooving tool
2.5 × `minBore`) are in the brief.

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
- **Arcs:** `[z, diameter, R]` makes the segment ending there an arc of radius |R|; **R < 0 dips
  toward the chuck** (a hollow, the usual one), R > 0 rises toward the front. A wall that is vertical
  at the top and flat at the bottom is a quarter circle: Δdiameter = 2|R| and ΔZ = |R|. A larger
  |R| than the points allow is flatter; a smaller one curls back (the page says which |R| works).
- The blade cuts the bottom with its corners, so a V or a round narrower than the blade leaves
  material: give the bottom a flat or a round **at least the blade's width**.
- Keep **at least 1 mm of wall** to the outside and to the bore, the inner wall at least the
  tool's `minDiameter`, and the groove no deeper than its `depth` from the shoulder.

Tool for it, added to the turret: the programmed point is the inner corner of the blade's tip.

```json
{ "id": 4, "name": "Face groove", "type": "face-grooving", "width": 2, "depth": 8, "minDiameter": 10 }
```

**Detail means shape, not point count.** "As detailed as possible" means good proportions, smooth
arcs, a bead or a groove where it reads well: about 8–20 points for a whole part. Don't stack
dozens of tiny features; each one makes the part fragile and harder to cut.

## Tools and cutting data

Keep the turret in the brief unless the part needs another insert. The page uses the turning tool
with the largest nose radius to rough, the one with the most clearance (largest "shallower than"
angle) to finish, and the parting tool for steps and part off. For V-grooves with both walls
steeper than 52°, use a neutral 35° insert, `{"insert": "VBMT 160404", "noseRadius": 0.4, "angle":
35, "approach": 72.5}` (walls up to 72°).

Speeds, feeds and depth of cut come from the material. Add `cam` only when the request asks for
specific values: `{"depthOfCut": 1.5, "finishAllowance": 0.2, "roughSpeed": 200, "finishSpeed":
260, "partSpeed": 100, "roughFeed": 0.25, "finishFeed": 0.08, "partFeed": 0.06, "maxRpm": 2500,
"drillSpeed": 80, "drillFeed": 0.2, "boreSpeed": 160, "boreFeed": 0.15}` (mm per side, m/min,
mm/rev; any subset).

## Job format (v1)

```lathe-job
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

The JSON must be valid: double quotes, no comments, no trailing commas.

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
3. The `lathe-job` block.

**Before you send it**, walk the profile once:

- Every wall falling toward the chuck is at most the profiler's angle, or has a recess of at least
  3 mm behind it. A bead, cove or chamfer right after a steep step down needs that recess too.
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

## When the page sends problems back

Change the **profile** (or the bar or the tools) the way each problem says, and send the whole
job again, still without `gcode`. Line numbers in a problem refer to the generated program: don't
answer with G-code, fix the shape that caused it.
