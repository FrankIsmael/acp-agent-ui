/**
 * The bar as a surface of revolution with fixed topology: one ring of vertices per few profile
 * samples, an annulus at each end, and the hole's surface back to the front. Each frame only
 * rewrites positions and normals from the current profile; a solid bar's hole is all at the axis.
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
  // front hole edge again to close the loop.
  const rings = 2 * sideRings + 5;

  const { geometry, profile, hole, ringRadius, ringHole } = useMemo(() => {
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
      ringRadius: new Float32Array(sideRings), ringHole: new Float32Array(sideRings),
    };
  }, [rings, shape.n, sideRings]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const drawn = useRef<{ t: number; timeline: Timeline | null }>({ t: -1, timeline: null });
  useFrame(() => {
    if (player.t === drawn.current.t && timeline === drawn.current.timeline) return;
    drawn.current = { t: player.t, timeline };
    timeline.profileAt(player.t, profile, hole);

    // The smallest radius in each ring's window and the largest hole, so narrow grooves still show.
    for (let k = 0; k < sideRings; k++) {
      let min = Infinity, max = 0;
      for (let i = k * stride; i < Math.min(shape.n, (k + 1) * stride); i++) {
        min = Math.min(min, profile[i]);
        max = Math.max(max, hole[i]);
      }
      ringRadius[k] = min;
      ringHole[k] = Math.min(max, min);
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
    const write = (ring: number, x: number, r: number, nx: number, nr: number) => {
      const len = Math.hypot(nx, nr) || 1;
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        const o = (ring * (SEGMENTS + 1) + s) * 3;
        pos[o] = x; pos[o + 1] = r * c; pos[o + 2] = r * sn;
        nor[o] = nx / len; nor[o + 1] = (nr / len) * c; nor[o + 2] = (nr / len) * sn;
      }
    };
    const last = sideRings - 1;
    const slope = (radii: Float32Array, k: number) => {
      const dr = radii[Math.max(0, k - 1)] - radii[Math.min(last, k + 1)];
      const dx = ringX(Math.max(0, k - 1)) - ringX(Math.min(last, k + 1));
      return dx === 0 ? 0 : dr / dx;
    };
    write(0, ringX(0), ringHole[0], 1, 0);
    write(1, ringX(0), ringRadius[0], 1, 0);
    for (let k = 0; k < sideRings; k++) write(k + 2, ringX(k), ringRadius[k], -slope(ringRadius, k), 1);
    write(sideRings + 2, ringX(last), ringRadius[last], -1, 0);
    write(sideRings + 3, ringX(last), ringHole[last], -1, 0);
    // The hole's surface faces the axis.
    for (let k = last; k >= 0; k--) write(sideRings + 4 + (last - k), ringX(k), ringHole[k], slope(ringHole, k), -1);
    write(rings - 1, ringX(0), ringHole[0], 1, 0);
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
