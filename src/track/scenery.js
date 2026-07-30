// scenery.js — everything that sells the scale: mesas, instanced rocks/cacti/pines,
// the mine tunnel (tube + string lights + collapsible supports), the loop scaffold,
// checkpoint gates, the flaming finish arch and decorative billboards.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _down = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _e = new THREE.Euler();

let seed = 4242;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

function groundY(terrain, x, z, fallback = 0) {
  _o.set(x, 500, z);
  _ray.ray.origin.copy(_o);
  _ray.ray.direction.copy(_down);
  _ray.near = 0; _ray.far = 1000;
  const hits = _ray.intersectObject(terrain, false);
  return hits.length ? hits[0].point.y : fallback;
}

/** Scatter instances near road zones, dropped onto the terrain, avoiding the deck. */
function scatter(im, count, data, sampler, terrain, { tRanges, minLat, maxLat, sMin, sMax, yaw = true, sink = 0.2 }) {
  let placed = 0, guard = 0;
  while (placed < count && guard++ < count * 8) {
    const range = tRanges[(rnd() * tRanges.length) | 0];
    const t = range[0] + rnd() * (range[1] - range[0]);
    const rec = sampler.sample(t);
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = (minLat + rnd() * (maxLat - minLat)) * side;
    const x = rec.position.x + rec.right.x * lat + (rnd() - 0.5) * 18;
    const z = rec.position.z + rec.right.z * lat + (rnd() - 0.5) * 18;
    const y = groundY(terrain, x, z, rec.position.y);
    if (y < rec.position.y - 60) continue; // don't decorate the bottom of chasms
    const s = sMin + rnd() * (sMax - sMin);
    _q.setFromEuler(_e.set(0, yaw ? rnd() * Math.PI * 2 : 0, 0));
    _m4.compose(_p.set(x, y - sink * s, z), _q, _s.set(s, s * (0.85 + rnd() * 0.35), s));
    im.setMatrixAt(placed, _m4);
    placed++;
  }
  im.count = placed;
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false; // instances span the map; skip per-frame bounds math
  return placed;
}

// ---------------------------------------------------------------------------

function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const f = 0.72 + rnd() * 0.55;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

function cactusGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.34, 0.44, 3.4, 7);
  trunk.translate(0, 1.7, 0);
  parts.push(trunk);
  for (const [side, h] of [[-1, 1.7], [1, 2.3]]) {
    const arm = new THREE.CylinderGeometry(0.22, 0.26, 1.5, 6);
    arm.translate(0, 0.75, 0);
    arm.rotateZ(side * 0.25);
    arm.translate(side * 0.72, h, 0);
    const elbow = new THREE.CylinderGeometry(0.24, 0.24, 0.9, 6);
    elbow.rotateZ(Math.PI / 2);
    elbow.translate(side * 0.45, h, 0);
    parts.push(arm, elbow);
  }
  return mergeGeometries(parts, false);
}

function pineGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.4, 3.6, 6);
  trunk.translate(0, 1.8, 0);
  parts.push(trunk);
  const tiers = [[3.4, 3.0, 2.6], [2.6, 2.6, 5.2], [1.8, 2.4, 7.4], [1.05, 2.0, 9.2]];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 8);
    cone.translate(0, y, 0);
    parts.push(cone);
  }
  return mergeGeometries(parts, false);
}

