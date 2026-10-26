/**
 * The face groove: a ring cut into the part from the front with a face grooving tool, around
 * whatever stands in the middle (a queen's dome inside her crown, a seal groove in a flange). The
 * job describes its bottom as `[z, diameter]` points from the inner wall out to the outer one,
 * the diameter never falling; `[z, diameter, R]` makes the segment ending there an arc of radius
 * |R|, dipping toward the chuck (a hollow) when R < 0 and rising toward the front when R > 0.
 * Everything in front of that bottom, between its first and last diameter, is cut away, so the
 * walls run straight to the front from the first and the last point.
 *
 * The bottom has to go down from the inner wall and back up once: the simulator keeps one ring
 * per z (sim/stock.ts), so a ridge in the middle (two grooves) can't be held.
 */
import { arcRadiusAt, arcThrough, profileRangeAt, type Arc, type Profile } from './profile.ts';
import type { Gap, StockShape } from './stock.ts';

export const MIN_WALL_MM = 1; // per side, between the groove and the outside or the hole
const MAX_SAMPLES = 4001; // a groove of any size samples coarser, not longer (the job comes from outside)

type Segment = { r0: number; z0: number; r1: number; z1: number; arc?: Arc };

// Arcs reuse the profile's geometry with the axes turned: u = −radius (walking out from the
// axis is walking toward the chuck there) and v = z, so R > 0 still bulges to +v, the front.
function segments(groove: Profile): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < groove.length; i++) {
    const [z0, d0] = groove[i - 1], [z1, d1, R] = groove[i];
    const segment: Segment = { r0: d0 / 2, z0, r1: d1 / 2, z1 };
    if (R && d1 !== d0) segment.arc = arcThrough(-d0 / 2, z0, -d1 / 2, z1, R);
    out.push(segment);
  }
  return out;
}

/** The bottom's z at radius r, or NaN outside the groove. At a wall, its top (the shallower). */
export function floorAt(groove: Profile, r: number): number {
  return floorOf(segments(groove), r);
}

function floorOf(list: Segment[], r: number): number {
  let z = NaN;
  for (const { r0, z0, r1, z1, arc } of list) {
    if (r < r0 - 1e-9 || r > r1 + 1e-9) continue;
    const v = r1 === r0 ? Math.max(z0, z1) : arc ? arcRadiusAt(arc, -r) : z0 + ((z1 - z0) * (r - r0)) / (r1 - r0);
    z = Number.isNaN(z) ? v : Math.max(z, v);
  }
  return z;
}

/** The bottom sampled every `step` mm of radius, from the inner wall to the outer one. */
export type Floor = { r0: number; r1: number; step: number; z: Float64Array };

export function sampleFloor(groove: Profile, step: number): Floor {
  const list = segments(groove);
  const r0 = groove[0][1] / 2, r1 = groove[groove.length - 1][1] / 2;
  const n = Math.min(MAX_SAMPLES, Math.max(1, Math.round((r1 - r0) / step)) + 1);
  const z = new Float64Array(n);
  for (let j = 0; j < n; j++) z[j] = floorOf(list, Math.min(r1, r0 + j * step));
  return { r0, r1, step: (r1 - r0) / (n - 1 || 1), z };
}

/** The bottom as `[z, diameter]` points, inner wall to outer wall, for drawing. */
export function faceGroovePolyline(groove: Profile, step = 0.1): [number, number][] {
  if (groove.length < 2) return [];
  const floor = sampleFloor(groove, step);
  return [[groove[0][0], groove[0][1]], ...Array.from(floor.z, (z, j): [number, number] => [z, 2 * (floor.r0 + j * floor.step)]), [groove[groove.length - 1][0], groove[groove.length - 1][1]]];
}

/** Where the groove is at z (radius, inner and outer wall), or undefined in front of its bottom. */
export function gapAt(floor: Floor, z: number): { lo: number; hi: number } | undefined {
  let a = -1, b = -1;
  for (let j = 0; j < floor.z.length; j++) {
    if (floor.z[j] > z + 1e-9) continue;
    if (a < 0) a = j;
    b = j;
  }
  if (a < 0) return undefined;
  return { lo: floor.r0 + a * floor.step, hi: floor.r0 + b * floor.step };
}

