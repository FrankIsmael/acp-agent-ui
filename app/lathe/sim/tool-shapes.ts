/**
 * Cutting footprints. The part is round and only turned on the outside, so a tool is fully
 * described by its lower edge: for each axial offset `dz` from the programmed point (toward +Z,
 * away from the chuck), how far above that point the tool's cutting edge sits (`dr`, radius).
 * Anything above that edge is removed.
 *
 * Turning tools are programmed by the imaginary tip (tip direction 3): a G1 X30 turns Ø30 and a
 * shoulder at Z-12 lands at Z-12; only tapers and arcs show the nose radius, as on a real machine
 * without nose compensation.
 */
import type { Tool } from './job-schema.ts';

export type Footprint = { step: number; dr: Float32Array }; // dr[k] at dz = k * step

export const INSERT_EDGE_MM = 8; // length of the trailing edge that is modeled

// End cutting edge angle, in degrees: what the insert's corner leaves after the lead angle. A
// turning tool can only go down a wall facing the chuck that is shallower than this.
export const endEdgeAngle = (tool: Extract<Tool, { type: 'turning' }>) => Math.max(1, 180 - tool.approach - tool.angle);

export function footprint(tool: Tool, step: number): Footprint {
  if (tool.type === 'parting') {
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