// vertex-color a merged geometry with two colors split at a local height
function paintByHeight(g, cLow, cHigh, splitY) {
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const lo = new THREE.Color(cLow), hi = new THREE.Color(cHigh);
  for (let i = 0; i < p.count; i++) {
    const c = p.getY(i) > splitY ? hi : lo;
    const v = 0.92 + rnd() * 0.14;
    col[i * 3] = c.r * v; col[i * 3 + 1] = c.g * v; col[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function buildVegetation(data, sampler, terrain) {
  const m = data.markerT;
  const group = new THREE.Group();
  const out = { group };

  // ROCKS — everywhere rocky (desert, canyon, rockslide, water, bridge)
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a4a30, roughness: 0.95, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeometry(), rockMat, 1400);
  scatter(rocks, 1400, data, sampler, terrain, {
    tRanges: [[0.002, m.forest], [m.water, 0.99]],
    minLat: 11, maxLat: 190, sMin: 0.5, sMax: 4.4, sink: 0.3,
  });
  rocks.castShadow = true; rocks.receiveShadow = true;
  group.add(rocks);

  // CACTI — desert + finish flats
  const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7038, roughness: 0.85 });
  const cacti = new THREE.InstancedMesh(cactusGeometry(), cactusMat, 700);
  scatter(cacti, 700, data, sampler, terrain, {
    tRanges: [[0.002, m.canyon], [m.finish, 0.995]],
    minLat: 10, maxLat: 160, sMin: 0.7, sMax: 1.8, sink: 0.05,
  });
  cacti.castShadow = true;
  group.add(cacti);

  // PINES — forest run (dense!) + sparse around water
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x24421f, roughness: 0.9, flatShading: true, vertexColors: true });
  const pineGeo = paintByHeight(pineGeometry(), 0x5a3d22, 0x24421f, 3.2);
  const pines = new THREE.InstancedMesh(pineGeo, pineMat, 1500);
  scatter(pines, 1500, data, sampler, terrain, {
    tRanges: [[m.forest - 0.01, m.tunnel], [m.water, m.bridge - 0.01]],
    minLat: 8.5, maxLat: 220, sMin: 0.8, sMax: 2.6, sink: 0.05,
  });
  pines.castShadow = true;
  group.add(pines);
  out.pines = pines;

  // MESAS — hero silhouettes on the horizon (merged, far from road)
  const mesaParts = [];
  for (let i = 0; i < 16; i++) {
    const t = rnd();
    const rec = sampler.sample(t);
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = 260 + rnd() * 420;
    const x = rec.position.x + rec.right.x * lat * side + (rnd() - 0.5) * 200;
    const z = rec.position.z + rec.right.z * lat * side + (rnd() - 0.5) * 200;
    const y = groundY(terrain, x, z, 0);
    const h = 60 + rnd() * 90, r = 40 + rnd() * 80;
    const g = new THREE.CylinderGeometry(r * (0.55 + rnd() * 0.25), r, h, 9, 3);
    const pp = g.attributes.position;
    for (let vI = 0; vI < pp.count; vI++) { // craggy displacement
      const f = 1 + (rnd() - 0.5) * 0.22;
      pp.setX(vI, pp.getX(vI) * f); pp.setZ(vI, pp.getZ(vI) * f);
    }
    g.computeVertexNormals();
    g.translate(x, y + h * 0.42, z);
    mesaParts.push(paintByHeight(g, 0x7a3620, 0xa4552e, y + h * 0.1));
  }
  const mesaMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const mesas = new THREE.Mesh(mergeGeometries(mesaParts, false), mesaMat);
  mesas.geometry.computeBoundingSphere();
  mesas.matrixAutoUpdate = false;
  mesas.castShadow = true;
  group.add(mesas);

  return out;
}

// ---------------------------------------------------------------------------
// MINE TUNNEL — rock tube (collider), string lights, collapsible support portals.
// ---------------------------------------------------------------------------