const mm = (value: number) => Number(value.toFixed(2));

/** What is wrong with the face groove, against itself, the profile and the bore; worded for the agent. */
export function faceGrooveProblems(groove: Profile, profile: Profile, bore: Profile): string[] {
  if (!groove.length) return [];
  if (groove.length < 2) return ['faceGroove: needs at least two [z, diameter] points (the bottom, inner wall first), or leave it out'];
  const problems: string[] = [];
  if (groove.some(([z]) => z > 1e-9)) problems.push('faceGroove: every z must be at or behind the finished front face (z ≤ 0)');
  if (groove.some(([, d]) => d <= 0)) problems.push('faceGroove: every diameter must be over 0; a hole at the center is the bore');
  if (groove.some(([, d], i) => i > 0 && d < groove[i - 1][1]))
    problems.push('faceGroove: the diameter must never fall from one point to the next (the bottom from the inner wall out to the outer one)');
  if (groove[groove.length - 1][1] <= groove[0][1]) problems.push('faceGroove: the last diameter (the outer wall) must be larger than the first (the inner wall)');
  for (let i = 1; i < groove.length; i++) {
    const [z0, d0] = groove[i - 1], [z1, d1, R] = groove[i];
    if (!R) continue;
    const at = `the arc to point ${i} ([${groove[i].join(', ')}])`;
    if (d1 === d0) {
      problems.push(`faceGroove: ${at} is a straight wall, which can't be an arc; drop R`);
      continue;
    }
    const arc = arcThrough(-d0 / 2, z0, -d1 / 2, z1, R);
    if (!arc) problems.push(`faceGroove: ${at} is too tight for its chord; use |R| ≥ ${Math.ceil((Math.hypot((d1 - d0) / 2, z1 - z0) / 2) * 100) / 100}`);
    else if ([z0, z1].some((z) => arc.up * (z - arc.cv) < -1e-6)) {
      // The usual cause: a round corner squeezed into less diameter than a quarter circle needs.
      const dz = Math.abs(z1 - z0);
      const room = z1 > z0 ? `start it at Ø${mm(d1 - 2 * dz)}` : `end it at Ø${mm(d0 + 2 * dz)}`;
      problems.push(
        `faceGroove: ${at} would curl back over itself (an undercut a face grooving tool can't reach). ` +
          `A round corner between a wall and the bottom is a quarter circle, R ${mm(-dz)} with the diameter changing by 2 × ΔZ: ${room}, ` +
          `or round less of it (a straight wall point first); a larger |R| makes it a slanted wall instead` +
          (R > 0 ? '. R > 0 bulges toward the front; the bowl\'s round corners, going down or coming back up, are R < 0' : ''),
      );
    }
  }
  if (problems.length) return problems;

  const floor = sampleFloor(groove, 0.02);
  // Down, then up: once the bottom has risen it may not go down again.
  let rising = false;
  for (let j = 1; j < floor.z.length; j++) {
    if (floor.z[j] > floor.z[j - 1] + 1e-6) rising = true;
    else if (rising && floor.z[j] < floor.z[j - 1] - 1e-6) {
      problems.push(
        `faceGroove: its bottom rises and then falls again at Ø${mm(2 * (floor.r0 + j * floor.step))}: that is a ridge between two grooves, and the simulator holds one; ` +
          'make it one groove (one low point), or leave the ridge out',
      );
      return problems;
    }
  }
  if (profile.length < 2) return problems;

  // The walls left on each side, from the bottom to the front.
  const deepest = Math.min(...floor.z);
  const dz = Math.max(0.25, -deepest / 400);
  for (let k = 0, z = deepest + 0.05; k <= 400 && z <= 0; k++, z = deepest + 0.05 + k * dz) {
    const gap = gapAt(floor, z);
    if (!gap) continue;
    const outer = profileRangeAt(profile, z).hi;
    if (Number.isNaN(outer) || outer <= gap.lo) continue; // in front of the part there: nothing to cut
    if (outer < gap.hi + MIN_WALL_MM - 1e-6) {
      problems.push(
        `faceGroove: at Z${mm(z)} it reaches Ø${mm(2 * gap.hi)} and the outside is Ø${mm(2 * outer)}, a wall of ${mm(Math.max(0, outer - gap.hi))} mm; ` +
          `keep at least ${MIN_WALL_MM} mm (a narrower groove or a larger outside there)`,
      );
      break;
    }
    const hole = bore.length >= 2 ? profileRangeAt(bore, z).hi : NaN;
    if (!Number.isNaN(hole) && hole > gap.lo - MIN_WALL_MM + 1e-6) {
      problems.push(
        `faceGroove: at Z${mm(z)} its inner wall is Ø${mm(2 * gap.lo)} and the bore is Ø${mm(2 * hole)}; keep at least ${MIN_WALL_MM} mm between them`,
      );
      break;
    }
  }
  const top = profileRangeAt(profile, deepest).hi;
  if (Number.isNaN(top) || top <= floor.r1) problems.push(`faceGroove: its bottom (Z${mm(deepest)}) is outside the part; put it where the profile is wider than Ø${mm(2 * floor.r1 + 2 * MIN_WALL_MM)}`);
  return problems;
}

