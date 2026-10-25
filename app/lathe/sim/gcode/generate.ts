/**
 * Writes the G-code for a job from its profile, so the agent only has to design the part. It
 * works on the simulator's own model: the same stock grid, tool footprints and `sweep`, so every
 * move is checked against the material it leaves and the program passes `checkJob` by
 * construction instead of by the agent's arithmetic.
 *
 * Operations, each one only when it has something to cut:
 * 1. Face, with the rougher.
 * 2. Rough OD: horizontal passes, one depth of cut apart, down to the rougher's envelope of the
 *    profile plus the finish allowance.
 * 3. Rest rough: the same with the finishing tool, where it reaches deeper (recesses, grooves).
 * 4. Finish profile: one contour along the finishing tool's envelope, fitted to G1 lines and G2/G3
 *    arcs.
 * 5. Cut steps: what no turning tool can reach (walls facing the chuck steeper than its insert
 *    allows), plunged and then contoured with the parting tool.
 * 6. With a bore: drill (pecking), rough bore and finish bore with the boring bar, then internal
 *    grooves, what the bar can't reach, with the internal grooving tool, the way 2–5 do outside.
 * 7. Part off.
 *
 * An envelope is the lowest radius the tool's programmed point can be at, at each z, without its
 * footprint cutting into the target: max over the footprint of (target − edge height). Following
 * it is nose radius compensation and insert clearance in one, for any profile.
 *
 * Inside tools work in a mirrored radius, R − r (R the bar's): there the hole's wall is a surface
 * with the material under it and the tool above, as outside, so the same passes cut the bore.
 * Positions are kept in the current tool's space and only turned into X when they are written.
 */
import type { Job, Tool } from '../job-schema.ts';
import { profileSegments, segmentsRangeAt, type Profile } from '../profile.ts';
import { freshBore, freshProfile, stockShape, sweep, sweepInner } from '../stock.ts';
import { endEdgeAngle, footprint, isInside, toolReach, type Footprint } from '../tool-shapes.ts';

export class GenerateError extends Error {}

type Turning = Extract<Tool, { type: 'turning' }>;
type Parting = Extract<Tool, { type: 'parting' }>;
type Drill = Extract<Tool, { type: 'drill' }>;
type Boring = Extract<Tool, { type: 'boring' }>;
type Grooving = Extract<Tool, { type: 'internal-grooving' }>;

export type Cam = Partial<{
  depthOfCut: number; // mm per side, roughing
  finishAllowance: number; // mm per side left for the finish
  roughSpeed: number; finishSpeed: number; partSpeed: number; // m/min
  roughFeed: number; finishFeed: number; partFeed: number; // mm/rev
  maxRpm: number;
  roughTool: number; finishTool: number; partTool: number;
  drillSpeed: number; drillFeed: number; // m/min, mm/rev (for a Ø10 drill; it scales with the size)
  boreSpeed: number; boreFeed: number;
  drillTool: number; boreTool: number; grooveTool: number;
}>;

type GenerateInput = Pick<Job, 'name' | 'material' | 'stock' | 'tools'> & { profile: Profile; bore?: Profile; cam?: Cam };

