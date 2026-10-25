/**
 * Motion planner: runs the blocks through a Fanuc-style modal state and returns timed straight
 * segments. Arcs come out as short chords, and feed moves that change diameter under constant
 * surface speed (G96) are split so each piece gets its own rpm.
 */
import type { Block, ParseIssue } from './parse.ts';

export type Point = { x: number; z: number }; // x is a diameter, mm

export type Segment = {
  kind: 'rapid' | 'feed' | 'dwell';
  line: number;
  from: Point;
  to: Point;
  t0: number; // seconds from program start
  dt: number;
  rpm: number;
  feed: number; // mm/min actually used
  feedWord: number; // F as programmed (mm/rev or mm/min)
  perRev: boolean;
  tool: number;
  spindle: 'cw' | 'ccw' | 'off';
  coolant: boolean;
};

export type PlanOptions = {
  home: Point;
  rapid?: number; // mm/min per axis
  maxRpm?: number; // machine limit when the program has no G50
};

export type Plan = { segments: Segment[]; duration: number; warnings: ParseIssue[] };

const IGNORED_G = new Set([18, 21, 40, 41, 42, 54, 80]); // accepted, no effect in the simulator yet
/** The simulated machine's limits; the agent is told about them too. */
export const MACHINE = { rapid: 6000, maxRpm: 4000, toolChangeS: 1.5 };
const TOOL_CHANGE_S = MACHINE.toolChangeS;
const ARC_STEP_DEG = 3;

