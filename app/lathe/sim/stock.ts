/**
 * The workpiece as a radius at each point along its length. `r[i]` is the radius at
 * z = zFront − i·step (program coordinates, mm). Cutting lowers it under the tool's footprint.
 * A hole is a second radius, `ri[i]`, 0 where the bar is solid: inside tools raise it. Where
 * `ri[i] ≥ r[i]` there's no material left.
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

/**
 * Sweeps the footprint from `a` to `b` (x as diameter) and lowers `r`.
 * Returns the volume removed in mm³, so a rapid move through material can be reported.
 */
export function sweep(r: Float32Array, shape: StockShape, fp: Footprint, a: Point, b: Point): number {
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
        removed += Math.PI * (current * current - edge * edge) * step;
        r[i] = edge;
      }
    }
  }
  return removed;
}

/**
 * The same for an inside tool: raises `ri` to the footprint's edge, measured from the programmed
 * point toward the axis. `r` is the outside, only read, so the volume counts material that was there.
 */
export function sweepInner(ri: Float32Array, r: Float32Array, shape: StockShape, fp: Footprint, a: Point, b: Point): number {
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
        if (current < outer) removed += Math.PI * (Math.min(edge, outer) ** 2 - current * current) * step;
        ri[i] = edge;
      }
    }
  }
  return removed;
}

/** Weight in grams, with density in g/cm³, optionally only over indices [from, to), less the hole `ri`. */
export function weight(r: Float32Array, step: number, density: number, from = 0, to = r.length, ri?: Float32Array): number {
  let volume = 0;
  for (let i = Math.max(0, from); i < Math.min(r.length, to); i++) {
    const hole = ri ? Math.min(ri[i], r[i]) : 0;
    volume += r[i] * r[i] - hole * hole;
  }
  return (Math.PI * volume * step * density) / 1000;
}

/** Weight of the finished part: the stock between the ends of the target profile. */
export function partWeight(r: Float32Array, shape: StockShape, profile: Profile, density: number, ri?: Float32Array): number {
  if (profile.length < 2) return NaN;
  const zs = profile.map(([z]) => z);
  const from = Math.round((shape.zFront - Math.max(...zs)) / shape.step);
  const to = Math.round((shape.zFront - Math.min(...zs)) / shape.step);
  return weight(r, shape.step, density, from, to, ri);
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
