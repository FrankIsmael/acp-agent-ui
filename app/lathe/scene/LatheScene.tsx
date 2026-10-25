/**
 * The 3D stage: the lathe model with its chuck, carriage and cross-slide split into moving groups,
 * the workpiece, the tool, the target profile and the toolpath. Everything reads `player.t` in
 * `useFrame`, so playback never re-renders React.
 */
import { Suspense, useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Player } from '../player.ts';
import type { Timeline } from '../sim/timeline.ts';
import type { Tool } from '../sim/job-schema.ts';
import { profilePolyline } from '../sim/profile.ts';
import { JAW_FACE_X, JAW_GRIP_RADIUS, PARTS, SPINDLE_Y, SPINDLE_Z, TIP_HOME, worldX, worldZ } from './calibration.ts';
import { Workpiece } from './Workpiece.tsx';

const MODEL_URL = '/models/lathe.glb';
const MAX_VISUAL_RPM = 240; // real rpm is a blur; the readout shows the real value

export type CameraView = 'operator' | 'top' | 'tool';

export default function LatheScene({ timeline, player, view, showPath }: { timeline: Timeline; player: Player; view: CameraView; showPath: boolean }) {
  return (
    <Canvas shadows="percentage" dpr={[1, 2]} camera={{ position: [...OPERATOR.position], fov: 32, near: 0.01, far: 30 }} gl={{ antialias: true, alpha: true }}>
      <Lights />
      <Suspense fallback={null}>
        <Machine timeline={timeline} player={player} />
      </Suspense>
      <TargetProfile timeline={timeline} />
      {showPath && <Toolpath timeline={timeline} />}
      <CameraRig view={view} timeline={timeline} player={player} />
    </Canvas>
  );
}

function Lights() {
  const { gl, scene } = useThree();
  useEffect(() => {
    // The model has flat colors, so an environment map does most of the lighting work.
    const pmrem = new THREE.PMREMGenerator(gl);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 0.55;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.85;
    if (import.meta.env.DEV) Object.assign(window, { latheScene: scene, THREE });
    return () => { scene.environment = null; environment.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return (
    <>
      <directionalLight position={[2, 4, 3]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-1.5} shadow-camera-right={1.5} shadow-camera-top={1.5} shadow-camera-bottom={-1.5} />
      <ambientLight intensity={0.25} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[12, 12]} />
        <shadowMaterial opacity={0.18} />
      </mesh>
    </>
  );
}

const OPERATOR = { position: [0.12, 1.4, 0.72], target: [-0.17, 1.07, 0.06] } as const;
// From above and a little in front: on a real lathe the tool post hides the insert from the operator.
const TOOL_OFFSET = new THREE.Vector3(0.04, 0.13, 0.08);

function CameraRig({ view, timeline, player }: { view: CameraView; timeline: Timeline; player: Player }) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera } = useThree();
  const tip = (out: THREE.Vector3) => {
    const { pos } = timeline.stateAt(player.t);
    return out.set(worldX(pos.z, timeline.job.stock), SPINDLE_Y, worldZ(pos.x));
  };
  const followed = useRef(new THREE.Vector3());
  useEffect(() => {
    const target = controls.current?.target;
    if (!target) return;
    if (view === 'operator') {
      camera.position.set(...OPERATOR.position);
      target.set(...OPERATOR.target);
    } else if (view === 'top') {
      const middle = worldX(-timeline.job.stock.stickout / 2, timeline.job.stock);
      camera.position.set(middle, 1.75, SPINDLE_Z + 0.02);
      target.set(middle, SPINDLE_Y, SPINDLE_Z);
    } else {
      tip(followed.current);
      target.copy(followed.current);
      camera.position.copy(followed.current).add(TOOL_OFFSET);
    }
    controls.current?.update();
  }, [view, camera, timeline]);

  // The tool view follows the tip and keeps whatever angle the user orbited to.
  const next = useRef(new THREE.Vector3());
  useFrame(() => {
    if (view !== 'tool' || !controls.current) return;
    tip(next.current);
    const delta = next.current.clone().sub(followed.current);
    if (delta.lengthSq() === 0) return;
    camera.position.add(delta);
    controls.current.target.add(delta);
    followed.current.copy(next.current);
  });
  return <OrbitControls ref={controls} makeDefault enableDamping target={[...OPERATOR.target]} minDistance={0.04} maxDistance={6} />;
}

