/**
 * The workpiece as a radius at each point along its length. `r[i]` is the radius at
 * z = zFront − i·step (program coordinates, mm). Cutting lowers it under the tool's footprint.
 */
import type { Footprint } from './tool-shapes.ts';
import type { Point } from './gcode/plan.ts';

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

/** Weight in grams, with density in g/cm³, optionally only over indices [from, to). */
export function weight(r: Float32Array, step: number, density: number, from = 0, to = r.length): number {
  let volume = 0;
  for (let i = Math.max(0, from); i < Math.min(r.length, to); i++) volume += r[i] * r[i];
  return (Math.PI * volume * step * density) / 1000;
}

/** Weight of the finished part: the stock between the ends of the target profile. */
export function partWeight(r: Float32Array, shape: StockShape, profile: [number, number][], density: number): number {
  if (profile.length < 2) return NaN;
  const zs = profile.map(([z]) => z);
  const from = Math.round((shape.zFront - Math.max(...zs)) / shape.step);
  const to = Math.round((shape.zFront - Math.min(...zs)) / shape.step);
  return weight(r, shape.step, density, from, to);
}

/** Target radius at z from a [z, diameter] profile, or NaN outside it. Vertical steps keep the larger. */
export function profileRadiusAt(profile: [number, number][], z: number): number {
  return profileRangeAt(profile, z).hi;
}

/** Smallest and largest target radius at z: they differ on a vertical step, where both are right. */
export function profileRangeAt(profile: [number, number][], z: number): { lo: number; hi: number } {
  let lo = NaN, hi = NaN;
  for (let j = 0; j + 1 < profile.length; j++) {
    const [z0, d0] = profile[j];
    const [z1, d1] = profile[j + 1];
    if (z < Math.min(z0, z1) - 1e-9 || z > Math.max(z0, z1) + 1e-9) continue;
    const a = z1 === z0 ? Math.min(d0, d1) / 2 : (d0 + ((d1 - d0) * (z - z0)) / (z1 - z0)) / 2;
    const b = z1 === z0 ? Math.max(d0, d1) / 2 : a;
    lo = Number.isNaN(lo) ? a : Math.min(lo, a);
    hi = Number.isNaN(hi) ? b : Math.max(hi, b);
  }
  return { lo, hi };
}

/** Largest stock left over the target and deepest cut under it, in mm (radius). */
export function compareToProfile(r: Float32Array, shape: StockShape, profile: [number, number][]) {
  let leftover = 0, leftoverZ = NaN, gouge = 0, gougeZ = NaN;
  if (profile.length < 2) return { leftover, leftoverZ, gouge, gougeZ };
  // The ends are where the part is faced and parted off: compare only inside them.
  const zs = profile.map(([z]) => z);
  const lo = Math.min(...zs) + shape.step, hi = Math.max(...zs) - shape.step;
  for (let i = 0; i < r.length; i++) {
    const z = shape.zFront - i * shape.step;
    if (z < lo || z > hi) continue;
    const target = profileRangeAt(profile, z);
    if (Number.isNaN(target.hi)) continue;
    if (r[i] - target.hi > leftover) { leftover = r[i] - target.hi; leftoverZ = z; }
    if (target.lo - r[i] > gouge) { gouge = target.lo - r[i]; gougeZ = z; }
  }
  return { leftover, leftoverZ, gouge, gougeZ };
}
