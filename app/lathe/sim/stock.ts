/**
 * The workpiece as a radius at each point along its length. `r[i]` is the radius at
 * z = zFront − i·step (program coordinates, mm). Cutting lowers it under the tool's footprint.
 * A hole is a second radius, `ri[i]`, 0 where the bar is solid: inside tools raise it. Where
 * `ri[i] ≥ r[i]` there's no material left. A face groove is a third pair, `gap.lo[i]`…`gap.hi[i]`:
 * a ring with no material between two walls, cut from the front face; none where `hi ≤ lo`. It is
 * one ring per z, so two grooves side by side at the same z merge into one (the simulator's limit).
 */
import type { Footprint } from './tool-shapes.ts';
import type { Point } from './gcode/plan.ts';
import { profileRangeAt, profileSegments, segmentsRangeAt, type Profile } from './profile.ts';

export { profileRangeAt };

export const STEP_MM = 0.05;

export type StockShape = { zFront: number; length: number; radius: number; step: number; n: number };

export function stockShape(stock: { diameter: number; length: number; faceStock: number }, step = STEP_MM): StockShape {
  return {
    zFront: stock.faceStock,
    length: stock.length,
    radius: stock.diameter / 2,
    step,
    n: Math.round(stock.length / step) + 1,
  };
}

export function freshProfile(shape: StockShape): Float32Array {
  return new Float32Array(shape.n).fill(shape.radius);
}

export function freshBore(shape: StockShape): Float32Array {
  return new Float32Array(shape.n);
}

export type Gap = { lo: Float32Array; hi: Float32Array };

export function freshGap(shape: StockShape): Gap {
  return { lo: new Float32Array(shape.n), hi: new Float32Array(shape.n) };
}

export const hasGap = (gap: Gap) => gap.hi.some((hi, i) => hi > gap.lo[i]);

// A groove whose wall was cut away is part of the outside (or of the hole) from then on.
function settleOuter(i: number, r: Float32Array, gap: Gap) {
  if (gap.hi[i] <= gap.lo[i] || gap.hi[i] < r[i]) return;
  r[i] = Math.min(r[i], gap.lo[i]);
  gap.lo[i] = gap.hi[i] = 0;
}
function settleInner(i: number, ri: Float32Array, gap: Gap) {
  if (gap.hi[i] <= gap.lo[i] || gap.lo[i] > ri[i]) return;
  ri[i] = Math.max(ri[i], gap.hi[i]);
  gap.lo[i] = gap.hi[i] = 0;
}

/** The ring area (mm², over π) the gap takes out of the material between `inner` and `outer`. */
function gapArea(gap: Gap | undefined, i: number, inner: number, outer: number): number {
  if (!gap) return 0;
  const lo = Math.max(inner, gap.lo[i]), hi = Math.min(outer, gap.hi[i]);
  return hi > lo ? hi * hi - lo * lo : 0;
}

/**
 * Sweeps the footprint from `a` to `b` (x as diameter) and lowers `r`.
 * Returns the volume removed in mm³, so a rapid move through material can be reported.
 */
export function sweep(r: Float32Array, shape: StockShape, fp: Footprint, a: Point, b: Point, gap?: Gap): number {
  const ra = a.x / 2, rb = b.x / 2;
  if (Math.min(ra, rb) >= shape.radius) return 0; // above the bar the whole way
  const { step, zFront, n } = shape;
  const samples = Math.max(1, Math.ceil(Math.max(Math.abs(b.z - a.z), Math.abs(rb - ra)) / step));
  const span = fp.dr.length;
  let removed = 0;
  for (let s = 0; s <= samples; s++) {
    const f = s / samples;
    const pr = ra + (rb - ra) * f;
    if (pr >= shape.radius) continue;
    const i0 = Math.round((zFront - (a.z + (b.z - a.z) * f)) / step);
    for (let k = 0; k < span; k++) {
      const i = i0 - k; // footprint extends toward +Z, which is toward lower indices
      if (i < 0) break;
      if (i >= n) continue;
      const edge = Math.max(0, pr + fp.dr[k]);
      const current = r[i];
      if (edge < current) {
        removed += Math.PI * (current * current - edge * edge - gapArea(gap, i, edge, current)) * step;
        r[i] = edge;
        if (gap) settleOuter(i, r, gap);
      }
    }
  }
  return removed;
}

