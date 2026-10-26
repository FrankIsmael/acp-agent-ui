# Hand-written G-code for the simulator

Read this only when the request asks for hand-written G-code or a machining strategy the page's
generator doesn't follow. Otherwise leave `gcode` out of the job: the page writes it.

When you do write it: put it in `gcode` as one string with `\n` between lines, and **name each
operation with a line that is only a comment**, `(Face)`, `(Rough OD)`, `(Finish profile)`,
`(Part off)`, just before it (before its tool change, if it has one). Don't use comment-only lines
for anything else. Write the program once from the patterns below, without re-checking it move by
move: the page runs it in the simulator and sends back anything wrong.

## G-code the simulator runs

`G0 G1 G2 G3` (arcs with `R` or `I`/`K`; `I` is radial, not diametral), `G4 P(ms)`, `G18 G20 G21
G90 G91`, `U`/`W` incremental, `G50 S` (rpm limit), `G96 G97`, `G98`/`G94` (mm/min),
`G99`/`G95` (mm/rev), `T0101`, `M3 M4 M5 M8 M9 M30`, `G28 U0 W0`.

**No canned cycles** (`G70 G71 G72 G75 G76`): write every pass as explicit `G0`/`G1` moves.
`G41`/`G42` are accepted but **not simulated**: see the nose radius rule below.

## Rules that the simulator checks

1. **Programmed point.** A turning tool is programmed by its imaginary tip (tip direction 3): the
   corner of the square around the nose on the chuck side and toward the axis. Straight turning and
   facing come out exact. **Tapers and arcs do not**. Program each sloped wall with its points
   moved toward the chuck (more negative Z, same X) by the amount in this table; `θ` is the wall's
   angle from the axis. Don't work it out: take the row nearest to the wall's angle.

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
   to a shoulder. Other nose
   radii: falls `rn·(1 + tan(θ/2))`, grows `rn·(1 − tan(θ/2))`. Arcs: compensate their end points
   as the wall they meet, or keep them shallow.
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
   can follow both walls. Design the groove so the insert fits: with a neutral 35° insert, walls no
   steeper than 72° from the axis and a bottom about 5 mm wide or more (the reference pulley: 71°
   walls, 5.4 mm bottom). Grooves narrower or
   steeper than that can't be turned: make them wider, or cut them with a parting/grooving tool.
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
   the request allows it, a chamfer shallower than the profiler's end edge angle can replace the
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