type Split = {
  root: THREE.Object3D;
  chuck: THREE.Group;
  carriage: THREE.Group;
  cross: THREE.Group;
  jaws: { object: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[];
};

/** Clones the model and moves the named parts into groups that can spin or slide. */
function splitModel(source: THREE.Object3D): Split {
  const root = source.clone(true);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  root.updateMatrixWorld(true);
  const chuck = new THREE.Group();
  chuck.position.set(JAW_FACE_X, SPINDLE_Y, SPINDLE_Z);
  const carriage = new THREE.Group();
  const cross = new THREE.Group();
  root.add(chuck, carriage);
  carriage.add(cross);
  root.updateMatrixWorld(true);
  const take = (names: string[], into: THREE.Object3D) =>
    names.flatMap((name) => {
      const object = root.getObjectByName(name);
      if (object) into.attach(object);
      return object ? [object] : [];
    });
  take(PARTS.chuckBody, chuck);
  take(PARTS.carriage, carriage);
  take(PARTS.crossSlide, cross);
  const jaws = take(PARTS.jaws, chuck).map((object) => {
    const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
    chuck.worldToLocal(center);
    return { object, base: object.position.clone(), dir: new THREE.Vector3(0, center.y, center.z).normalize() };
  });
  return { root, chuck, carriage, cross, jaws };
}

function Machine({ timeline, player }: { timeline: Timeline; player: Player }) {
  const { scene } = useGLTF(MODEL_URL);
  const split = useMemo(() => splitModel(scene), [scene]);
  const tool = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const { stock } = timeline.job;

  // Open or close the jaws to the bar.
  useEffect(() => {
    const open = stock.diameter / 2000 - JAW_GRIP_RADIUS;
    for (const jaw of split.jaws) jaw.object.position.copy(jaw.base).addScaledVector(jaw.dir, open);
  }, [split, stock.diameter]);

  useFrame((_, delta) => {
    const state = timeline.stateAt(player.t);
    const x = worldX(state.pos.z, stock), z = worldZ(state.pos.x);
    split.carriage.position.x = x - TIP_HOME.x;
    split.cross.position.z = z - TIP_HOME.z;
    tool.current?.position.set(x, SPINDLE_Y, z);
    const rpm = player.playing ? Math.min(state.rpm, MAX_VISUAL_RPM) : 0;
    const direction = state.spindle === 'ccw' ? 1 : -1;
    split.chuck.rotation.x += direction * (rpm / 60) * Math.PI * 2 * delta;
    if (spin.current) spin.current.rotation.x = split.chuck.rotation.x;
    if (tool.current) for (const child of tool.current.children) child.visible = child.userData.tool === state.tool;
  });

  return (
    <>
      <primitive object={split.root} />
      <group ref={spin} position={[JAW_FACE_X, SPINDLE_Y, SPINDLE_Z]}>
        <group position-x={(stock.stickout - stock.faceStock) / 1000} scale={0.001}>
          <Workpiece timeline={timeline} player={player} />
        </group>
      </group>
      <group ref={tool} name="tool">
        {timeline.job.tools.map((t) => (
          <group key={t.id} userData={{ tool: t.id }}>
            <ToolShape tool={t} />
          </group>
        ))}
      </group>
    </>
  );
}

/** Insert and holder with the programmed point at the origin; +X is program +Z, +Z is program +X. */
function ToolShape({ tool }: { tool: Tool }) {
  const insert = useMemo(() => {
    const mm = 0.001;
    const outline = new THREE.Shape();
    if (tool.type === 'parting') {
      outline.moveTo(0, 0).lineTo(tool.width * mm, 0).lineTo(tool.width * mm, 0.022).lineTo(0, 0.022).closePath();
    } else {
      const kr = (tool.approach * Math.PI) / 180;
      const e = (Math.max(1, 180 - tool.approach - tool.angle) * Math.PI) / 180;
      const L = 0.012;
      const m = [Math.sin(kr - Math.PI / 2) * L, Math.cos(kr - Math.PI / 2) * L];
      const s = [Math.cos(e) * L, Math.sin(e) * L];
      outline.moveTo(0, 0).lineTo(s[0], s[1]).lineTo(s[0] + m[0], s[1] + m[1]).lineTo(m[0], m[1]).closePath();
    }
    const geometry = new THREE.ExtrudeGeometry(outline, { depth: 0.004, bevelEnabled: false });
    // Shape (u, v) is (world x, world z); lay it flat with its top face at spindle height.
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }, [tool]);
  useEffect(() => () => insert.dispose(), [insert]);
  const parting = tool.type === 'parting';
  return (
    <>
      <mesh geometry={insert} castShadow>
        <meshStandardMaterial color={parting ? '#d9b44a' : '#d4a537'} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={parting ? [0.0015, -0.012, 0.075] : [0.012, -0.012, 0.065]} castShadow>
        <boxGeometry args={[parting ? 0.012 : 0.02, 0.016, 0.11]} />
        <meshStandardMaterial color="#3b4048" metalness={0.5} roughness={0.5} />
      </mesh>
    </>
  );
}

/** The finished shape as a ghost outline on the bar's silhouette. */
function TargetProfile({ timeline }: { timeline: Timeline }) {
  const { profile, stock } = timeline.job;
  const lines = useMemo(() => {
    if (profile.length < 2) return [];
    return [1, -1].map((side) =>
      profilePolyline(profile).map(([z, d]) => new THREE.Vector3(worldX(z, stock), SPINDLE_Y + side * (d / 2000), SPINDLE_Z + 0.0002)),
    );
  }, [profile, stock]);
  return (
    <>
      {lines.map((points, i) => (
        <Line key={i} points={points} color="#ff7a1a" lineWidth={1.5} transparent opacity={0.85} depthTest={false} renderOrder={2} />
      ))}
    </>
  );
}

/** Programmed path in the cutting plane: feeds solid, rapids dashed. */
function Toolpath({ timeline }: { timeline: Timeline }) {
  const { feeds, rapids } = useMemo(() => {
    const feeds: THREE.Vector3[] = [], rapids: THREE.Vector3[] = [];
    const at = (p: { x: number; z: number }) => new THREE.Vector3(worldX(p.z, timeline.job.stock), SPINDLE_Y + 0.0001, worldZ(p.x));
    for (const s of timeline.segments) {
      if (s.kind === 'dwell') continue;
      (s.kind === 'feed' ? feeds : rapids).push(at(s.from), at(s.to));
    }
    return { feeds, rapids };
  }, [timeline]);
  return (
    <>
      {feeds.length > 0 && <Line segments points={feeds} color="#2f9bff" lineWidth={1} transparent opacity={0.7} depthTest={false} renderOrder={1} />}
      {rapids.length > 0 && <Line segments points={rapids} color="#e04848" lineWidth={1} dashed dashSize={0.004} gapSize={0.003} transparent opacity={0.6} depthTest={false} renderOrder={1} />}
    </>
  );
}

useGLTF.preload(MODEL_URL);