export function planProgram(blocks: Block[], options: PlanOptions): Plan {
  const rapid = options.rapid ?? MACHINE.rapid;
  const machineMax = options.maxRpm ?? MACHINE.maxRpm;
  const segments: Segment[] = [];
  const warnings: ParseIssue[] = [];
  const warned = new Set<string>();
  const warn = (line: number, message: string) => {
    if (warned.has(message)) return; // one note per kind is enough
    warned.add(message);
    warnings.push({ line, message });
  };

  const s = {
    pos: { ...options.home },
    motion: 0,
    absolute: true,
    inch: false,
    css: false, // G96
    speed: 0, // S: m/min under G96, rpm under G97
    maxRpm: machineMax,
    perRev: true, // G99 is the usual default on lathes
    feed: 0,
    tool: 0,
    spindle: 'off' as Segment['spindle'],
    coolant: false,
    ended: false,
  };
  let t = 0;

  const rpmAt = (diameter: number) => {
    if (s.spindle === 'off') return 0;
    if (!s.css) return Math.min(s.speed, s.maxRpm);
    return Math.min((1000 * s.speed) / (Math.PI * Math.max(diameter, 0.1)), s.maxRpm);
  };

  const push = (kind: Segment['kind'], line: number, from: Point, to: Point, dt: number, rpm: number, feed: number) => {
    segments.push({
      kind, line, from, to, t0: t, dt, rpm, feed,
      feedWord: s.feed, perRev: s.perRev, tool: s.tool, spindle: s.spindle, coolant: s.coolant,
    });
    t += dt;
  };

  const rapidTo = (line: number, to: Point) => {
    const from = s.pos;
    const dt = (Math.max(Math.abs(to.x - from.x) / 2, Math.abs(to.z - from.z)) / rapid) * 60;
    if (dt > 0) push('rapid', line, from, to, dt, rpmAt(from.x), rapid);
    s.pos = to;
  };

  const feedTo = (line: number, to: Point) => {
    const from = s.pos;
    if (s.feed <= 0) warn(line, 'Feed move without F; using 100 mm/min');
    if (s.perRev && s.spindle === 'off') warn(line, 'Feed per revolution with the spindle stopped; using 100 mm/min');
    // Under G96 the rpm follows the diameter, so split moves that change it into ≤1 mm radial pieces.
    const pieces = s.css && s.perRev ? Math.max(1, Math.ceil(Math.abs(to.x - from.x) / 2)) : 1;
    let a = from;
    for (let i = 1; i <= pieces; i++) {
      const b = i === pieces ? to : { x: from.x + ((to.x - from.x) * i) / pieces, z: from.z + ((to.z - from.z) * i) / pieces };
      const rpm = rpmAt((a.x + b.x) / 2);
      let mmMin = s.perRev ? s.feed * rpm : s.feed;
      if (!(mmMin > 0)) mmMin = 100;
      const length = Math.hypot((b.x - a.x) / 2, b.z - a.z);
      push('feed', line, a, b, (length / mmMin) * 60, rpm, mmMin);
      a = b;
    }
    s.pos = to;
  };

  const arcTo = (line: number, to: Point, cw: boolean, words: Map<string, number>) => {
    // Work in the (z, r) plane with Z to the right and radius up: G2 is clockwise there.
    const p0 = { u: s.pos.z, v: s.pos.x / 2 };
    const p1 = { u: to.z, v: to.x / 2 };
    let cu: number, cv: number;
    const R = words.get('R');
    if (R !== undefined) {
      const du = p1.u - p0.u, dv = p1.v - p0.v;
      const d = Math.hypot(du, dv);
      if (d === 0) return warn(line, 'Arc with R and no movement is ignored');
      const r = Math.abs(R);
      if (d > 2 * r + 1e-6) warn(line, 'Arc radius too small for its end point; drawn as a half circle');
      const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
      // Left normal of the chord. A counter-clockwise short arc has its center on the left.
      const nu = -dv / d, nv = du / d;
      const side = (cw ? -1 : 1) * (R < 0 ? -1 : 1);
      cu = (p0.u + p1.u) / 2 + side * nu * h;
      cv = (p0.v + p1.v) / 2 + side * nv * h;
    } else {
      const scale = s.inch ? 25.4 : 1;
      cu = p0.u + (words.get('K') ?? 0) * scale;
      cv = p0.v + (words.get('I') ?? 0) * scale;
    }
    const radius = Math.hypot(p0.u - cu, p0.v - cv);
    const a0 = Math.atan2(p0.v - cv, p0.u - cu);
    let sweep = Math.atan2(p1.v - cv, p1.u - cu) - a0;
    if (cw) { while (sweep >= 0) sweep -= 2 * Math.PI; if (sweep < -2 * Math.PI) sweep += 2 * Math.PI; }
    else { while (sweep <= 0) sweep += 2 * Math.PI; if (sweep > 2 * Math.PI) sweep -= 2 * Math.PI; }
    if (Math.abs(sweep) > 2 * Math.PI - 1e-9 && Math.hypot(p1.u - p0.u, p1.v - p0.v) < 1e-9) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ((ARC_STEP_DEG * Math.PI) / 180)));
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      const next = i === steps ? to : { x: 2 * (cv + radius * Math.sin(a)), z: cu + radius * Math.cos(a) };
      feedTo(line, next);
    }
  };

  for (const block of blocks) {
    if (s.ended) {
      warn(block.line, 'Lines after M30 are not run');
      break;
    }
    const words = new Map<string, number>();
    const gs: number[] = [];
    const ms: number[] = [];
    for (const word of block.words) {
      if (word.letter === 'G') gs.push(word.value);
      else if (word.letter === 'M') ms.push(word.value);
      else words.set(word.letter, word.value);
    }

    let dwell = false;
    let home = false;
    let setLimit = false;
    for (const g of gs) {
      if (g === 0 || g === 1 || g === 2 || g === 3) s.motion = g;
      else if (g === 4) dwell = true;
      else if (g === 20) s.inch = true;
      else if (g === 21) s.inch = false;
      else if (g === 90) s.absolute = true;
      else if (g === 91) s.absolute = false;
      else if (g === 96) s.css = true;
      else if (g === 97) s.css = false;
      else if (g === 98 || g === 94) s.perRev = false;
      else if (g === 99 || g === 95) s.perRev = true;
      else if (g === 28) home = true;
      else if (g === 50) setLimit = true;
      else if (!IGNORED_G.has(g)) warn(block.line, `G${g} is not supported yet; skipped`);
    }

    const scale = s.inch ? 25.4 : 1;
    if (words.has('F')) s.feed = words.get('F')! * scale;
    if (words.has('S')) {
      if (setLimit) s.maxRpm = Math.min(words.get('S')!, machineMax);
      else s.speed = words.get('S')!;
    }
    if (words.has('T')) {
      const value = words.get('T')!;
      const tool = value >= 100 ? Math.floor(value / 100) : value;
      if (tool !== s.tool) {
        s.tool = tool;
        push('dwell', block.line, s.pos, s.pos, TOOL_CHANGE_S, rpmAt(s.pos.x), 0);
      }
    }
    for (const m of ms) {
      if (m === 3) s.spindle = 'cw';
      else if (m === 4) s.spindle = 'ccw';
      else if (m === 5) s.spindle = 'off';
      else if (m === 8) s.coolant = true;
      else if (m === 9) s.coolant = false;
      else if (m === 30 || m === 2) s.ended = true;
      else if (m !== 0 && m !== 1) warn(block.line, `M${m} is not supported yet; skipped`);
    }

    if (dwell) {
      const seconds = words.has('P') ? words.get('P')! / 1000 : (words.get('X') ?? words.get('U') ?? 0);
      if (seconds > 0) push('dwell', block.line, s.pos, s.pos, seconds, rpmAt(s.pos.x), 0);
      continue;
    }
    if (setLimit) {
      if (words.has('X') || words.has('Z')) warn(block.line, 'G50 X/Z (coordinate setting) is ignored');
      continue;
    }
    if (home) {
      // G28 U0 W0: through the given point (incremental zero = here) to home, both axes at rapid.
      rapidTo(block.line, { ...options.home });
      continue;
    }

    const hasMove = ['X', 'Z', 'U', 'W'].some((letter) => words.has(letter));
    if (!hasMove) continue;
    const to = { ...s.pos };
    if (words.has('X')) to.x = s.absolute ? words.get('X')! * scale : s.pos.x + words.get('X')! * scale;
    if (words.has('Z')) to.z = s.absolute ? words.get('Z')! * scale : s.pos.z + words.get('Z')! * scale;
    if (words.has('U')) to.x = s.pos.x + words.get('U')! * scale;
    if (words.has('W')) to.z = s.pos.z + words.get('W')! * scale;

    if (s.motion === 0) rapidTo(block.line, to);
    else if (s.motion === 1) feedTo(block.line, to);
    else arcTo(block.line, to, s.motion === 2, words);
  }

  if (!s.ended) warn(blocks.at(-1)?.line ?? 1, 'The program has no M30');
  return { segments, duration: t, warnings };
}
