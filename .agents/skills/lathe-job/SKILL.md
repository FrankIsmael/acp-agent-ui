---
name: lathe-job
description: Design a turned part (bar stock, tools and the target profile, with arcs) as a `lathe-job` JSON block for the /lathe simulator, which writes the G-code from the profile. Use for prompts tagged [skill: lathe-job], or when asked to program a turned part for the lathe simulator.
effort: low
---

# Lathe job for the simulator

You design the part; the page writes the G-code. Turn the request into **one** job for a 2-axis CNC
lathe and reply with a short explanation plus **exactly one** fenced block tagged `lathe-job`
containing the JSON below. Don't use tools or files: the whole answer is text. Don't ask
questions: pick sensible defaults and list them under `assumptions`. Reply in the user's language,
but keep the JSON keys in English.

**Leave `gcode` out.** The page generates the program from `profile`, `stock` and `tools` (facing,
roughing, nose radius compensation, finishing with real arcs, steps the inserts can't reach, part
off) and checks it in the simulator. Your work is the shape: get the profile right and stop. Write
G-code only when the request asks for hand-written G-code or for a specific machining strategy;
then read `gcode.md` in this skill's folder first.

## What the simulator can't make

It only turns the outside of the bar. When the request asks for any of these, make the outside
shape without them, say so in one sentence, and add an entry to `assumptions`:

- **Threads** of any kind: turn the plain major diameter for the thread's length.
- **Holes, bores, drilling**, anything inside the part.
- **Knurling, flats, keyways, slots, cross holes** or anything milled (a rook's crenellations, a
  bishop's mitre cut, a knight's head): leave them out, or hint at them with a groove.
- **A part longer than the bar allows**: as long as it fits, or a shorter version of it.

## Coordinates

- Millimeters. **X is a diameter.** `Z0` is the finished front face; negative Z goes toward the chuck.
- The front of the part is the end away from the chuck. For a chess piece or a knob, put the
  **top at Z0** and the base toward the chuck, where it is parted off.
- The page shows the chuck on the **left**: "left", "back" or "base" is toward the chuck (more
  negative Z, near where it is parted off); "right", "front" or "top" is toward Z0.

## The bar

- Use the loaded bar (`## The lathe right now`) when the part fits it and its largest diameter is
  at most 6 mm under the bar's. Otherwise pick a standard bar 2–5 mm over the largest diameter (10,
  12, 16, 20, 25, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100 mm) and say so. A Ø12 pin
  doesn't come from a Ø60 bar: if you leave the bar too big, the page swaps it for you.
- `stickout` = part length + `faceStock` (1) + parting width (3) + 10; `length` = `stickout` + 30
  or more. `stickout` can never be more than `length`.
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
  h = D/2, R = D/2.
- **A cove** (a concave groove) into a body of diameter D, `w` wide and `d` deep per side: one arc,
  `[z, D]` to `[z - w, D, -R]`, with **R = ((w/2)² + d²) / (2d)**. Its walls meet the body at
  **asin(w / 2R)**; keep that under the profiler's angle in the brief (make the cove shallower or
  wider if not). 12 wide, 2.5 deep on Ø25: R = (36 + 6.25) / 5 = 8.45, walls at 45°. Two mirrored
  arcs only meet smoothly with this same R; a smaller one leaves a ridge at the bottom and steeper walls.
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
260, "partSpeed": 100, "roughFeed": 0.25, "finishFeed": 0.08, "partFeed": 0.06, "maxRpm": 2500}`
(mm per side, m/min, mm/rev; any subset).

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

## The reply

1. One sentence describing the part in plain words with its main sizes ("A 103 mm rook: Ø34 crown,
   Ø24 body, Ø40 base").
2. One or two sentences on what you left out or changed (bar, features the lathe can't make).
3. The `lathe-job` block.

## When the request changes the last job

A follow-up ("add a groove", "make the dome taller") edits the job you sent last: keep its length,
diameters, bar and tools, and change only what was asked. Fit a new feature into the existing
shape (a cove goes into a straight stretch of the body); make the part longer only when the
request says so or the feature can't fit, and then say so.

## When the page sends problems back

Change the **profile** (or the bar or the tools) the way each problem says, and send the whole
job again, still without `gcode`. Line numbers in a problem refer to the generated program: don't
answer with G-code, fix the shape that caused it.