export function buildTunnel(data, sampler) {
  const m = data.markerT;
  const t0 = m.tunnel + 0.004, t1 = m.tunnelEnd - 0.002;
  const i0 = Math.round(t0 * (data.N - 1)), i1 = Math.round(t1 * (data.N - 1));
  const STEP = 6, RADIAL = 9;
  const rows = [];
  for (let i = i0; i <= i1; i += STEP) rows.push(i);
  const vcount = rows.length * RADIAL;
  const posA = new Float32Array(vcount * 3);
  const colA = new Float32Array(vcount * 3);
  const idx = [];
  const col = new THREE.Color(0x4a3226);
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k];
    _p.fromArray(data.pos, i * 3);
    _t.fromArray(data.tan, i * 3);
    _u.fromArray(data.up, i * 3);
    _r.crossVectors(_t, _u);
    const w = data.width[i] * 0.5 + 1.6;
    for (let a = 0; a < RADIAL; a++) {
      // horseshoe arc from right-floor around the ceiling to left-floor
      const th = (a / (RADIAL - 1)) * Math.PI;
      const lx = Math.cos(th) * w;
      const ly = Math.sin(th) * (6.4 + Math.sin(i * 0.7) * 0.5) + 0.1;
      const b = (k * RADIAL + a) * 3;
      posA[b] = _p.x + _r.x * lx + _u.x * ly;
      posA[b + 1] = _p.y + _r.y * lx + _u.y * ly;
      posA[b + 2] = _p.z + _r.z * lx + _u.z * ly;
      const v = 0.75 + rnd() * 0.45;
      colA[b] = col.r * v; colA[b + 1] = col.g * v; colA[b + 2] = col.b * v;
    }
    if (k < rows.length - 1) {
      for (let a = 0; a < RADIAL - 1; a++) {
        const q0 = k * RADIAL + a, q1 = q0 + 1, q2 = q0 + RADIAL, q3 = q2 + 1;
        idx.push(q0, q1, q2, q1, q3, q2); // wound so normals face INWARD
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const tube = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, side: THREE.DoubleSide, flatShading: true,
  }));
  tube.matrixAutoUpdate = false;
  tube.name = 'tunnel_tube';

  // --- string lights: emissive bulbs + sagging wire ---
  const NB = 90;
  const bulbGeo = new THREE.SphereGeometry(0.13, 6, 5);
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x332211, emissive: new THREE.Color(0xffb45e), emissiveIntensity: 3.2,
  });
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, NB);
  const wirePts = [];
  for (let b = 0; b < NB; b++) {
    const t = t0 + ((b + 0.5) / NB) * (t1 - t0);
    const rec = sampler.sample(t);
    const sag = 0.35 * Math.abs(Math.sin(b * 2.4));
    _p.copy(rec.position).addScaledVector(rec.up, 5.6 - sag).addScaledVector(rec.right, Math.sin(b * 1.7) * 1.4);
    _m4.compose(_p, _q.identity(), _s.set(1, 1, 1));
    bulbs.setMatrixAt(b, _m4);
    wirePts.push(_p.clone());
  }
  bulbs.instanceMatrix.needsUpdate = true;
  bulbs.frustumCulled = false;
  const wireGeo = new THREE.BufferGeometry().setFromPoints(wirePts);
  const wire = new THREE.Line(wireGeo, new THREE.LineBasicMaterial({ color: 0x1a1410 }));
  wire.frustumCulled = false;

  // --- support portals (collapse behind the car) ---
  const NS = 14;
  const beam = 0.42;
  const portalParts = [];
  const post = new THREE.BoxGeometry(beam, 6.2, beam); post.translate(0, 3.1, 0);
  const lintel = new THREE.BoxGeometry(11.6, beam * 1.2, beam); lintel.translate(0, 6.2, 0);
  const pl = post.clone(); pl.translate(-5.6, 0, 0);
  const pr = post.clone(); pr.translate(5.6, 0, 0);
  portalParts.push(pl, pr, lintel);
  const portalGeo = mergeGeometries(portalParts, false);
  const portalMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 });
  const supports = new THREE.InstancedMesh(portalGeo, portalMat, NS);
  supports.frustumCulled = false;
  const supportInfo = [];
  for (let sI = 0; sI < NS; sI++) {
    const t = t0 + 0.003 + (sI / (NS - 1)) * (t1 - t0 - 0.006);
    const rec = sampler.sample(t);
    _q.setFromRotationMatrix(_m4.makeBasis(rec.right, rec.up, _t.crossVectors(rec.right, rec.up)));
    _m4.compose(rec.position, _q, _s.set(1, 1, 1));
    supports.setMatrixAt(sI, _m4);
    supportInfo.push({
      t, fallen: false, fallT: 0,
      basePos: rec.position.clone(), baseQuat: _q.clone(),
      right: rec.right.clone(), up: rec.up.clone(),
    });
  }
  supports.instanceMatrix.needsUpdate = true;

  return { tube, bulbs, wire, supports, supportInfo, bulbMat };
}

// ---------------------------------------------------------------------------
// LOOP SCAFFOLD — industrial trusses holding the stunt loop.
// ---------------------------------------------------------------------------

