/**
 * The target profile: `[z, diameter]` points from the front face toward the chuck, joined by
 * straight lines, or by an arc when a point has a third value, `[z, diameter, R]`: the segment
 * that ends at that point is an arc of radius |R|, bulging outward (away from the axis, a bead or
 * a dome) when R > 0 and inward (a cove) when R < 0. Geometry here is in radius, not diameter.
 */
export type ProfilePoint = [z: number, d: number, r?: number];
export type Profile = ProfilePoint[];

export type Arc = { cu: number; cv: number; radius: number; up: 1 | -1 }; // center (z, radius)
export type ProfileSegment = { z0: number; r0: number; z1: number; r1: number; arc?: Arc };

/**
 * The arc from (z0, r0) to (z1, r1) with radius |R|. Walking toward the chuck the part is on the
 * left, so a positive R (bulging outward, to the right) has its center on the left of the chord.
 * Undefined when the radius is too small for the chord.
 */
export function arcThrough(z0: number, r0: number, z1: number, r1: number, R: number): Arc | undefined {
  const du = z1 - z0, dv = r1 - r0;
  const d = Math.hypot(du, dv);
  const radius = Math.abs(R);
  if (d === 0 || radius < d / 2 - 1e-6) return undefined;
  const h = Math.sqrt(Math.max(0, radius * radius - (d / 2) ** 2));
  const side = R > 0 ? 1 : -1;
  const cu = (z0 + z1) / 2 + side * (-dv / d) * h;
  const cv = (r0 + r1) / 2 + side * (du / d) * h;
  // Which half of the circle the arc is on: the side its middle point bulges to, away from the center.
  return { cu, cv, radius, up: -side * du >= 0 ? 1 : -1 };
}

/** Radius of the arc at z, on its half of the circle. */
export function arcRadiusAt(arc: Arc, z: number): number {
  return arc.cv + arc.up * Math.sqrt(Math.max(0, arc.radius ** 2 - (z - arc.cu) ** 2));
}

export function profileSegments(profile: Profile): ProfileSegment[] {
  const segments: ProfileSegment[] = [];
  for (let i = 1; i < profile.length; i++) {
    const [z0, d0] = profile[i - 1], [z1, d1, R] = profile[i];
    const segment: ProfileSegment = { z0, r0: d0 / 2, z1, r1: d1 / 2 };
    if (R) segment.arc = arcThrough(z0, d0 / 2, z1, d1 / 2, R);
    segments.push(segment);
  }
  return segments;
}

/** Why an arc with radius R from (z0, r0) to (z1, r1) can't be turned, or undefined when it can. */
function arcFault(z0: number, r0: number, z1: number, r1: number, R: number): 'small' | 'curl' | 'axis' | undefined {
  const arc = arcThrough(z0, r0, z1, r1, R);
  if (!arc) return 'small';
  // A turned profile has one radius per z: the arc can't run past a vertical tangent.
  if (z0 === z1 || [r0, r1].some((r) => arc.up * (r - arc.cv) < -1e-6)) return 'curl';
  if (arcRadiusAt(arc, (z0 + z1) / 2) < 0) return 'axis';
}

/** The smallest |R| (same sign as R, rounded up to 0.01) that makes the arc turnable. */
function smallestTurnableRadius(z0: number, r0: number, z1: number, r1: number, R: number): number | undefined {
  if (z0 === z1) return undefined;
  const sign = Math.sign(R);
  let lo = Math.hypot(z1 - z0, r1 - r0) / 2, hi = Math.max(lo, 1);
  while (arcFault(z0, r0, z1, r1, sign * hi)) if ((hi *= 2) > 1e5) return undefined;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (arcFault(z0, r0, z1, r1, sign * mid)) lo = mid;
    else hi = mid;
  }
  return sign * Math.ceil(hi * 100 - 1e-6) / 100;
}

/** What is wrong with the profile's arcs, worded for the agent. */
export function arcProblems(profile: Profile): string[] {
  const problems: string[] = [];
  for (let i = 1; i < profile.length; i++) {
    const [z0, d0] = profile[i - 1], [z1, d1, R] = profile[i];
    if (!R) continue;
    const fault = arcFault(z0, d0 / 2, z1, d1 / 2, R);
    if (!fault) continue;
    const point = `the arc to point ${i} ([${profile[i].join(', ')}])`;
    if (z0 === z1) {
      problems.push(`profile: ${point} is a vertical step, which can't be an arc; drop R`);
      continue;
    }
    const min = smallestTurnableRadius(z0, d0 / 2, z1, d1 / 2, R);
    const fix = min === undefined ? 'split it at its widest point' : `use |R| ≥ ${Math.abs(min)}`;
    // From the axis (a dome or a ball end) the smallest radius is the one centered on the axis.
    const dome = min !== undefined && R > 0 && (d0 === 0 || d1 === 0) ? `; R ${min} gives a smooth round top, a larger R a flatter, slightly pointed one` : '';
    const why = { small: 'is too tight for its chord', curl: "would curl back in Z (an overhang a lathe can't cut)", axis: 'goes through the axis' }[fault];
    problems.push(`profile: ${point} ${why}; ${fix}${dome}`);
  }
  return problems;
}

/** Smallest and largest target radius at z: they differ on a vertical step, where both are right. */
export function profileRangeAt(profile: Profile, z: number): { lo: number; hi: number } {
  return segmentsRangeAt(profileSegments(profile), z);
}

export function segmentsRangeAt(segments: ProfileSegment[], z: number): { lo: number; hi: number } {
  let lo = NaN, hi = NaN;
  for (const { z0, r0, z1, r1, arc } of segments) {
    if (z < Math.min(z0, z1) - 1e-9 || z > Math.max(z0, z1) + 1e-9) continue;
    let a: number, b: number;
    if (z1 === z0) [a, b] = [Math.min(r0, r1), Math.max(r0, r1)];
    else a = b = arc ? arcRadiusAt(arc, z) : r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    lo = Number.isNaN(lo) ? a : Math.min(lo, a);
    hi = Number.isNaN(hi) ? b : Math.max(hi, b);
  }
  return { lo, hi };
}

/** The profile as `[z, diameter]` points, arcs as chords of at most `stepDeg`, for drawing. */
export function profilePolyline(profile: Profile, stepDeg = 3): [number, number][] {
  if (!profile.length) return [];
  const out: [number, number][] = [[profile[0][0], profile[0][1]]];
  for (const segment of profileSegments(profile)) {
    const { arc } = segment;
    if (arc) {
      const a0 = Math.atan2(segment.r0 - arc.cv, segment.z0 - arc.cu);
      let sweep = Math.atan2(segment.r1 - arc.cv, segment.z1 - arc.cu) - a0;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (sweep < -Math.PI) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ((stepDeg * Math.PI) / 180)));
      for (let i = 1; i < steps; i++) {
        const a = a0 + (sweep * i) / steps;
        out.push([arc.cu + arc.radius * Math.cos(a), 2 * (arc.cv + arc.radius * Math.sin(a))]);
      }
    }
    out.push([segment.z1, 2 * segment.r1]);
  }
  return out;
}