/**
 * The same for an inside tool: raises `ri` to the footprint's edge, measured from the programmed
 * point toward the axis. `r` is the outside, only read, so the volume counts material that was there.
 */
export function sweepInner(ri: Float32Array, r: Float32Array, shape: StockShape, fp: Footprint, a: Point, b: Point, gap?: Gap): number {
  const ra = a.x / 2, rb = b.x / 2;
  const { step, zFront, n } = shape;
  const samples = Math.max(1, Math.ceil(Math.max(Math.abs(b.z - a.z), Math.abs(rb - ra)) / step));
  const span = fp.dr.length;
  let removed = 0;
  for (let s = 0; s <= samples; s++) {
    const f = s / samples;
    const pr = ra + (rb - ra) * f;
    const i0 = Math.round((zFront - (a.z + (b.z - a.z) * f)) / step);
    for (let k = 0; k < span; k++) {
      const i = i0 - k;
      if (i < 0) break;
      if (i >= n) continue;
      const edge = pr - fp.dr[k];
      const current = ri[i];
      if (edge > current) {
        const outer = r[i];
        if (current < outer) removed += Math.PI * (Math.min(edge, outer) ** 2 - current * current - gapArea(gap, i, current, Math.min(edge, outer))) * step;
        ri[i] = edge;
        if (gap) settleInner(i, ri, gap);
      }
    }
  }
  return removed;
}

/**
 * A face grooving tool from `a` to `b`: a blade `width` wide (radius) whose programmed point is the
 * inner corner of its tip, at x (diameter). It cuts the ring from there out to x/2 + width, from the
 * tip all the way to the front: the blade fills the groove it has cut. Returns the volume removed.
 */
export function sweepFace(r: Float32Array, ri: Float32Array, gap: Gap, shape: StockShape, width: number, a: Point, b: Point): number {
  const ra = a.x / 2, rb = b.x / 2;
  const { step, zFront, n } = shape;
  const samples = Math.max(1, Math.ceil(Math.max(Math.abs(b.z - a.z), Math.abs(rb - ra)) / step));
  let removed = 0;
  for (let s = 0; s <= samples; s++) {
    const f = s / samples;
    const lo = Math.max(0, ra + (rb - ra) * f), hi = lo + width;
    const i0 = Math.min(n - 1, Math.round((zFront - (a.z + (b.z - a.z) * f)) / step));
    for (let i = 0; i <= i0; i++) removed += cutRing(i, lo, hi, r, ri, gap) * step;
  }
  return removed;
}

/** Removes the ring lo…hi (radius) at grid i; returns the area removed, in mm². */
function cutRing(i: number, lo: number, hi: number, r: Float32Array, ri: Float32Array, gap: Gap): number {
  const outer = r[i], inner = ri[i];
  if (hi <= inner || lo >= outer) return 0;
  const before = outer * outer - inner * inner - gapArea(gap, i, inner, outer);
  if (lo <= inner && hi >= outer) {
    r[i] = inner;
    gap.lo[i] = gap.hi[i] = 0;
  } else if (hi >= outer) {
    r[i] = lo;
    settleOuter(i, r, gap);
  } else if (lo <= inner) {
    ri[i] = hi;
    settleInner(i, ri, gap);
  } else {
    // Two rings at one z merge into one: the material between them goes too (see the top).
    if (gap.hi[i] > gap.lo[i]) [lo, hi] = [Math.min(lo, gap.lo[i]), Math.max(hi, gap.hi[i])];
    gap.lo[i] = lo;
    gap.hi[i] = hi;
    settleOuter(i, r, gap);
    settleInner(i, ri, gap);
  }
  const after = Math.max(0, r[i] * r[i] - ri[i] * ri[i] - gapArea(gap, i, ri[i], r[i]));
  return Math.PI * Math.max(0, before - (r[i] > ri[i] ? after : 0));
}