export function buildLoopScaffold(data, sampler) {
  const midT = (data.loopT0 + data.loopT1) / 2;
  const entry = sampler.sample(data.loopT0);
  const center = entry.position.clone().add(new THREE.Vector3(0, 26, 0));
  const fwd = entry.tangent.clone().setY(0).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const groundYv = entry.position.y;
  const parts = [];
  const strut = (a, b, r = 0.3) => {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, 6);
    g.translate(0, len / 2, 0);
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.applyQuaternion(q);
    g.translate(a.x, a.y, a.z);
    parts.push(g);
  };
  // radial legs to the ring at 45°..315° on both rails of the ribbon
  for (const latSide of [-7.5, 7.5]) {
    const c = center.clone().addScaledVector(right, latSide + 4); // ribbon shifts helically; cheat the middle
    for (const ang of [0.8, 1.6, 2.4, Math.PI, 3.9, 4.7, 5.5]) {
      const ringP = c.clone()
        .addScaledVector(fwd, Math.sin(ang) * 27.5)
        .add(new THREE.Vector3(0, -Math.cos(ang) * 27.5, 0));
      if (ringP.y < groundYv + 2) continue;
      const base = new THREE.Vector3(ringP.x + (rnd() - 0.5) * 6, groundYv - 1, ringP.z + (rnd() - 0.5) * 6);
      strut(base, ringP, 0.34);
    }
    // cross-braces
    for (let i = 0; i < 5; i++) {
      const a1 = 0.9 + i * 0.9, a2 = a1 + 0.9;
      const p1 = c.clone().addScaledVector(fwd, Math.sin(a1) * 27.5).add(new THREE.Vector3(0, -Math.cos(a1) * 27.5, 0));
      const p2 = c.clone().addScaledVector(fwd, Math.sin(a2) * 27.5).add(new THREE.Vector3(0, -Math.cos(a2) * 27.5, 0));
      strut(p1, p2, 0.2);
    }
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8451c, roughness: 0.5, metalness: 0.7 });
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), mat);
  mesh.geometry.computeBoundingSphere();
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.name = 'loop_scaffold';
  return mesh;
}

// ---------------------------------------------------------------------------
// CHECKPOINT GATES + FINISH GATE + FLAMING ARCH + BILLBOARDS
// ---------------------------------------------------------------------------

export function buildGates(data, sampler, checkpoints) {
  const parts = [];
  const emParts = [];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const cp = checkpoints[i];
    const rec = sampler.sample(cp.t);
    const hw = rec.width * 0.5 + 1.3;
    addGate(parts, emParts, rec, hw, 6.5, 0.34);
  }
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.6 });
  const frame = new THREE.Mesh(mergeGeometries(parts, false), frameMat);
  frame.geometry.computeBoundingSphere();
  frame.matrixAutoUpdate = false;
  const emissiveMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: new THREE.Color(0x00e0ff), emissiveIntensity: 2.6,
  });
  const glow = new THREE.Mesh(mergeGeometries(emParts, false), emissiveMat);
  glow.geometry.computeBoundingSphere();
  glow.matrixAutoUpdate = false;

  // finish gate — big, hot brand colors
  const fin = checkpoints[checkpoints.length - 1];
  const rec = sampler.sample(fin.t);
  const fParts = [], fEm = [];
  addGate(fParts, fEm, rec, rec.width * 0.5 + 2.2, 9.5, 0.8);
  const finFrame = new THREE.Mesh(mergeGeometries(fParts, false),
    new THREE.MeshStandardMaterial({ color: 0x1a1216, roughness: 0.4, metalness: 0.7 }));
  finFrame.matrixAutoUpdate = false;
  const finGlowMat = new THREE.MeshStandardMaterial({
    color: 0x220a12, emissive: new THREE.Color(0xff2d78), emissiveIntensity: 3.4,
  });
  const finGlow = new THREE.Mesh(mergeGeometries(fEm, false), finGlowMat);
  finGlow.matrixAutoUpdate = false;

  const group = new THREE.Group();
  group.add(frame, glow, finFrame, finGlow);
  return { group, glowMat: emissiveMat, finGlowMat };
}

