/**
 * A job turned into a timeline: `stateAt(t)` gives the machine state and the workpiece profile at
 * any moment. Profiles (the outside and the hole) are snapshotted before every segment that cuts,
 * so scrubbing in either direction only replays the part of one segment.
 */
import type { Job } from './job-schema.ts';
import { parseGcode, type ParseIssue } from './gcode/parse.ts';
import { planProgram, type Point, type Segment } from './gcode/plan.ts';
import { footprint, isFace, isInside, type Footprint } from './tool-shapes.ts';
import { freshBore, freshGap, freshProfile, hasGap, stockShape, sweep, sweepFace, sweepInner, weight, type Gap, type StockShape } from './stock.ts';

export type MachineState = {
  t: number;
  segment: number;
  pos: Point;
  line: number;
  tool: number;
  rpm: number;
  feed: number; // mm/min
  feedWord: number;
  perRev: boolean;
  spindle: Segment['spindle'];
  coolant: boolean;
  kind: Segment['kind'] | 'idle';
  done: boolean;
};

export type Timeline = {
  job: Job;
  shape: StockShape;
  segments: Segment[];
  duration: number;
  warnings: ParseIssue[];
  home: Point;
  startWeight: number;
  endWeight: number;
  final: Float32Array;
  finalBore: Float32Array;
  finalGap: Gap;
  /** Whether any tool cuts the inside: without it the hole stays at 0 and need not be drawn. */
  hollow: boolean;
  /** Whether a face groove is cut. */
  grooved: boolean;
  stateAt(t: number): MachineState;
  /**
   * Writes the profile at `t` into `out` (length `shape.n`), the hole's into `inner` and the face
   * groove into `gap` if given. A groove needs `inner` too: its walls are cut against the hole.
   */
  profileAt(t: number, out: Float32Array, inner?: Float32Array, gap?: Gap): Float32Array;
  /** Time each source line starts, for stepping and the G-code panel. */
  lineStart: Map<number, number>;
};