/** Weight in grams, with density in g/cm³, optionally only over indices [from, to), less the hole `ri` and the face groove. */
export function weight(r: Float32Array, step: number, density: number, from = 0, to = r.length, ri?: Float32Array, gap?: Gap): number {
  let volume = 0;
  for (let i = Math.max(0, from); i < Math.min(r.length, to); i++) {
    const hole = ri ? Math.min(ri[i], r[i]) : 0;
    volume += r[i] * r[i] - hole * hole - gapArea(gap, i, hole, r[i]);
  }
  return (Math.PI * volume * step * density) / 1000;
}

/** Weight of the finished part: the stock between the ends of the target profile. */
export function partWeight(r: Float32Array, shape: StockShape, profile: Profile, density: number, ri?: Float32Array, gap?: Gap): number {
  if (profile.length < 2) return NaN;
  const zs = profile.map(([z]) => z);
  const from = Math.round((shape.zFront - Math.max(...zs)) / shape.step);
  const to = Math.round((shape.zFront - Math.min(...zs)) / shape.step);
  return weight(r, shape.step, density, from, to, ri, gap);
}

/**
 * The hole against the target bore, in mm (radius): the most material left inside it and how far
 * it was cut past it. Only inside the bore's ends (a blind bore ends in the drill's point) and the
 * part's: a through bore goes on into the bar, behind where it is parted off.
 */
export function compareToBore(ri: Float32Array, shape: StockShape, bore: Profile, profile: Profile) {
  let leftover = 0, leftoverZ = NaN, gouge = 0, gougeZ = NaN;
  if (bore.length < 2) return { leftover, leftoverZ, gouge, gougeZ };
  const zs = bore.map(([z]) => z);
  const back = profile.length ? Math.min(...profile.map(([z]) => z)) : -Infinity;
  const lo = Math.max(Math.min(...zs), back) + shape.step, hi = Math.max(...zs) - shape.step;
  const segments = profileSegments(bore);
  for (let i = 0; i < ri.length; i++) {
    const z = shape.zFront - i * shape.step;
    if (z < lo || z > hi) continue;
    const target = segmentsRangeAt(segments, z);
    if (Number.isNaN(target.lo)) continue;
    if (target.lo - ri[i] > leftover) { leftover = target.lo - ri[i]; leftoverZ = z; }
    if (ri[i] - target.hi > gouge) { gouge = ri[i] - target.hi; gougeZ = z; }
  }
  return { leftover, leftoverZ, gouge, gougeZ };
}

/** Target radius at z from a profile, or NaN outside it. Vertical steps keep the larger. */
export function profileRadiusAt(profile: Profile, z: number): number {
  return profileRangeAt(profile, z).hi;
}

/** Largest stock left over the target and deepest cut under it, in mm (radius). */
export function compareToProfile(r: Float32Array, shape: StockShape, profile: Profile) {
  let leftover = 0, leftoverZ = NaN, gouge = 0, gougeZ = NaN;
  if (profile.length < 2) return { leftover, leftoverZ, gouge, gougeZ };
  // The ends are where the part is faced and parted off: compare only inside them.
  const zs = profile.map(([z]) => z);
  const lo = Math.min(...zs) + shape.step, hi = Math.max(...zs) - shape.step;
  const segments = profileSegments(profile);
  for (let i = 0; i < r.length; i++) {
    const z = shape.zFront - i * shape.step;
    if (z < lo || z > hi) continue;
    const target = segmentsRangeAt(segments, z);
    if (Number.isNaN(target.hi)) continue;
    if (r[i] - target.hi > leftover) { leftover = r[i] - target.hi; leftoverZ = z; }
    if (target.lo - r[i] > gouge) { gouge = target.lo - r[i]; gougeZ = z; }
  }
  return { leftover, leftoverZ, gouge, gougeZ };
}
