// props.js — breakable props: signs, barrels, cones, crates, fences.
// One InstancedMesh per type; a spatial hash (cell 9 m) maps the car position to nearby
// instances each frame. On hit: the instance collapses to scale-0, `prop:break` fires with
// the instance position, stats.propsBroken bumps. Props NEVER slow the car (no colliders).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
const _breakPos = new THREE.Vector3(); // staging vector; payloads get a clone (events are rare, safety beats reuse)

let seed = 90210;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

const CELL = 9;
function hashKey(x, z) { return ((x / CELL) | 0) * 92821 + ((z / CELL) | 0); }

// --------------------------------------------------------------------------- geometries

function coneGeo() {
  const g = mergeGeometries([
    (() => { const c = new THREE.ConeGeometry(0.24, 0.65, 8); c.translate(0, 0.36, 0); return c; })(),
    (() => { const b = new THREE.BoxGeometry(0.5, 0.06, 0.5); b.translate(0, 0.03, 0); return b; })(),
  ], false);
  return g;
}
function barrelGeo() {
  const g = new THREE.CylinderGeometry(0.42, 0.42, 1.0, 10);
  g.translate(0, 0.5, 0);
  return g;
}
function crateGeo() {
  const g = new THREE.BoxGeometry(0.95, 0.95, 0.95);
  g.translate(0, 0.48, 0);
  return g;
}
function signGeo() {
  return mergeGeometries([
    (() => { const p = new THREE.CylinderGeometry(0.06, 0.07, 2.1, 6); p.translate(0, 1.05, 0); return p; })(),
    (() => { const b = new THREE.BoxGeometry(1.5, 1.0, 0.07); b.translate(0, 2.4, 0); return b; })(),
  ], false);
}
function fenceGeo() {
  // 3 m picket fence section
  const parts = [];
  for (const lx of [-1.4, 1.4]) {
    const post = new THREE.BoxGeometry(0.12, 1.15, 0.12);
    post.translate(lx, 0.57, 0);
    parts.push(post);
  }
  for (const ly of [0.45, 0.95]) {
    const rail = new THREE.BoxGeometry(3.0, 0.14, 0.05);
    rail.translate(0, ly, 0);
    parts.push(rail);
  }
  return mergeGeometries(parts, false);
}

