# Machine models for Three.js

The two machine models from the old Unity project `Centro_Maquinado`, converted to glTF so they can be used with Three.js. The lathe is what the `/lathe` simulator loads (see [`../plan.md`](../plan.md)). The original Unity project is unchanged.

**Where the files are in this repo:**
- `public/models/lathe.glb`: the lathe (called `trn.glb` below and in the converter commands). The app serves it at `/models/lathe.glb`.
- `docs/lathe/models/CNC.glb`: the machining center. The simulator doesn't use it.
- `docs/lathe/models/fbx2glb.mjs`: the converter.

| File | Machine | Size (W × H × D) | Meshes | Triangles | Materials | File size |
|---|---|---|---|---|---|---|
| `CNC.glb` | Vertical machining center (*Centro de Maquinado Vertical*) | 3490 × 2842 × 2589 mm | 45 | ~15,500 | 36 | 1.5 MB |
| `trn.glb` (`public/models/lathe.glb`) | Bench lathe (*Torno*, `TORNO_COMPLETO`) | 1817 × 1247 × 927 mm | 141 | ~15,800 | 9 | 1.6 MB |
| `fbx2glb.mjs` | The converter script used to make both files | | | | | |

Both models are ready to drop into a scene:

- **Units:** meters (1 unit = 1 m), at real-world size.
- **Up axis:** Y, the Three.js default.
- **Position:** centered on X/Z, with the lowest point at `y = 0`, so they sit on the floor.
- **Front:** the operator side faces **+Z**, toward a default camera.
- **Materials:** `MeshStandardMaterial` (PBR) with flat colors. There are no textures, because the originals had none.
- **Not included:** animations, cameras and lights.

A live viewer with both machines and rotation controls is at https://claude.ai/artifact/WadknGQF79AUuk3yaxeLeU. It's private unless you share it.

---

## 1. Using the models in your app

### Install

```bash
npm install three
```

### Minimal scene

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe4ea);

// The models have plain colors, so an environment map does most of the lighting work
scene.environment = new THREE.PMREMGenerator(renderer)
  .fromScene(new RoomEnvironment(), 0.04).texture;

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(4, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 });
scene.add(sun);