/** Starting cutting data per material family: speeds in m/min, feeds in mm/rev, depth per side. */
const CUTTING = {
  steel: { roughSpeed: 200, roughFeed: 0.25, depthOfCut: 2, finishSpeed: 260, finishFeed: 0.1, partSpeed: 100, partFeed: 0.06, maxRpm: 2500, drillSpeed: 80, drillFeed: 0.15, boreSpeed: 160, boreFeed: 0.15 },
  stainless: { roughSpeed: 150, roughFeed: 0.2, depthOfCut: 1.5, finishSpeed: 200, finishFeed: 0.08, partSpeed: 80, partFeed: 0.05, maxRpm: 2500, drillSpeed: 50, drillFeed: 0.1, boreSpeed: 120, boreFeed: 0.12 },
  aluminum: { roughSpeed: 300, roughFeed: 0.25, depthOfCut: 2.5, finishSpeed: 400, finishFeed: 0.1, partSpeed: 150, partFeed: 0.08, maxRpm: 3000, drillSpeed: 150, drillFeed: 0.2, boreSpeed: 250, boreFeed: 0.15 },
  brass: { roughSpeed: 250, roughFeed: 0.2, depthOfCut: 2, finishSpeed: 300, finishFeed: 0.08, partSpeed: 120, partFeed: 0.05, maxRpm: 3000, drillSpeed: 100, drillFeed: 0.15, boreSpeed: 200, boreFeed: 0.12 },
  plastic: { roughSpeed: 250, roughFeed: 0.25, depthOfCut: 2.5, finishSpeed: 300, finishFeed: 0.12, partSpeed: 120, partFeed: 0.08, maxRpm: 3000, drillSpeed: 100, drillFeed: 0.2, boreSpeed: 200, boreFeed: 0.15 },
};

export function materialFamily({ name, density }: { name: string; density: number }): keyof typeof CUTTING {
  if (/stainless|inox|\b30[34]\b|\b316\b/i.test(name)) return 'stainless';
  if (/alum|\b(6061|6082|7075|2024)\b/i.test(name)) return 'aluminum';
  if (/brass|bronze|copper|lat[oó]n|bronce|cobre/i.test(name)) return 'brass';
  if (/pom|delrin|acetal|nylon|plastic|pl[aá]stico|ptfe|hdpe|abs/i.test(name) || density < 2) return 'plastic';
  if (density < 3.5) return 'aluminum';
  if (density > 8.2) return 'brass';
  return 'steel';
}

const MARGIN = 0.5; // mm per side kept between a rapid and the material
const MATERIAL_MIN = 0.1; // thinner than this is not worth a roughing pass
const GAP_MM = 2; // shorter gaps without material don't split a pass
const MIN_PASS_MM = 0.3; // shorter slivers are left to the next tool
const STEEP = 0.25; // radius change per grid step above which a contour goes square, axis by axis
const TOL_BELOW = 0.003; // a fitted line or arc may dip this much under the safe path…
const TOL_ABOVE = 0.02; // …and rise this much over it
const LEFTOVER_MM = 0.25; // what the finish leaves over the profile that the parting tool goes after (the
// nose radius leaves less in inside corners, a fillet every turned part has)

const fmt = (v: number) => String(Number(v.toFixed(3)));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt2 = (v: number) => String(Number(v.toFixed(2))); // for messages