function stripeTexture(c1, c2) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const x = cv.getContext('2d');
  x.fillStyle = c1; x.fillRect(0, 0, 64, 64);
  x.fillStyle = c2;
  for (let i = -64; i < 64; i += 24) {
    x.beginPath(); x.moveTo(i, 64); x.lineTo(i + 24, 0); x.lineTo(i + 36, 0); x.lineTo(i + 12, 64); x.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------------------

const TYPE_DEFS = [
  // type      geo        hitR   material
  ['cone',    coneGeo,    1.0, () => new THREE.MeshStandardMaterial({ color: 0xff5a1a, roughness: 0.7 })],
  ['barrel',  barrelGeo,  1.15, () => new THREE.MeshStandardMaterial({ map: stripeTexture('#c9401e', '#f2ede2'), roughness: 0.6, metalness: 0.3 })],
  ['crate',   crateGeo,   1.2, () => new THREE.MeshStandardMaterial({ color: 0x9a7648, roughness: 0.9 })],
  ['sign',    signGeo,    1.3, () => new THREE.MeshStandardMaterial({ map: stripeTexture('#ffc21a', '#141210'), roughness: 0.65, metalness: 0.4 })],
  ['fence',   fenceGeo,   2.2, () => new THREE.MeshStandardMaterial({ color: 0x8a7a5e, roughness: 0.95 })],
];

export class Breakables {
  constructor(data, sampler, events, state) {
    this.data = data;
    this.sampler = sampler;
    this.events = events;
    this.state = state;
    this.group = new THREE.Group();
    this.sets = []; // {type, im, positions:Float32Array, alive:Uint8Array, hitR}
    this.hash = new Map(); // key -> [ [setIdx, instIdx], ... ] flattened pairs
    this._cool = 0;
  }

  build() {
    const m = this.data.markerT;
    const S = this.sampler;

    // authored scatter plans: [type, count, tRanges, latMin, latMax, alongRoad]
    const plans = [
      ['cone', 130, [[0.004, 0.03], [m.jump, m.gapStart - 0.003], [m.finish + 0.004, m.kickStart - 0.002]], 0.30, 0.48],
      ['barrel', 90, [[0.03, m.canyon], [m.rockslide, m.forest], [m.water, m.bridge - 0.006]], 0.55, 0.95],
      ['crate', 70, [[m.tunnel - 0.01, m.tunnelEnd], [m.rockslide + 0.01, m.forest]], 0.6, 1.0],
      ['sign', 60, [[0.004, m.jump], [m.finish, 0.99]], 0.62, 0.92],
      ['fence', 170, [[m.forest, m.tunnel - 0.004]], 0.52, 0.60],
    ];

    for (const [type, count, tRanges, latMin, latMax] of plans) {
      const def = TYPE_DEFS.find((d) => d[0] === type);
      const im = new THREE.InstancedMesh(def[1](), def[3](), count);
      im.castShadow = true;
      im.frustumCulled = false;
      const positions = new Float32Array(count * 3);
      const alive = new Uint8Array(count).fill(1);
      const setIdx = this.sets.length;

      for (let i = 0; i < count; i++) {
        let t, rec, lat;
        if (type === 'fence') {
          // continuous fence runs along both forest road edges
          const range = tRanges[0];
          const side = i % 2 === 0 ? -1 : 1;
          t = range[0] + ((i >> 1) / (count / 2)) * (range[1] - range[0]);
          rec = S.sample(t);
          lat = side * (rec.width * 0.5 + 1.1);
        } else {
          const range = tRanges[(rnd() * tRanges.length) | 0];
          t = range[0] + rnd() * (range[1] - range[0]);
          rec = S.sample(t);
          const side = rnd() < 0.5 ? -1 : 1;
          lat = side * rec.width * (latMin + rnd() * (latMax - latMin));
        }
        _p.copy(rec.position).addScaledVector(rec.right, lat).addScaledVector(rec.up, 0.02);
        let yaw;
        if (type === 'fence') {
          yaw = Math.atan2(rec.tangent.x, rec.tangent.z) + Math.PI / 2;
        } else yaw = rnd() * Math.PI * 2;
        _q.setFromAxisAngle(_s.set(0, 1, 0), yaw);
        // tilt to road up
        const sc = type === 'sign' || type === 'fence' ? 1 : 0.85 + rnd() * 0.4;
        _m4.compose(_p, _q, _s.set(sc, sc, sc));
        im.setMatrixAt(i, _m4);
        positions[i * 3] = _p.x; positions[i * 3 + 1] = _p.y; positions[i * 3 + 2] = _p.z;
        const key = hashKey(_p.x, _p.z);
        let arr = this.hash.get(key);
        if (!arr) this.hash.set(key, (arr = []));
        arr.push(setIdx, i);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.sets.push({ type, im, positions, alive, hitR: def[2] });
    }
    return this.group;
  }

  /** Per-frame proximity check vs the player car. Zero allocations. */
  check(carPos, carSpeed) {
    if (carSpeed < 2) return;
    const cx = (carPos.x / CELL) | 0, cz = (carPos.z / CELL) | 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const arr = this.hash.get((cx + ox) * 92821 + (cz + oz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const set = this.sets[arr[k]];
          const i = arr[k + 1];
          if (!set.alive[i]) continue;
          const px = set.positions[i * 3], py = set.positions[i * 3 + 1], pz = set.positions[i * 3 + 2];
          const dx = px - carPos.x, dy = py - carPos.y, dz = pz - carPos.z;
          const r = set.hitR + 1.1; // + car half-width
          if (dx * dx + dz * dz < r * r && dy * dy < 6.5) {
            set.alive[i] = 0;
            set.im.setMatrixAt(i, _zero);
            set.im.instanceMatrix.needsUpdate = true;
            _breakPos.set(px, py, pz);
            this.state.stats.propsBroken++;
            this.events.emit('prop:break', { position: _breakPos.clone(), type: set.type });
          }
        }
      }
    }
  }

  reset() {
    for (const set of this.sets) {
      let dirty = false;
      for (let i = 0; i < set.alive.length; i++) {
        if (!set.alive[i]) {
          // rebuild original matrix from stored position (yaw is lost; use identity-yaw — fine post-restart)
          _p.set(set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]);
          _m4.compose(_p, _q.identity(), _s.set(1, 1, 1));
          set.im.setMatrixAt(i, _m4);
          set.alive[i] = 1;
          dirty = true;
        }
      }
      if (dirty) set.im.instanceMatrix.needsUpdate = true;
    }
  }
}
