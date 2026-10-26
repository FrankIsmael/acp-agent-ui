/**
 * The bar as a surface of revolution with fixed topology: one ring of vertices per few profile
 * samples, an annulus at each end, and the hole's surface back to the front. Each frame only
 * rewrites positions and normals from the current profile; a solid bar's hole is all at the axis.
 * A face groove is a detour in the outline where it opens (down its inner wall, across the bottom,
 * up its outer wall); the rings it doesn't use are stacked on the last one, where they draw nothing.
 * Local units are mm with the axis along +X (program +Z) and x = 0 at Z0.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Player } from '../player.ts';
import type { Timeline } from '../sim/timeline.ts';

const SEGMENTS = 64;
const MAX_RINGS = 1100;

export function Workpiece({ timeline, player }: { timeline: Timeline; player: Player }) {
  const { shape } = timeline;
  const stride = Math.max(1, Math.ceil(shape.n / MAX_RINGS));
  const sideRings = Math.ceil(shape.n / stride);
  // Front hole edge, front edge, outside…, back edge, back hole edge, inside… (back to front),
  // front hole edge again to close the loop; room for a face groove's two walls and bottom.
  const rings = 4 * sideRings + 9;

  const { geometry, profile, hole, gap, ringRadius, ringHole, ringLo, ringHi } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const count = rings * (SEGMENTS + 1);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let ring = 0; ring + 1 < rings; ring++)
      for (let s = 0; s < SEGMENTS; s++) {
        const a = ring * (SEGMENTS + 1) + s, b = a + SEGMENTS + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    geometry.setIndex(index);
    return {
      geometry, profile: new Float32Array(shape.n), hole: new Float32Array(shape.n),
      gap: { lo: new Float32Array(shape.n), hi: new Float32Array(shape.n) },
      ringRadius: new Float32Array(sideRings), ringHole: new Float32Array(sideRings),
      ringLo: new Float32Array(sideRings), ringHi: new Float32Array(sideRings),
    };
  }, [rings, shape.n, sideRings]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const drawn = useRef<{ t: number; timeline: Timeline | null }>({ t: -1, timeline: null });
  useFrame(() => {
    if (player.t === drawn.current.t && timeline === drawn.current.timeline) return;
    drawn.current = { t: player.t, timeline };
    timeline.profileAt(player.t, profile, hole, timeline.grooved ? gap : undefined);

    // The smallest radius in each ring's window and the largest hole, so narrow grooves still show;
    // the face groove likewise at its widest.
    for (let k = 0; k < sideRings; k++) {
      let min = Infinity, max = 0, lo = Infinity, hi = 0;
      for (let i = k * stride; i < Math.min(shape.n, (k + 1) * stride); i++) {
        min = Math.min(min, profile[i]);
        max = Math.max(max, hole[i]);
        if (gap.hi[i] > gap.lo[i]) [lo, hi] = [Math.min(lo, gap.lo[i]), Math.max(hi, gap.hi[i])];
      }
      ringRadius[k] = min;
      ringHole[k] = Math.min(max, min);
      const open = timeline.grooved && hi > lo && lo > ringHole[k] && hi < min;
      ringLo[k] = open ? lo : 0;
      ringHi[k] = open ? hi : 0;
    }
    // Where no material is left (faced off, parted through) both surfaces sit at the hole of the
    // material behind it, so the step to it is an annulus around the hole, not a disc over it.
    let near = -1;
    for (let k = sideRings - 1; k >= 0; k--) {
      if (ringRadius[k] - ringHole[k] > 1e-4) near = ringHole[k];
      else if (near >= 0) ringRadius[k] = ringHole[k] = near;
    }
    const pos = geometry.attributes.position.array as Float32Array;
    const nor = geometry.attributes.normal.array as Float32Array;
    const ringX = (k: number) => shape.zFront - Math.min(shape.n - 1, k * stride) * shape.step;
    let ring = 0;
    const write = (x: number, r: number, nx: number, nr: number) => {
      if (ring >= rings) return; // grooves cut in many pieces at once: the rest isn't drawn
      const len = Math.hypot(nx, nr) || 1;
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        const o = (ring * (SEGMENTS + 1) + s) * 3;
        pos[o] = x; pos[o + 1] = r * c; pos[o + 2] = r * sn;
        nor[o] = nx / len; nor[o + 1] = (nr / len) * c; nor[o + 2] = (nr / len) * sn;
      }
      ring++;
    };
    const last = sideRings - 1;
    // Between rings a…b (a groove's walls only have neighbors inside the groove).
    const slope = (radii: Float32Array, k: number, a = 0, b = last) => {
      const dr = radii[Math.max(a, k - 1)] - radii[Math.min(b, k + 1)];
      const dx = ringX(Math.max(a, k - 1)) - ringX(Math.min(b, k + 1));
      return dx === 0 ? 0 : dr / dx;
    };
    const open = (k: number) => ringHi[k] > ringLo[k];
    write(ringX(0), ringHole[0], 1, 0);
    write(ringX(0), ringRadius[0], 1, 0);
    for (let k = 0; k < sideRings; k++) {
      if (open(k) && !(k > 0 && open(k - 1))) {
        let end = k;
        while (end < last && open(end + 1)) end++;
        // Down the inner wall (facing out), across the bottom (facing the front), up the outer
        // wall (facing the axis), then out along the face to the outside.
        for (let j = k; j <= end; j++) write(ringX(j), ringLo[j], -slope(ringLo, j, k, end), 1);
        write(ringX(end), ringLo[end], 1, 0);
        write(ringX(end), ringHi[end], 1, 0);
        for (let j = end; j >= k; j--) write(ringX(j), ringHi[j], slope(ringHi, j, k, end), -1);
        write(ringX(k), ringHi[k], 1, 0);
        write(ringX(k), ringRadius[k], 1, 0);
      }
      write(ringX(k), ringRadius[k], -slope(ringRadius, k), 1);
    }
    write(ringX(last), ringRadius[last], -1, 0);
    write(ringX(last), ringHole[last], -1, 0);
    // The hole's surface faces the axis.
    for (let k = last; k >= 0; k--) write(ringX(k), ringHole[k], slope(ringHole, k), -1);
    while (ring < rings) write(ringX(0), ringHole[0], 1, 0);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    geometry.computeBoundingSphere();
  });

  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color="#c3c8cf" metalness={0.85} roughness={0.32} />
    </mesh>
  );
}
