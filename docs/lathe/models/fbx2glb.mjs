// Usage: node fbx2glb.mjs input.fbx output.glb [--scale 10] [--rotate x,y,z]
//   --rotate takes degrees, applied X first, then Y, then Z (e.g. Z-up CAD files: --rotate -90,90,0)
//   The result is centered on the origin and rests on the floor (y = 0).
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Minimal shims so the exporter works outside a browser
globalThis.FileReader = class {
  readAsArrayBuffer(b) { b.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); }); }
  readAsDataURL(b) { b.arrayBuffer().then(r => { this.result = `data:${b.type || 'application/octet-stream'};base64,` + Buffer.from(r).toString('base64'); this.onloadend?.(); }); }
};
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
THREE.TextureLoader.prototype.load = () => new THREE.Texture(); // skip external textures

const [, , input, output, ...flags] = process.argv;
const flag = (name, def) => { const i = flags.indexOf(name); return i < 0 ? def : flags[i + 1]; };
const scale = Number(flag('--scale', '1'));
const [rx, ry, rz] = flag('--rotate', '0,0,0').split(',').map(d => THREE.MathUtils.degToRad(Number(d)));
const buf = fs.readFileSync(input);
const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

// Drop cameras/lights baked into the FBX; the viewer supplies its own
const extras = []; obj.traverse(o => { if (o.isCamera || o.isLight) extras.push(o); });
extras.forEach(o => o.removeFromParent());
obj.scale.multiplyScalar(scale); // fix models exported in the wrong units
obj.rotation.set(rx, ry, rz, 'ZYX'); // three.js 'ZYX' order applies X, then Y, then Z
obj.updateMatrixWorld(true);
// Center on X/Z and put the lowest point on the floor
const raw = new THREE.Box3().setFromObject(obj), mid = raw.getCenter(new THREE.Vector3());
obj.position.set(-mid.x, -raw.min.y, -mid.z);
obj.updateMatrixWorld(true);

let meshes = 0, tris = 0; const mats = new Map();
obj.traverse(o => {
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  // FBX gives Phong materials; convert to PBR so glTF/three.js shade them properly
  const toStd = m => mats.get(m.name) ?? mats.set(m.name, new THREE.MeshStandardMaterial({
    name: m.name, color: m.color, opacity: m.opacity, transparent: m.transparent, side: m.side,
    metalness: 0.1, roughness: THREE.MathUtils.clamp(1 - (m.shininess ?? 30) / 100, 0.25, 0.9),
  })).get(m.name);
  o.material = Array.isArray(o.material) ? o.material.map(toStd) : toStd(o.material);
});
const box = new THREE.Box3().setFromObject(obj);
console.log({ meshes, tris: Math.round(tris), materials: mats.size, size: box.getSize(new THREE.Vector3()), animations: obj.animations.length });
console.log([...mats.values()].map(m => `${m.name} #${m.color?.getHexString()} ${m.map ? 'tex' : ''}`).join('\n'));

new GLTFExporter().parse(obj, glb => {
  fs.writeFileSync(output, Buffer.from(glb));
  console.log('wrote', output, fs.statSync(output).size, 'bytes');
}, e => { console.error(e); process.exit(1); }, { binary: true, animations: obj.animations });
