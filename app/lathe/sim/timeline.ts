/**
 * A job turned into a timeline: `stateAt(t)` gives the machine state and the workpiece profile at
 * any moment. Profiles are snapshotted before every segment that cuts, so scrubbing in either
 * direction only replays the part of one segment.
 */
import type { Job } from './job-schema.ts';
import { parseGcode, type ParseIssue } from './gcode/parse.ts';
import { planProgram, type Point, type Segment } from './gcode/plan.ts';
import { footprint, type Footprint } from './tool-shapes.ts';
import { freshProfile, stockShape, sweep, weight, type StockShape } from './stock.ts';

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
  stateAt(t: number): MachineState;
  /** Writes the profile at `t` into `out` (length `shape.n`). */
  profileAt(t: number, out: Float32Array): Float32Array;
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
  for (const tool of job.tools) footprints.set(tool.id, footprint(tool, shape.step));
  const missing = new Set<number>();
  const fpFor = (segment: Segment) => {
    const fp = footprints.get(segment.tool);
    if (!fp && segment.tool && !missing.has(segment.tool)) {
      missing.add(segment.tool);
      warnings.push({ line: segment.line, message: `T${segment.tool} is not in the job's tools; it does not cut` });
    }
    return fp;
  };

  // Before segment i the profile is snapshots[i]; segments that don't cut share the previous array.
  const snapshots: Float32Array[] = new Array(segments.length + 1);
  let current = freshProfile(shape);
  const startWeight = weight(current, shape.step, job.material.density);
  let rapidWarned = false;
  segments.forEach((segment, i) => {
    snapshots[i] = current;
    const fp = segment.kind === 'dwell' ? undefined : fpFor(segment);
    if (!fp || Math.min(segment.from.x, segment.to.x) / 2 >= shape.radius) return;
    const next = current.slice();
    const removed = sweep(next, shape, fp, segment.from, segment.to);
    if (removed > 0) {
      current = next;
      if (segment.kind === 'rapid' && removed > 1 && !rapidWarned) {
        rapidWarned = true;
        warnings.push({ line: segment.line, message: 'A rapid move (G0) goes through the material' });
      }
    }
  });
  snapshots[segments.length] = current;
  const final = current;
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

  const profileAt = (t: number, out: Float32Array) => {
    if (!segments.length) return out.fill(shape.radius);
    const state = stateAt(t);
    const i = state.segment;
    out.set(snapshots[i]);
    const segment = segments[i];
    const fp = segment.kind === 'dwell' ? undefined : footprints.get(segment.tool);
    if (fp && snapshots[i + 1] !== snapshots[i]) {
      if (state.done) out.set(snapshots[i + 1]);
      else sweep(out, shape, fp, segment.from, state.pos);
    }
    return out;
  };

  return {
    job, shape, segments, duration: plan.duration, warnings, home,
    startWeight, endWeight: weight(final, shape.step, job.material.density), final,
    stateAt, profileAt, lineStart,
  };
}