export function buildTimeline(job: Job): Timeline {
  const shape = stockShape(job.stock);
  const { blocks, issues } = parseGcode(job.gcode);
  const home = { x: job.stock.diameter + 50, z: job.stock.faceStock + 50 };
  const plan = planProgram(blocks, { home });
  const warnings = [...issues, ...plan.warnings];
  const segments = plan.segments;

  const footprints = new Map<number, Footprint>();
  const inside = new Set<number>();
  const faceWidth = new Map<number, number>(); // face grooving tools, by id
  for (const tool of job.tools) {
    footprints.set(tool.id, footprint(tool, shape.step));
    if (isInside(tool)) inside.add(tool.id);
    if (isFace(tool)) faceWidth.set(tool.id, tool.width);
  }
  const missing = new Set<number>();
  const fpFor = (segment: Segment) => {
    const fp = footprints.get(segment.tool);
    if (!fp && segment.tool && !missing.has(segment.tool)) {
      missing.add(segment.tool);
      warnings.push({ line: segment.line, message: `T${segment.tool} is not in the job's tools; it does not cut` });
    }
    return fp;
  };

  // Before segment i the profile is snapshots[i] (the hole, holes[i]; the face groove, gaps[i]);
  // segments that don't cut share the previous arrays.
  const snapshots: Float32Array[] = new Array(segments.length + 1);
  const holes: Float32Array[] = new Array(segments.length + 1);
  const gaps: Gap[] = new Array(segments.length + 1);
  let current = freshProfile(shape);
  let hole = freshBore(shape);
  let gap = freshGap(shape);
  let grooved = false; // whether `gap` has a groove in it, so other tools must keep it in step
  const copyGap = (g: Gap): Gap => ({ lo: g.lo.slice(), hi: g.hi.slice() });
  const startWeight = weight(current, shape.step, job.material.density);
  let rapidWarned = false;
  segments.forEach((segment, i) => {
    snapshots[i] = current;
    holes[i] = hole;
    gaps[i] = gap;
    const fp = segment.kind === 'dwell' ? undefined : fpFor(segment);
    if (!fp) return;
    let removed: number;
    const width = faceWidth.get(segment.tool);
    if (width !== undefined) {
      const [r, ri, g] = [current.slice(), hole.slice(), copyGap(gap)];
      removed = sweepFace(r, ri, g, shape, width, segment.from, segment.to);
      if (removed > 0) [current, hole, gap, grooved] = [r, ri, g, hasGap(g)];
    } else if (inside.has(segment.tool)) {
      const next = hole.slice();
      const g = grooved ? copyGap(gap) : undefined;
      removed = sweepInner(next, current, shape, fp, segment.from, segment.to, g);
      if (next.some((v, k) => v !== hole[k])) [hole, gap] = [next, g ?? gap];
    } else {
      if (Math.min(segment.from.x, segment.to.x) / 2 >= shape.radius) return;
      const next = current.slice();
      const g = grooved ? copyGap(gap) : undefined;
      removed = sweep(next, shape, fp, segment.from, segment.to, g);
      if (removed > 0) [current, gap] = [next, g ?? gap];
    }
    if (removed > 0) {
      if (segment.kind === 'rapid' && removed > 1 && !rapidWarned) {
        rapidWarned = true;
        warnings.push({ line: segment.line, message: 'A rapid move (G0) goes through the material' });
      }
    }
  });
  snapshots[segments.length] = current;
  holes[segments.length] = hole;
  gaps[segments.length] = gap;
  const final = current;
  const finalBore = hole;
  const finalGap = gap;
  warnings.sort((a, b) => a.line - b.line);

  const lineStart = new Map<number, number>();
  for (const segment of segments) if (!lineStart.has(segment.line)) lineStart.set(segment.line, segment.t0);

  const indexAt = (t: number) => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const stateAt = (t: number): MachineState => {
    if (!segments.length)
      return { t: 0, segment: -1, pos: home, line: 0, tool: 0, rpm: 0, feed: 0, feedWord: 0, perRev: true, spindle: 'off', coolant: false, kind: 'idle', done: true };
    const clamped = Math.min(Math.max(t, 0), plan.duration);
    const i = indexAt(clamped);
    const segment = segments[i];
    const f = segment.dt > 0 ? Math.min(1, (clamped - segment.t0) / segment.dt) : 1;
    const done = clamped >= plan.duration;
    return {
      t: clamped,
      segment: i,
      pos: { x: segment.from.x + (segment.to.x - segment.from.x) * f, z: segment.from.z + (segment.to.z - segment.from.z) * f },
      line: segment.line,
      tool: segment.tool,
      rpm: done ? 0 : segment.rpm,
      feed: segment.kind === 'feed' ? segment.feed : 0,
      feedWord: segment.feedWord,
      perRev: segment.perRev,
      spindle: done ? 'off' : segment.spindle,
      coolant: !done && segment.coolant,
      kind: done ? 'idle' : segment.kind,
      done,
    };
  };

  const profileAt = (t: number, out: Float32Array, inner?: Float32Array, groove?: Gap) => {
    if (!segments.length) {
      inner?.fill(0);
      groove?.lo.fill(0);
      groove?.hi.fill(0);
      return out.fill(shape.radius);
    }
    const state = stateAt(t);
    const i = state.segment;
    out.set(snapshots[i]);
    inner?.set(holes[i]);
    groove?.lo.set(gaps[i].lo);
    groove?.hi.set(gaps[i].hi);
    const segment = segments[i];
    const fp = segment.kind === 'dwell' ? undefined : footprints.get(segment.tool);
    const width = faceWidth.get(segment.tool);
    const changed = snapshots[i + 1] !== snapshots[i] || holes[i + 1] !== holes[i] || gaps[i + 1] !== gaps[i];
    if (fp && width !== undefined) {
      if (!changed) return out;
      if (state.done) {
        out.set(snapshots[i + 1]);
        inner?.set(holes[i + 1]);
        groove?.lo.set(gaps[i + 1].lo);
        groove?.hi.set(gaps[i + 1].hi);
      } else sweepFace(out, inner ?? holes[i].slice(), groove ?? copyGap(gaps[i]), shape, width, segment.from, state.pos);
      return out;
    }
    if (fp && snapshots[i + 1] !== snapshots[i]) {
      if (state.done) out.set(snapshots[i + 1]);
      else sweep(out, shape, fp, segment.from, state.pos, groove);
    }
    if (fp && inner && holes[i + 1] !== holes[i]) {
      if (state.done) inner.set(holes[i + 1]);
      else sweepInner(inner, out, shape, fp, segment.from, state.pos, groove);
    }
    if (groove && state.done && gaps[i + 1] !== gaps[i]) {
      groove.lo.set(gaps[i + 1].lo);
      groove.hi.set(gaps[i + 1].hi);
    }
    return out;
  };

  return {
    job, shape, segments, duration: plan.duration, warnings, home,
    startWeight, endWeight: weight(final, shape.step, job.material.density, 0, shape.n, finalBore, finalGap), final, finalBore, finalGap,
    hollow: holes[segments.length] !== holes[0], grooved, stateAt, profileAt, lineStart,
  };
}