export function generateGcode(job: GenerateInput): string {
  const { stock, profile, tools } = job;
  const bore = job.bore ?? [];
  const cutting = CUTTING[materialFamily(job.material)];
  const cam = { ...cutting, finishAllowance: 0.25, ...stripUndefined(job.cam ?? {}) };
  if (profile.length < 2) throw new GenerateError('profile: needs at least two [z, diameter] points to generate the G-code');

  const turning = tools.filter((t): t is Turning => t.type === 'turning');
  const pick = <T extends Tool>(id: number | undefined, kind: T['type']): T | undefined => {
    if (id === undefined) return undefined;
    const tool = tools.find((t) => t.id === id);
    if (!tool || tool.type !== kind) throw new GenerateError(`cam: tool ${id} is not a ${kind} tool in tools`);
    return tool as T;
  };
  const rougher = pick<Turning>(cam.roughTool, 'turning') ?? [...turning].sort((a, b) => b.noseRadius - a.noseRadius || endEdgeAngle(a) - endEdgeAngle(b))[0];
  const finisher = pick<Turning>(cam.finishTool, 'turning') ?? [...turning].sort((a, b) => endEdgeAngle(b) - endEdgeAngle(a) || a.noseRadius - b.noseRadius)[0];
  const parting = pick<Parting>(cam.partTool, 'parting') ?? tools.find((t): t is Parting => t.type === 'parting');
  if (!rougher || !finisher) throw new GenerateError('tools: add a turning tool to generate the G-code');
  const drills = tools.filter((t): t is Drill => t.type === 'drill');
  const borer = pick<Boring>(cam.boreTool, 'boring') ?? tools.filter((t): t is Boring => t.type === 'boring').sort((a, b) => a.minBore - b.minBore)[0];
  const groover = pick<Grooving>(cam.grooveTool, 'internal-grooving') ?? tools.find((t): t is Grooving => t.type === 'internal-grooving');

  // --- The model ---------------------------------------------------------------------------
  const shape = stockShape(stock);
  const { step, n, radius: R } = shape;
  const zAt = (i: number) => shape.zFront - i * step;
  const idx = (z: number) => Math.min(n - 1, Math.max(0, Math.round((shape.zFront - z) / step)));
  const home = { x: stock.diameter + 50, z: stock.faceStock + 50 };

  const zLast = Math.min(...profile.map(([z]) => z));
  const lastR = profile[profile.length - 1][1] / 2;
  const width = parting?.width ?? 0;
  const jawZ = stock.faceStock - stock.stickout;
  const iFace = idx(0);
  const iLast = idx(zLast);
  const iZone = idx(Math.max(zLast - (parting ? width + 1 : 0), jawZ + 5)); // roughing runs to here

  // The target radius on the grid. In front of the face there's nothing to keep; between the part
  // and the end of the zone the last diameter carries on, so the part-off has less to cut; behind
  // the zone the bar stays as it is.
  const segments = profileSegments(profile);
  const target = new Float64Array(n), targetHi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = zAt(i);
    if (z > 1e-9) target[i] = targetHi[i] = -1e9;
    else if (i <= iLast) {
      const { lo, hi } = segmentsRangeAt(segments, z);
      target[i] = Number.isNaN(lo) ? lastR : lo;
      targetHi[i] = Number.isNaN(hi) ? lastR : hi;
    } else target[i] = targetHi[i] = i <= iZone ? lastR : -1e9; // behind the zone nothing is programmed
  }

  const fps = new Map<number, Footprint>(tools.map((t) => [t.id, footprint(t, step)]));
  const envelope = (fp: Footprint, t: Float64Array) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = -1e9;
      for (let k = 0; k < fp.dr.length && k <= i; k++) m = Math.max(m, t[i - k] - fp.dr[k]);
      out[i] = Math.max(0, m);
    }
    return out;
  };
  // The target grown by `a` in every direction: the finish allowance, on walls as well as diameters.
  const grow = (t: Float64Array, a: number) => {
    const out = new Float64Array(n), k = Math.round(a / step);
    for (let i = 0; i < n; i++) {
      let m = -1e9;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) m = Math.max(m, t[j]);
      out[i] = m + a;
    }
    return out;
  };

  const stockR = freshProfile(shape);
  const hole = freshBore(shape); // the hole's radius, as the simulator keeps it
  const holeS = new Float64Array(n); // the same in an inside tool's space; no material, -1e9
  let S: Float32Array | Float64Array = stockR; // the material the current tool sees, in its space
  let inside = false;
  const D = stock.diameter;
  const real = (x: number) => (inside ? D - x : x); // the tool's space to X as written, and back
  const syncHole = (from: number, to: number) => {
    for (let i = Math.max(0, from); i <= Math.min(n - 1, to); i++) holeS[i] = stockR[i] > hole[i] ? R - hole[i] : -1e9;
  };
  let fp = fps.get(rougher.id)!;
  const cut = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    if (!inside) return void sweep(stockR, shape, fp, a, b);
    sweepInner(hole, stockR, shape, fp, { x: D - a.x, z: a.z }, { x: D - b.x, z: b.z });
    syncHole(Math.min(idx(a.z), idx(b.z)) - fp.dr.length, Math.max(idx(a.z), idx(b.z)));
  };

  // --- Output ------------------------------------------------------------------------------
  const lines: string[] = ['%', `O1000 (${job.name.replace(/[()]/g, '').toUpperCase().slice(0, 40)})`, 'G21 G18 G40 G99', `G50 S${Math.round(cam.maxRpm)}`];
  let pos = { ...home };
  let tool: Tool | undefined;
  let speed = 0;
  let lastF: number | undefined;
  let coolant = false;

  // G28 goes home diagonally: clear the bar first, or come out of the hole along Z.
  const retreat = () => {
    if (inside) lift(stock.faceStock + 2);
    else rapid(Math.max(pos.x, stock.diameter + 4));
  };

  // `rpm`: S is a fixed spindle speed (G97), for the drill at the center; otherwise m/min (G96).
  const section = (name: string, next: Tool, s: number, rpm = false) => {
    lines.push(`(${name})`);
    const mode = rpm ? 'G97' : 'G96';
    if (next !== tool) {
      if (tool) {
        retreat();
        lines.push('G28 U0 W0');
      }
      inside = isInside(next);
      S = inside ? holeS : stockR;
      if (inside) syncHole(0, n - 1);
      pos = { x: real(home.x), z: home.z };
      lines.push(`T${String(next.id).padStart(2, '0')}${String(next.id).padStart(2, '0')}`);
      lines.push(`${mode} S${Math.round(s)} M3`);
      if (!coolant) lines.push('M8');
      coolant = true;
      tool = next;
      fp = fps.get(next.id)!;
      lastF = undefined;
    } else if (s !== speed) lines.push(`${mode} S${Math.round(s)}`);
    speed = s;
  };

  const move = (g: 'G0' | 'G1', x: number | undefined, z: number | undefined, f?: number) => {
    const to = { x: x === undefined ? pos.x : real(round3(real(x))), z: z === undefined ? pos.z : round3(z) };
    if (to.x === pos.x && to.z === pos.z) return;
    let line = g;
    if (to.x !== pos.x) line += ` X${fmt(real(to.x))}`;
    if (to.z !== pos.z) line += ` Z${fmt(to.z)}`;
    if (g === 'G1' && f !== undefined && f !== lastF) {
      line += ` F${fmt(f)}`;
      lastF = f;
    }
    lines.push(line);
    cut(pos, to);
    pos = to;
  };
  const rapid = (x?: number, z?: number) => move('G0', x, z);
  const feed = (f: number, x?: number, z?: number) => move('G1', x, z, f);

  const arcTo = (f: number, end: { z: number; r: number }, arc: { cu: number; cv: number; radius: number; ccw: boolean }) => {
    const to = { x: real(round3(real(2 * end.r))), z: round3(end.z) };
    const chord = Math.hypot((to.x - pos.x) / 2, to.z - pos.z);
    const r = Math.max(arc.radius, chord / 2 + 0.001);
    // Mirroring the radius turns an inside arc the other way round.
    let line = `${arc.ccw !== inside ? 'G3' : 'G2'} X${fmt(real(to.x))} Z${fmt(to.z)} R${fmt(r)}`;
    if (f !== lastF) {
      line += ` F${fmt(f)}`;
      lastF = f;
    }
    lines.push(line);
    // The model follows the arc as fine chords.
    const a0 = Math.atan2(pos.x / 2 - arc.cv, pos.z - arc.cu);
    let sweepA = Math.atan2(to.x / 2 - arc.cv, to.z - arc.cu) - a0;
    if (arc.ccw && sweepA < 0) sweepA += 2 * Math.PI;
    if (!arc.ccw && sweepA > 0) sweepA -= 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(sweepA) / 0.01));
    let from = pos;
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (sweepA * i) / steps;
      const p = i === steps ? to : { x: 2 * (arc.cv + arc.radius * Math.sin(a)), z: arc.cu + arc.radius * Math.cos(a) };
      cut(from, p);
      from = p;
    }
    pos = to;
  };

  // Lowest radius at grid i where the current tool clears the material it has in front of it.
  const clearAt = (i: number) => {
    let m = -1e9;
    for (let k = 0; k < fp.dr.length && k <= i; k++) m = Math.max(m, S[i - k] - fp.dr[k]);
    return m;
  };
  // Rapid along Z to z, first up to above everything between here and there.
  function lift(z: number) {
    if (Math.abs(z - pos.z) <= 1e-9) return;
    const a = idx(pos.z), b = idx(z);
    let top = 0;
    for (let i = Math.max(0, Math.min(a, b) - fp.dr.length); i <= Math.max(a, b); i++) top = Math.max(top, S[i]);
    const height = 2 * (top + MARGIN);
    if (pos.x < height) rapid(height);
    rapid(undefined, z);
  }
  // Rapid to (x, z): up to above everything between here and there, along Z, then down.
  const travel = (x: number, z: number) => {
    lift(z);
    rapid(x);
  };
  // Gets the tool to radius r at grid i (or at z, in front of the face), feeding in if it has to.
  const enter = (i: number, r: number, f: number, z = zAt(i)) => {
    const clear = clearAt(idx(z)) + MARGIN;
    if (clear <= r) travel(2 * r, z);
    else {
      travel(2 * clear, z);
      feed(f, 2 * r);
    }
  };

  // --- Roughing: horizontal passes down to `goal` ----------------------------------------------
  const rough = (goal: Float64Array, doc: number, f: number, from = iFace, to = iZone) => {
    const gap = Math.round(GAP_MM / step);
    let top = 0, bottom = Infinity;
    for (let i = from; i <= to; i++) {
      if (S[i] > goal[i] + MATERIAL_MIN) top = Math.max(top, S[i]);
      bottom = Math.min(bottom, goal[i]);
    }
    if (top === 0) return;
    for (let level = top - doc; ; level -= doc) {
      const L = Math.max(level, bottom);
      for (let i = from; i <= to; ) {
        if (!(goal[i] <= L + 1e-9 && S[i] > L + MATERIAL_MIN)) {
          i++;
          continue;
        }
        let end = i, j = i, missing = 0;
        for (; j <= to && goal[j] <= L + 1e-9; j++) {
          if (S[j] > L + MATERIAL_MIN) [end, missing] = [j, 0];
          else if (++missing > gap) break;
        }
        if ((end - i) * step >= MIN_PASS_MM) {
          // Near the face, come in from the front along Z when nothing in between is in the way.
          let front = from === iFace && (i - from) * step <= 1;
          for (let k = from; front && k < i; k++) front = goal[k] <= L + 1e-9;
          enter(front ? from : i, L, f, front ? zAt(from) + 1 : zAt(i));
          feed(f, undefined, zAt(end));
        }
        i = j;
      }
      if (L <= bottom + 1e-9) break;
    }
  };

  // --- Contours: a path along `v` from grid a to b, as lines and arcs -------------------------
  type PathPoint = { z: number; r: number; arc?: { cu: number; cv: number; radius: number; ccw: boolean } };
  const contour = (v: Float64Array, a: number, b: number, f: number) => {
    // The simulator gives each point of a move to its nearest grid point, so between two grid
    // points the path must stay over both of their values: raise each by half the change to its
    // neighbors. Steep changes go square instead (along Z, then X, never through the corner).
    const steep = (i: number) => Math.abs(v[i + 1] - v[i]) > STEEP;
    const safe = (i: number) => {
      let lift = 0;
      if (i > a && !steep(i - 1)) lift = Math.max(lift, Math.abs(v[i] - v[i - 1]) / 2);
      if (i < b && !steep(i)) lift = Math.max(lift, Math.abs(v[i + 1] - v[i]) / 2);
      return v[i] + lift;
    };
    const path: PathPoint[] = [];
    let chunk = [{ z: zAt(a), r: safe(a) }];
    for (let i = a; i < b; i++) {
      const next = { z: zAt(i + 1), r: safe(i + 1) };
      if (!steep(i)) {
        chunk.push(next);
        continue;
      }
      path.push(...fit(chunk));
      const here = chunk[chunk.length - 1];
      path.push(next.r > here.r ? { z: here.z, r: next.r } : { z: next.z, r: here.r }, next);
      chunk = [next];
    }
    path.push(...fit(chunk));

    enter(a, safe(a), f, a <= iFace + 1 ? zAt(iFace) + 1 : zAt(a));
    feed(f, undefined, zAt(a));
    for (const p of path) {
      if (p.arc) arcTo(f, p, p.arc);
      else feed(f, 2 * p.r, p.z);
    }
  };

  // --- Finish profile, then what the finishing tool can't reach --------------------------------
  const allowance = cam.finishAllowance;
  const doc = cam.depthOfCut;

  if (stock.faceStock > 0) {
    section('Face', rougher, cam.roughSpeed);
    for (let z = stock.faceStock - doc; ; z -= doc) {
      const zp = Math.max(0, z);
      travel(stock.diameter + 4, zp + 2);
      rapid(undefined, zp);
      feed(cam.roughFeed * 0.8, -2 * rougher.noseRadius);
      rapid(undefined, zp + 2);
      rapid(stock.diameter + 4);
      if (zp === 0) break;
    }
  }

  section('Rough OD', rougher, cam.roughSpeed);
  rough(envelope(fps.get(rougher.id)!, grow(target, allowance)), doc, cam.roughFeed);

  const finishEnv = envelope(fps.get(finisher.id)!, target);
  if (finisher !== rougher) {
    const goal = envelope(fps.get(finisher.id)!, grow(target, allowance));
    let rest = false;
    for (let i = iFace; i <= iZone && !rest; i++) rest = stockR[i] > goal[i] + MATERIAL_MIN + 1e-9 && goal[i] + doc / 2 < stockR[i];
    if (rest) {
      section('Rest rough', finisher, cam.roughSpeed);
      rough(goal, doc, cam.roughFeed * 0.8);
    }
  }

  // The rougher already faced Z0: start the contour at the top of the face, not at the center.
  let start = iFace;
  while (start < iZone && finishEnv[start + 1] - finishEnv[start] > STEEP) start++;
  section('Finish profile', finisher, cam.finishSpeed);
  contour(finishEnv, start, iZone, cam.finishFeed);

  // --- Square plunges where the finish left material: steps outside, grooves inside -----------
  // Plunges side by side, then one pass along the walls to clean up between them. Runs on the
  // material the current tool's side sees, so call it on that side (after a tool of that side).
  const plungeSteps = (name: string, blade: Parting | Grooving, hi: Float64Array, lo: Float64Array, last: number) => {
    const env = envelope(fps.get(blade.id)!, lo);
    const wSteps = Math.round(blade.width / step);
    const regions: [number, number][] = [];
    for (let i = iFace + 1; i < last; i++) {
      if (S[i] - hi[i] <= LEFTOVER_MM) continue;
      const prev = regions[regions.length - 1];
      if (prev && i - prev[1] <= Math.round(1 / step)) prev[1] = i;
      else regions.push([i, i]);
    }
    if (!regions.length) return;
    section(name, blade, cam.partSpeed);
    for (const [a, b] of regions) {
      const stride = Math.max(1, Math.floor(wSteps * 0.8));
      const plunges: number[] = [];
      for (let p = Math.min(last, b + wSteps - 1); p > a; p -= stride) plunges.push(p);
      plunges.push(a);
      for (const p of plunges.reverse()) {
        if (S[p] <= env[p] + LEFTOVER_MM && S[Math.max(0, p - wSteps)] <= env[p] + LEFTOVER_MM) continue;
        enter(p, env[p], cam.partFeed);
        rapid(2 * (env[p] + MARGIN));
      }
      contour(env, a, Math.min(last, b + wSteps - 1), cam.partFeed);
    }
  };

  if (parting) plungeSteps('Cut steps', parting, targetHi, target, iLast);

  // --- The bore: drill, bore, internal grooves ----------------------------------------------
  if (bore.length >= 2) {
    const zEnd = Math.min(...bore.map(([z]) => z));
    const through = zEnd <= zLast + 1e-9;
    const zHole = through ? zLast - width - 0.5 : zEnd; // the drill's full diameter reaches here
    const iBore = idx(Math.max(zEnd, zLast)); // the bore's last grid point in the part
    const iHole = idx(zHole);
    const iBoreZone = through ? iHole : iBore;
    // The target in inside space: R − the hole's radius, so a step's larger radius is the lower
    // one there. A through bore carries on behind the part, to where the drill goes; anywhere else
    // the bar stays solid.
    const boreSegments = profileSegments(bore);
    const boreLastR = bore[bore.length - 1][1] / 2;
    const tIn = new Float64Array(n), tInHi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const z = zAt(i);
      if (z > 1e-9) tIn[i] = tInHi[i] = -1e9;
      else if (i <= iBore) {
        const { lo, hi } = segmentsRangeAt(boreSegments, z);
        tIn[i] = R - (Number.isNaN(hi) ? boreLastR : hi);
        tInHi[i] = R - (Number.isNaN(lo) ? boreLastR : lo);
      } else tIn[i] = tInHi[i] = through && i <= iHole ? R - boreLastR : R;
    }
    let smallest = Infinity;
    for (let i = iFace; i <= iBore; i++) smallest = Math.min(smallest, 2 * (R - tInHi[i]));
    const drill = pick<Drill>(cam.drillTool, 'drill') ?? drills.filter((d) => d.diameter <= smallest + 1e-6).sort((a, b) => b.diameter - a.diameter)[0];
    if (!drill)
      throw new GenerateError(
        drills.length
          ? `tools: every drill is bigger than the bore's smallest diameter (Ø${fmt(smallest)}); add a drill of at most Ø${fmt(smallest)}`
          : `tools: add a drill to make the bore, at most Ø${fmt(smallest)} (its smallest diameter); a boring bar opens it up from there`,
      );
    const cone = drill.diameter / 2 / Math.tan((Math.min(179, drill.pointAngle) / 2) * (Math.PI / 180));
    if (!through && zEnd - cone < zLast + 1)
      throw new GenerateError(
        `bore: the drill's point goes ${fmt2(cone)} mm past the end of the bore, through the back of the part (Z${fmt2(zLast)}); ` +
          `end the bore at Z${fmt2(Math.ceil((zLast + cone + 1) * 100) / 100)} or in front of it, or make it a through bore to Z${fmt2(zLast)}`,
      );

    // Peck drilling at the center, at a fixed rpm, coming out to clear the chips each peck.
    const rpm = Math.min(cam.maxRpm, (1000 * cam.drillSpeed) / (Math.PI * drill.diameter));
    const drillFeed = job.cam?.drillFeed ?? round3(Math.min(1.5, Math.max(0.5, drill.diameter / 10)) * cutting.drillFeed);
    section('Drill', drill, rpm, true);
    rapid(real(0));
    rapid(undefined, 1);
    const zTip = zHole - cone, peck = Math.max(2, drill.diameter);
    for (let z = Math.max(zTip, -peck), reached = 1; ; z = Math.max(zTip, z - peck)) {
      if (reached < 1) rapid(undefined, reached + 0.5);
      feed(drillFeed, undefined, z);
      rapid(undefined, 1);
      reached = z;
      if (z <= zTip + 1e-9) break;
    }

    if (borer) {
      const fpB = fps.get(borer.id)!;
      const goal = envelope(fpB, grow(tIn, allowance));
      let needed = false;
      for (let i = iFace; i <= iBoreZone && !needed; i++) needed = holeS[i] > goal[i] + MATERIAL_MIN;
      if (needed) {
        if (borer.minBore > drill.diameter + 1e-6)
          throw new GenerateError(
            `tools: the boring bar (T${borer.id}) needs a hole of at least Ø${fmt(borer.minBore)} and the drill (T${drill.id}) makes Ø${fmt(drill.diameter)}; ` +
              'add a bigger drill (up to the bore\'s smallest diameter) or a boring bar for smaller holes',
          );
        section('Rough bore', borer, cam.boreSpeed);
        rough(goal, Math.min(doc, 1.5), cam.boreFeed, iFace, iBoreZone);
        const finishBore = envelope(fpB, tIn);
        let first = iFace;
        while (first < iBoreZone && finishBore[first + 1] - finishBore[first] > STEEP) first++;
        section('Finish bore', borer, cam.finishSpeed);
        contour(finishBore, first, iBoreZone, cam.finishFeed);
        // A blind bore: face its bottom out to the drilled hole.
        if (!through) feed(cam.finishFeed, 2 * (R - drill.diameter / 2 + MARGIN));
      }
    }
    if (groover) plungeSteps('Internal grooves', groover, tInHi, tIn, iBoreZone);
  }

  if (parting) {
    section('Part off', parting, cam.partSpeed);
    const zPart = zLast - width;
    enter(idx(zPart), 0, cam.partFeed, zPart);
  }
  retreat();

  lines.push('M9', 'G28 U0 W0', 'M5', 'M30', '%');
  return lines.join('\n');
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// --- Fitting: grid points to the fewest lines and arcs within tolerance ------------------------