// Floor that only shows shadows
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.2 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
camera.position.set(4, 2.5, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;

new GLTFLoader().load('/models/CNC.glb', (gltf) => {
  const cnc = gltf.scene;
  cnc.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  scene.add(cnc);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
```

Copy the `.glb` files to wherever your app serves static files (`public/models/` in this app, as in Vite or Next.js), and load them by their URL. In this app the lathe is `/models/lathe.glb`.

### Placing both machines

Both models sit at the origin, so move one of them:

```js
const loader = new GLTFLoader();
const [cnc, lathe] = await Promise.all([
  loader.loadAsync('/models/CNC.glb'),
  loader.loadAsync('/models/trn.glb'),
]).then((r) => r.map((g) => g.scene));

lathe.position.set(3.2, 0, 0.5);   // meters
scene.add(cnc, lathe);
```

### Rotating a model and showing the angle

Use Euler order `'ZYX'`. In Three.js, that order applies X first, then Y, then Z, each around the fixed world axes, which is what the viewer's sliders do. If you copy angles from the viewer, use the same order to get the same result.

```js
const deg = THREE.MathUtils.degToRad;
const rot = { x: 0, y: 45, z: 0 };            // degrees

model.rotation.set(deg(rot.x), deg(rot.y), deg(rot.z), 'ZYX');
label.textContent = `X ${rot.x.toFixed(1)}°  Y ${rot.y.toFixed(1)}°  Z ${rot.z.toFixed(1)}°`;
```

The origin of `gltf.scene` is at floor level, so X and Z rotations tip the model around its base. To rotate around the model's center and keep it on the floor, which is what the viewer does, wrap it in a pivot:

```js
const pivot = new THREE.Group();
scene.add(pivot);

const box = new THREE.Box3().setFromObject(model);
const center = box.getCenter(new THREE.Vector3());
model.position.sub(center);        // model's center is now at the pivot
pivot.add(model);

function setRotation(xDeg, yDeg, zDeg) {
  pivot.rotation.set(deg(xDeg), deg(yDeg), deg(zDeg), 'ZYX');
  pivot.position.y = 0;
  pivot.updateMatrixWorld(true);
  pivot.position.y = -new THREE.Box3().setFromObject(model).min.y;   // rest on the floor
}
```

To read the angle back after something else rotated the model, for example a drag control:

```js
const e = new THREE.Euler().setFromQuaternion(pivot.quaternion, 'ZYX');
const toDeg = THREE.MathUtils.radToDeg;
console.log(toDeg(e.x), toDeg(e.y), toDeg(e.z));
```

For free rotation with the mouse, `TransformControls` (from `three/addons/controls/TransformControls.js`) in `'rotate'` mode gives you a rotation gizmo on all three axes. Read the angles from its `objectChange` event with the snippet above.

### React Three Fiber

```jsx
import { Canvas } from '@react-three/fiber';
import { useGLTF, OrbitControls, Environment, ContactShadows } from '@react-three/drei';

function Machine({ url, rotation = [0, 0, 0], ...props }) {
  const { scene } = useGLTF(url);
  const r = rotation.map((d) => (d * Math.PI) / 180);
  return <primitive object={scene} rotation={[...r, 'ZYX']} {...props} />;
}

export default function App() {
  return (
    <Canvas camera={{ position: [4, 2.5, 6], fov: 35 }} shadows>
      <Environment preset="warehouse" />
      <Machine url="/models/CNC.glb" />
      <Machine url="/models/trn.glb" position={[3.2, 0, 0.5]} rotation={[0, -30, 0]} />
      <ContactShadows opacity={0.4} scale={12} />
      <OrbitControls target={[0, 1.2, 0]} />
    </Canvas>
  );
}

useGLTF.preload('/models/CNC.glb');
useGLTF.preload('/models/trn.glb');
```

### Finding and moving parts

The CNC keeps the assembly names from the original CAD model (in Spanish), so you can find a part with `getObjectByName`:

| Name in the GLB | Part |
|---|---|
| `BANCADA-1` | Base / bed |
| `MESA-1` | Work table (X axis) |
| `MESA_Y-1` | Saddle (Y axis) |
| `CABEZAL-1` | Spindle head (Z axis) |
| `CARRUSEL-1` | Tool carousel |
| `PROTECCI�N_CARRUSEL-1` | Carousel guard (*protección*) |
| `LARGUERO-1` | Crossbeam |
| `FIJA_DIAM_15-1`, `FIJA_DIAM_15-2` | Two small fixing pins near the table (*fija Ø15*) |
| `PUPITRE-1`, `POSTE_DE_PUPITRE-1` | Control pendant and its post |
| `PUERTA_IZQUIERDA-1` | Left door |
| `Simetr�aPUERTA_IZQUIERDA-1` | Right door (mirrored copy of the left, *simetría*) |
| `VENTANA-1`, `VENTANA-2` | Side windows |
| `CHAPA_FRONTAL-1`, `CHAPA_LATERAL-1/2`, `CHAPA_POSTERIOR_1-1/2-1` | Front, side and back panels |
| `TECHO_1-1`, `TECHO_2-1/2-2`, `TECHO_3-1` | Roof panels |
| `BANDEJA_INFERIOR-1` | Bottom chip tray |

```js
const table = cnc.getObjectByName('MESA-1');
table.position.x += 0.2;   // in the part's parent space, not necessarily world X
```

Limitations when moving parts:
- **Names:** spaces became underscores (`MESA Y-1` → `MESA_Y-1`). The original export broke the accented letters in two names (*Protección*, *Simetría*), which now contain the Unicode replacement character `�` (U+FFFD). Find those by a part of the name that has no accent:
  ```js
  let guard, rightDoor;
  cnc.traverse((o) => {
    if (o.name.endsWith('N_CARRUSEL-1') && o.name.startsWith('PROTECCI')) guard = o;
    if (o.name.endsWith('aPUERTA_IZQUIERDA-1')) rightDoor = o;
  });
  ```
- **Axes:** each part's local axes come from the CAD file, so its "X" doesn't have to match the machine's X travel. Test which local axis moves it the way you want.
- **Pivots:** a part's origin isn't always on its physical hinge or axis. To swing a door, put it in a `Group` placed at the hinge, like the pivot above.
- **Lathe:** its parts are mostly unnamed (`Body_1`, `Body_2`, ..., `3DGeom-604`), so you'd have to find them by clicking them (a raycaster) or by position.

---

## 2. How the files were made

### Starting point

The Unity project uses **Unity 5.4.0f3** (2016). The machines are FBX files in `Assets/`:

| Source | Format | What we found |
|---|---|---|
| `Assets/CNC.fbx` | Binary FBX 7.1 | Size is correct (meters). The file uses **Z as up**, so in Three.js it lies on its side. The operator side faces −X. |
| `Assets/trn.fbx` | Binary FBX 7.1 | It's **1/10 of real size** (181 mm long). The **Y axis is inverted**, so the base cabinet sits above the bed ways. |

The Unity `.mat` files in `Assets/Materials/` are copies of the materials inside the FBX files (same names, same colors), so nothing was taken from Unity itself. Unity wasn't needed and isn't installed.

**How the problems were found:**
- **CNC orientation:** the bottom tray (`BANDEJA_INFERIOR`) sits near Z = 0 and the roof (`TECHO_*`) near the top of Z, so Z is up.
- **Lathe orientation:** the green cabinet was on the +Y side, and the bed ways and lead screws were on the −Y side, so Y is inverted.
- **Lathe scale:** both files declare the same units, but the lathe came out 181 mm long, which is too small. At 10× it's 1.82 × 1.25 × 0.93 m, a normal size for a bench lathe.

### Why a custom converter

The usual tool, Facebook's **FBX2glTF**, only has an Intel macOS build, and this Mac (Apple Silicon) doesn't have Rosetta installed. Instead, `fbx2glb.mjs` runs Three.js in Node.js: `FBXLoader` reads the FBX and `GLTFExporter` writes the GLB. It needs no other native tools.

### What the converter does

1. **Loads the FBX** with `FBXLoader`, plus small shims for the browser-only parts it uses (`window`, `FileReader`, `TextureLoader`).
2. **Removes cameras and lights** that came with the FBX.
3. **Converts materials** from Phong to `MeshStandardMaterial`. It keeps the color and opacity, and estimates roughness from the old shininess value.
4. **Applies `--scale`** to fix models exported in the wrong units.
5. **Applies `--rotate x,y,z`** in degrees, X first, then Y, then Z, around the world axes.
6. **Recenters** the model on X/Z and moves its lowest point to `y = 0`.
7. **Exports a binary glTF** (`.glb`).

### Running it

`fbx2glb.mjs` needs the `three` package installed next to it, because Node looks for packages relative to the script:

```bash
mkdir fbx-converter && cp fbx2glb.mjs fbx-converter/ && cd fbx-converter
npm init -y && npm install three@0.170.0
```

Usage:

```
node fbx2glb.mjs <input.fbx> <output.glb> [--scale N] [--rotate x,y,z]
```

The exact commands used to make the two files (paths relative to the old Unity project's `Export/` folder):

```bash
node fbx2glb.mjs ../Assets/CNC.fbx CNC.glb --rotate -90,90,0
node fbx2glb.mjs ../Assets/trn.fbx trn.glb --scale 10 --rotate 0,0,180
```

- `CNC`: `-90` around X turns Z-up into Y-up. Then `90` around Y turns the operator side from −X to +Z.
- `trn`: `10×` gives real size. `180` around Z flips it upright and keeps the operator side facing +Z (a flip around X would turn it to face backwards).

It prints the mesh, triangle and material counts, the final size, and the materials with their colors. The warning "Use MeshStandardMaterial or MeshBasicMaterial" no longer appears, because materials are converted before export.

### Converting another FBX

1. Run it once with no flags, and look at the printed size. If it's 10, 100 or 1000 times too big or too small, add `--scale`.
2. Open the GLB in a viewer, such as the artifact above or https://gltf-viewer.donmccurdy.com. Find which way is up and which way the front faces.
3. Common fixes:
   - Z-up files (most CAD and 3ds Max exports): `--rotate -90,0,0`
   - Upside-down: `--rotate 180,0,0` or `--rotate 0,0,180`, depending on which way the front should face
   - Front facing the wrong way: add `90`, `-90` or `180` to the Y value

### Optional: smaller files

The GLBs aren't compressed. To make them smaller for the web, run them through glTF-Transform:

```bash
npx @gltf-transform/cli optimize CNC.glb CNC.min.glb --compress draco
```

Draco-compressed files need the decoder in your app:

```js
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader().setDRACOLoader(draco);
```

`useGLTF` in drei handles Draco on its own.

---

## 3. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Model is black or very dark | There's no light or environment map. Set `scene.environment` with `RoomEnvironment`, as in the minimal scene above. |
| Model is invisible | The camera is inside it or too close to it. Put the camera a few meters away (e.g. `(4, 2.5, 6)`), and set the `near` plane to 0.05 or more. |
| Colors look washed out | Turn on tone mapping (`ACESFilmicToneMapping`). Three.js r152+ handles color space on its own; on older versions, set `renderer.outputEncoding = THREE.sRGBEncoding`. |
| Angles don't match the viewer | Use Euler order `'ZYX'`, not the default `'XYZ'`. |
| X/Z rotation sinks the model into the floor | The model rotates around its base. Use the pivot pattern in "Rotating a model". |
| `getObjectByName` returns `undefined` | Spaces became underscores, and two names have broken characters. Print all names with `model.traverse(o => console.log(o.name))`. |
| Converter: `Cannot find package 'three'` | Install `three` in the same folder as `fbx2glb.mjs`. |
| Converter: `window is not defined` | You're running an older copy of the script. Use the one in this folder. |