/**
 * The cut groove against the target, in mm: the most material left in it and the deepest cut past
 * it, with where (z and diameter). The bottom is measured along Z where it is flatter than 45°, the
 * walls across where they are steeper, and the walls only where the part stands on both sides.
 */
export function compareToFaceGroove(r: Float32Array, ri: Float32Array, gap: Gap, shape: StockShape, groove: Profile, profile: Profile) {
  const result = { leftover: 0, leftoverZ: NaN, leftoverD: NaN, gouge: 0, gougeZ: NaN, gougeD: NaN };
  if (groove.length < 2) return result;
  const { step, zFront, n } = shape;
  const floor = sampleFloor(groove, step);
  const solid = (i: number, rho: number) => rho < r[i] && rho > ri[i] && !(rho > gap.lo[i] && rho < gap.hi[i]);
  const note = (excess: number, z: number, rho: number) => {
    if (excess > result.leftover) Object.assign(result, { leftover: excess, leftoverZ: z, leftoverD: 2 * rho });
    if (-excess > result.gouge) Object.assign(result, { gouge: -excess, gougeZ: z, gougeD: 2 * rho });
  };
  // The bottom: from the front down to the first material, at each radius.
  for (let j = 1; j < floor.z.length - 1; j++) {
    const slope = Math.abs(floor.z[j + 1] - floor.z[j - 1]) / (2 * floor.step);
    if (slope > 1) continue;
    const rho = floor.r0 + j * floor.step;
    let i = 0;
    while (i < n && !solid(i, rho)) i++;
    const cut = zFront - i * step + step / 2;
    note((cut - floor.z[j]) / Math.hypot(1, slope), floor.z[j], rho);
  }
  // The walls: the air around the groove's middle at each z, against the target's walls.
  const deepest = Math.min(...floor.z);
  for (let i = 0; i < n; i++) {
    const z = zFront - i * step;
    if (z > 0 || z < deepest + step) continue;
    const want = gapAt(floor, z);
    if (!want || !(profileRangeAt(profile, z).hi > want.hi + step)) continue;
    const mid = (want.lo + want.hi) / 2;
    const [lo, hi] = mid >= r[i] ? [r[i], Infinity] : mid <= ri[i] ? [0, ri[i]] : mid > gap.lo[i] && mid < gap.hi[i] ? [gap.lo[i], gap.hi[i]] : [mid, mid];
    const steep = (rho: number) => {
      const j = Math.min(floor.z.length - 2, Math.max(1, Math.round((rho - floor.r0) / floor.step)));
      return Math.abs(floor.z[j + 1] - floor.z[j - 1]) / (2 * floor.step) > 1 || rho <= floor.r0 + floor.step || rho >= floor.r1 - floor.step;
    };
    if (steep(want.lo)) note(lo - want.lo, z, want.lo);
    if (steep(want.hi) && hi < Infinity) note(want.hi - hi, z, want.hi); // the outside cut away is the profile's to report
  }
  return result;
}