type P = { z: number; r: number };
type Fitted = P & { arc?: { cu: number; cv: number; radius: number; ccw: boolean } };

function fit(points: P[]): Fitted[] {
  const out: Fitted[] = [];
  let s = 0;
  const last = points.length - 1;
  while (s < last) {
    // Grow the span while it still fits (doubling), then narrow down the longest one that does.
    let good = s + 1, bad = 0;
    for (let len = 2; good < last; len *= 2) {
      const next = Math.min(last, s + len);
      if (!fitSpan(points, s, next)) {
        bad = next;
        break;
      }
      good = next;
    }
    let lo = good, hi = bad || good;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fitSpan(points, s, mid)) lo = mid;
      else hi = mid;
    }
    const e = lo;
    const shape = fitSpan(points, s, e) || undefined;
    out.push(shape && shape !== true ? { ...points[e], arc: shape } : { ...points[e] });
    s = e;
  }
  return out;
}

/** True when a line fits points s…e, an arc when only an arc does, false when neither. */
function fitSpan(points: P[], s: number, e: number): true | NonNullable<Fitted['arc']> | false {
  const a = points[s], b = points[e];
  const within = (value: (z: number) => number) => {
    for (let j = s + 1; j < e; j++) {
      const d = value(points[j].z) - points[j].r;
      if (d < -TOL_BELOW || d > TOL_ABOVE) return false;
    }
    return true;
  };
  if (b.z !== a.z && within((z) => a.r + ((b.r - a.r) * (z - a.z)) / (b.z - a.z))) return true;
  if (e - s < 2) return false;
  const m = points[(s + e) >> 1];
  // Circle through a, m, b in the (z, r) plane.
  const d = 2 * (a.z * (m.r - b.r) + m.z * (b.r - a.r) + b.z * (a.r - m.r));
  if (Math.abs(d) < 1e-12) return false;
  const a2 = a.z ** 2 + a.r ** 2, m2 = m.z ** 2 + m.r ** 2, b2 = b.z ** 2 + b.r ** 2;
  const cu = (a2 * (m.r - b.r) + m2 * (b.r - a.r) + b2 * (a.r - m.r)) / d;
  const cv = (a2 * (b.z - m.z) + m2 * (a.z - b.z) + b2 * (m.z - a.z)) / d;
  const radius = Math.hypot(a.z - cu, a.r - cv);
  if (radius > 2000) return false;
  const up = m.r >= cv ? 1 : -1;
  if (up * (a.r - cv) < -1e-9 || up * (b.r - cv) < -1e-9) return false; // past a vertical tangent
  const onArc = (z: number) => cv + up * Math.sqrt(Math.max(0, radius ** 2 - (z - cu) ** 2));
  for (let j = s; j <= e; j++) if (Math.abs(points[j].z - cu) > radius + 1e-9) return false;
  if (!within(onArc)) return false;
  const ccw = (a.z - cu) * (b.r - cv) - (a.r - cv) * (b.z - cu) > 0;
  return { cu, cv, radius, ccw };
}