function addGate(parts, emParts, rec, hw, h, beam) {
  const mk = (w, hh, d) => new THREE.BoxGeometry(w, hh, d);
  const basis = new THREE.Matrix4().makeBasis(
    rec.right.clone(), rec.up.clone(), rec.right.clone().cross(rec.up),
  );
  const place = (g, lx, ly) => {
    g.applyMatrix4(basis);
    g.translate(
      rec.position.x + rec.right.x * lx + rec.up.x * ly,
      rec.position.y + rec.right.y * lx + rec.up.y * ly,
      rec.position.z + rec.right.z * lx + rec.up.z * ly,
    );
    return g;
  };
  parts.push(place(mk(beam, h, beam), -hw, h / 2));
  parts.push(place(mk(beam, h, beam), hw, h / 2));
  parts.push(place(mk(hw * 2 + beam, beam * 1.4, beam), 0, h));
  emParts.push(place(mk(hw * 2, beam * 0.5, beam * 1.15), 0, h - beam));
}

export function buildFlamingArch(data, sampler) {
  const m = data.markerT;
  // arch 58 m past the kicker lip — fast cars fly through it at ~+2 m (see spline.js math)
  const archT = m.kickEnd + 42 / data.totalLen;
  const rec = sampler.sample(archT);
  const group = new THREE.Group();
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(8.4, 0.9, 8, 24, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x2b2117, roughness: 0.85, flatShading: true }),
  );
  torus.scale.set(1.15, 1.35, 1);
  const yaw = Math.atan2(rec.tangent.x, rec.tangent.z);
  group.position.copy(rec.position);
  group.rotation.y = yaw;
  torus.position.y = 0.5;
  group.add(torus);
  // flame cones riding the arc — animated by setpieces
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xff7a1a, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flameGeo = new THREE.ConeGeometry(0.75, 2.6, 6);
  const flames = new THREE.InstancedMesh(flameGeo, flameMat, 13);
  flames.frustumCulled = false;
  const flameBase = [];
  for (let i = 0; i < 13; i++) {
    const a = (i / 12) * Math.PI;
    flameBase.push(new THREE.Vector3(Math.cos(a) * 9.7, Math.sin(a) * 11.4 + 0.5, 0));
  }
  group.add(flames);
  const light = new THREE.PointLight(0xff6a10, 120, 60, 2);
  light.position.set(0, 11, 0);
  group.add(light);
  return { group, flames, flameBase, flameMat, light, archT };
}

export function buildBillboards(data, sampler, materials, terrain) {
  const specs = [
    [0.025, 'APEX', 'CATACLYSM CANYON — RACE THE FALL', 330],
    [0.06, 'FLAT OUT', 'CANYON FUEL // OCTANE 120', 20],
    [0.10, 'MESA MOTORS', 'DRIVE THE LEGEND', 200],
    [0.24, 'BIG JUMP AHEAD', 'YOU WILL NOT BRAKE', 8],
    [0.62, 'THE LOOP', 'GRAVITY IS A SUGGESTION', 265],
    [0.945, 'LAST CHANCE', 'FINISH LINE 500 M', 300],
  ];
  const group = new THREE.Group();
  for (const [t, txt, sub, hue] of specs) {
    const rec = sampler.sample(t);
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = rec.width * 0.5 + 7 + rnd() * 5;
    const x = rec.position.x + rec.right.x * lat * side;
    const z = rec.position.z + rec.right.z * lat * side;
    const y = groundY(terrain, x, z, rec.position.y);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(13, 6.5, 0.4),
      [null, null, null, null,
        new THREE.MeshStandardMaterial({ map: materials.billboardTexture(txt, sub, hue), roughness: 0.6 }),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2e })],
    );
    // fill the other faces with the frame material
    const frameM = board.material[5];
    board.material[0] = frameM; board.material[1] = frameM; board.material[2] = frameM; board.material[3] = frameM;
    board.position.set(x, y + 7.2, z);
    board.lookAt(rec.position.x, y + 6, rec.position.z);
    const legGeo = new THREE.CylinderGeometry(0.28, 0.34, 7.4, 6);
    for (const lx of [-4.5, 4.5]) {
      const leg = new THREE.Mesh(legGeo, frameM);
      leg.position.set(lx, -6.9, 0);
      board.add(leg);
    }
    board.castShadow = true;
    group.add(board);
  }
  group.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  return group;
}
