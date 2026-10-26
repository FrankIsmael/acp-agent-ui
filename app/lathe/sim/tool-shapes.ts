/**
 * Cutting footprints. The part is round, so a tool is fully described by the edge it cuts with:
 * for each axial offset `dz` from the programmed point (toward +Z, away from the chuck), how far
 * that edge sits from the point (`dr`, radius), away from the material. An outside tool's edge is
 * `dr` above the point and removes everything above it; an inside tool (drill, boring bar,
 * internal grooving tool) is the mirror image: its edge is `dr` toward the axis and it removes
 * everything below it, from the axis out. A drill's point is negative `dr`: it reaches out to its
 * radius behind the tip, at the center of the hole.
 *
 * Turning tools are programmed by the imaginary tip (tip direction 3): a G1 X30 turns Ø30 and a
 * shoulder at Z-12 lands at Z-12; only tapers and arcs show the nose radius, as on a real machine
 * without nose compensation.
 */
import type { Tool } from './job-schema.ts';

export type Footprint = { step: number; dr: Float32Array }; // dr[k] at dz = k * step

export const INSERT_EDGE_MM = 8; // length of the trailing edge that is modeled

export type InsideTool = Extract<Tool, { type: 'drill' | 'boring' | 'internal-grooving' }>;

export const isInside = (tool: Tool): tool is InsideTool => tool.type === 'drill' || tool.type === 'boring' || tool.type === 'internal-grooving';

export type FaceTool = Extract<Tool, { type: 'face-grooving' }>;

/** A face grooving tool cuts a ring along Z (sim/stock.ts, sweepFace), not with a footprint. */
export const isFace = (tool: Tool): tool is FaceTool => tool.type === 'face-grooving';

/** How deep from the front face an inside tool can go: its own `reach`, or a usual one for its size. */
export const toolReach = (tool: InsideTool) =>
  tool.reach ?? (tool.type === 'drill' ? 5 * tool.diameter : tool.type === 'boring' ? 4 * tool.minBore : 2.5 * tool.minBore);

// End cutting edge angle, in degrees: what the insert's corner leaves after the lead angle. A
// turning tool can only go down a wall facing the chuck that is shallower than this (a boring bar,
// a wall facing the chuck inside the bore).
export const endEdgeAngle = (tool: Extract<Tool, { type: 'turning' | 'boring' }>) => Math.max(1, 180 - tool.approach - tool.angle);

export function footprint(tool: Tool, step: number): Footprint {
  if (tool.type === 'drill') {
    // The point: each lip at half the point angle from the axis, then the full diameter.
    const radius = tool.diameter / 2;
    const slope = Math.tan((Math.min(179, tool.pointAngle) / 2) * (Math.PI / 180));
    const n = Math.round(radius / slope / step + 1 / step) + 1;
    const dr = new Float32Array(n);
    for (let k = 0; k < n; k++) dr[k] = -Math.min(radius, k * step * slope);
    return { step, dr };
  }
  if (tool.type === 'face-grooving') return { step, dr: new Float32Array(1) }; // unused, see isFace
  if (tool.type === 'parting' || tool.type === 'internal-grooving') {
    const n = Math.max(1, Math.round(tool.width / step) + 1);
    return { step, dr: new Float32Array(n) }; // flat bottom, square corners
  }
  const rn = tool.noseRadius;
  const e = (endEdgeAngle(tool) * Math.PI) / 180;
  const n = Math.round((rn + INSERT_EDGE_MM) / step) + 1;
  const dr = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const d = k * step - rn; // from the nose center
    dr[k] =
      d <= rn * Math.sin(e)
        ? rn - Math.sqrt(Math.max(0, rn * rn - d * d))
        : rn - rn * Math.cos(e) + (d - rn * Math.sin(e)) * Math.tan(e);
  }
  return { step, dr };
}
