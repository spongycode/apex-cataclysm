// carFactory.js — procedural hypercar builder for APEX: CATACLYSM CANYON.
// Exports buildCarMesh({paint, accent}) per SPEC section 3.
// Forward = local -Z, up = +Y. Wheelbase 2.7 m, track 1.62 m, wheel r 0.34.
// Chassis origin = physics chassis center, ~0.6 m above ground (ground at y=-0.6 local).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHEEL_X = 0.81;      // half track
const WHEEL_Y = -0.26;     // rest axle height (ground -0.6 + r 0.34)
const AXLE_F = -1.35;      // front axle z (forward is -Z)
const AXLE_R = 1.35;       // rear axle z

/* ------------------------------------------------------------------ */
/* Shared procedural textures (built once, shared by all cars)         */
/* ------------------------------------------------------------------ */

let _shared = null;

function sharedTextures() {
  if (_shared) return _shared;
  const S = 64;

  // Metallic-flake micro noise: normal map + roughness speckle.
  const nc = document.createElement('canvas');
  nc.width = nc.height = S;
  const nx = nc.getContext('2d');
  const nd = nx.createImageData(S, S);
  const rc = document.createElement('canvas');
  rc.width = rc.height = S;
  const rx = rc.getContext('2d');
  const rd = rx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    nd.data[o] = (128 + (Math.random() - 0.5) * 30) | 0;
    nd.data[o + 1] = (128 + (Math.random() - 0.5) * 30) | 0;
    nd.data[o + 2] = 255;
    nd.data[o + 3] = 255;
    // Sparse mirror-flakes: sharp low-roughness pixels in a hazier bed.
    const flake = Math.random() < 0.09;
    const v = (flake ? 55 + Math.random() * 45 : 195 + Math.random() * 60) | 0;
    rd.data[o] = rd.data[o + 1] = rd.data[o + 2] = v;
    rd.data[o + 3] = 255;
  }
  nx.putImageData(nd, 0, 0);
  rx.putImageData(rd, 0, 0);
  const flakeNormal = new THREE.CanvasTexture(nc);
  const flakeRough = new THREE.CanvasTexture(rc);
  for (const t of [flakeNormal, flakeRough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(9, 9);
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
  }

  // Boost-flame gradient: hot core at cone base (v=0), fading to nothing at tip.
  const fc = document.createElement('canvas');
  fc.width = 32;
  fc.height = 128;
  const fx = fc.getContext('2d');
  const fg = fx.createLinearGradient(0, 128, 0, 0); // canvas bottom = v0 = flame base
  fg.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  fg.addColorStop(0.18, 'rgba(255,214,130,0.95)');
  fg.addColorStop(0.45, 'rgba(255,122,40,0.6)');
  fg.addColorStop(0.78, 'rgba(200,40,150,0.22)');
  fg.addColorStop(1.0, 'rgba(120,20,180,0)');
  fx.fillStyle = fg;
  fx.fillRect(0, 0, 32, 128);
  const flameTex = new THREE.CanvasTexture(fc);
  flameTex.wrapS = flameTex.wrapT = THREE.ClampToEdgeWrapping;

  _shared = { flakeNormal, flakeRough, flameTex };
  return _shared;
}

/** Radial-gradient CanvasTexture. stops = [[offset, cssColor], ...]. */
export function makeRadialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
  x.clearRect(0, 0, size, size);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* ------------------------------------------------------------------ */
/* Body loft — superellipse cross-sections swept nose→tail             */
/* ------------------------------------------------------------------ */

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Wheel-arch cut curve: top of the arch opening at longitudinal offset z.
function archY(z, zc, R) {
  const dz = z - zc;
  const d2 = R * R - dz * dz;
  return d2 > 0 ? WHEEL_Y + Math.sqrt(d2) * 0.92 : -Infinity;
}

// Control stations: z, halfWidth, yBottom, yTop, side exponent, top exponent.
// Low blade nose → rising fenders → cockpit waist → muscular rear haunches → kamm tail.
const BODY_CTRL = [
  [-2.32, 0.5, -0.38, -0.24, 0.62, 0.8],
  [-2.1, 0.72, -0.43, -0.13, 0.58, 0.72],
  [-1.8, 0.84, -0.45, 0.02, 0.52, 0.66],
  [-1.35, 0.88, -0.46, 0.17, 0.48, 0.6],
  [-0.9, 0.9, -0.46, 0.17, 0.46, 0.58],
  [-0.45, 0.92, -0.47, 0.15, 0.44, 0.56],
  [0.1, 0.93, -0.47, 0.14, 0.42, 0.56],
  [0.6, 0.95, -0.47, 0.17, 0.42, 0.56],
  [1.0, 0.97, -0.46, 0.21, 0.44, 0.58],
  [1.35, 0.98, -0.46, 0.23, 0.46, 0.6],
  [1.75, 0.94, -0.44, 0.19, 0.5, 0.64],
  [2.05, 0.87, -0.4, 0.11, 0.55, 0.7],
  [2.3, 0.8, -0.34, 0.04, 0.6, 0.78],
];

function buildBodyGeometry() {
  const NS = 60; // stations along length
  const SEG = 64; // points across each section
  const zMin = BODY_CTRL[0][0];
  const zMax = BODY_CTRL[BODY_CTRL.length - 1][0];
  const pos = [];
  const uv = [];
  const idx = [];

  const rows = []; // cache first/last station params for caps
  for (let s = 0; s <= NS; s++) {
    const z = zMin + (zMax - zMin) * (s / NS);
    let k = 0;
    while (k < BODY_CTRL.length - 2 && BODY_CTRL[k + 1][0] < z) k++;
    const a = BODY_CTRL[k];
    const b = BODY_CTRL[k + 1];
    let u = (z - a[0]) / (b[0] - a[0]);
    u = Math.max(0, Math.min(1, u));
    u = u * u * (3 - 2 * u);
    const w = a[1] + (b[1] - a[1]) * u;
    const yb = a[2] + (b[2] - a[2]) * u;
    const yt = a[3] + (b[3] - a[3]) * u;
    const e = a[4] + (b[4] - a[4]) * u;
    const f = a[5] + (b[5] - a[5]) * u;
    rows.push([w, yb, yt]);
    const arch = Math.max(archY(z, AXLE_F, 0.44), archY(z, AXLE_R, 0.46));
    for (let j = 0; j <= SEG; j++) {
      const phi = Math.PI * (1 - j / SEG); // left bottom → over roof → right bottom
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      const xs = Math.sign(c) * Math.pow(Math.abs(c), e);
      const x = w * xs;
      // Carve arch openings only near the flanks so the center tub stays low.
      let ybe = yb;
      if (arch > yb) {
        const lift = smoothstep(0.45, 0.82, Math.abs(xs));
        ybe = yb + (Math.min(arch, yt - 0.05) - yb) * lift;
      }
      const y = ybe + (yt - ybe) * Math.pow(sn, f);
      pos.push(x, y, z);
      uv.push(j / SEG, ((z - zMin) / (zMax - zMin)) * 4);
    }
  }

  const ring = SEG + 1;
  for (let s = 0; s < NS; s++) {
    for (let j = 0; j < SEG; j++) {
      const a = s * ring + j;
      const b = a + 1;
      const c = a + ring;
      const d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }

  // Nose cap (faces -Z) and tail panel (faces +Z), simple fans.
  const r0 = rows[0];
  const rN = rows[rows.length - 1];
  const noseC = pos.length / 3;
  pos.push(0, (r0[1] + r0[2]) * 0.5, zMin - 0.04);
  uv.push(0.5, 0);
  const tailC = pos.length / 3;
  pos.push(0, (rN[1] + rN[2]) * 0.5 - 0.04, zMax + 0.02);
  uv.push(0.5, 4);
  for (let j = 0; j < SEG; j++) {
    idx.push(noseC, j, j + 1); // CCW seen from front → normal -Z
    const base = NS * ring;
    idx.push(tailC, base + j + 1, base + j); // normal +Z
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const _placeEuler = new THREE.Euler();
const _placeMat = new THREE.Matrix4();

function place(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) {
    _placeEuler.set(rx, ry, rz);
    _placeMat.makeRotationFromEuler(_placeEuler);
    geo.applyMatrix4(_placeMat);
  }
  geo.translate(x, y, z);
  return geo;
}

function box(bucket, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  bucket.push(g);
  return g;
}

function mergeBucket(list) {
  const flat = [];
  for (let i = 0; i < list.length; i++) {
    flat.push(list[i].index ? list[i].toNonIndexed() : list[i]);
  }
  const merged = mergeGeometries(flat, false);
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Wheel geometry (built once, shared by every wheel of every car)     */
/* ------------------------------------------------------------------ */

let _wheelGeo = null;

function wheelGeometry() {
  if (_wheelGeo) return _wheelGeo;

  // --- Tire: torus shoulders + flat tread band, axis along X.
  const tireG = [];
  tireG.push(place(new THREE.TorusGeometry(0.245, 0.1, 14, 30), 0, 0, 0, 0, Math.PI / 2, 0));
  tireG.push(
    place(new THREE.CylinderGeometry(0.345, 0.345, 0.12, 30, 1, true), 0, 0, 0, 0, 0, Math.PI / 2)
  );

  // --- Hardware: rim barrel, 5 turbine spokes, hub, disc, sidewall ring.
  const hwG = [];
  hwG.push(
    place(new THREE.CylinderGeometry(0.245, 0.245, 0.19, 20, 1, true), 0, 0, 0, 0, 0, Math.PI / 2)
  );
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.BoxGeometry(0.045, 0.21, 0.06);
    spoke.rotateY(0.22); // turbine twist
    spoke.translate(0.075, 0.125, 0);
    spoke.rotateX((i / 5) * Math.PI * 2);
    hwG.push(spoke);
  }
  hwG.push(place(new THREE.CylinderGeometry(0.052, 0.052, 0.07, 12), 0.07, 0, 0, 0, 0, Math.PI / 2));
  hwG.push(place(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 10), 0.105, 0, 0, 0, 0, Math.PI / 2));
  // brake disc
  hwG.push(place(new THREE.CylinderGeometry(0.155, 0.155, 0.024, 24), 0.0, 0, 0, 0, 0, Math.PI / 2));
  // dark backing behind spokes
  hwG.push(place(new THREE.CircleGeometry(0.24, 20), -0.03, 0, 0, 0, Math.PI / 2, 0));
  // sidewall accent ring
  hwG.push(place(new THREE.TorusGeometry(0.28, 0.006, 6, 28), 0.085, 0, 0, 0, Math.PI / 2, 0));

  _wheelGeo = {
    tire: mergeBucket(tireG),
    hardware: mergeBucket(hwG),
    caliper: new THREE.BoxGeometry(0.055, 0.12, 0.17),
  };
  return _wheelGeo;
}

/* ------------------------------------------------------------------ */
/* buildCarMesh                                                        */
/* ------------------------------------------------------------------ */

export function buildCarMesh({ paint = 0xff1e55, accent = 0xff7a1a } = {}) {
  const tex = sharedTextures();
  const group = new THREE.Group();
  group.name = 'hypercar';

  /* ---- materials ---- */
  const paintMat = new THREE.MeshPhysicalMaterial({
    color: paint,
    metalness: 0.78,
    roughness: 0.42,
    roughnessMap: tex.flakeRough,
    normalMap: tex.flakeNormal,
    normalScale: new THREE.Vector2(0.06, 0.06),
    clearcoat: 1.0,
    clearcoatRoughness: 0.055,
    iridescence: 0.22,
    iridescenceIOR: 1.32,
    envMapIntensity: 1.55,
    side: THREE.DoubleSide,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x05070d,
    metalness: 0.1,
    roughness: 0.045,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 2.2,
  });
  const carbonMat = new THREE.MeshPhysicalMaterial({
    color: 0x101216,
    metalness: 0.45,
    roughness: 0.5,
    roughnessMap: tex.flakeRough,
    clearcoat: 0.6,
    clearcoatRoughness: 0.24,
    envMapIntensity: 0.9,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x08080a,
    roughness: 0.92,
    metalness: 0.15,
    side: THREE.DoubleSide,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accent,
    metalness: 0.65,
    roughness: 0.35,
    emissive: accent,
    emissiveIntensity: 0.18,
    envMapIntensity: 1.2,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x2b2d33,
    metalness: 1.0,
    roughness: 0.28,
    envMapIntensity: 1.4,
  });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.94, metalness: 0 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x8b8f98, metalness: 1.0, roughness: 0.32 });
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0x1a2030,
    emissive: 0xcfe0ff,
    emissiveIntensity: 2.4,
  });
  const brakeLightMat = new THREE.MeshStandardMaterial({
    color: 0x2b060a,
    emissive: 0xff1428,
    emissiveIntensity: 1.0,
  });

  /* ---- geometry buckets, merged per material ---- */
  const paintG = [];
  const carbonG = [];
  const darkG = [];
  const accentG = [];
  const glassG = [];
  const metalG = [];
  const headG = [];
  const tailG = [];

  // Body shell.
  paintG.push(buildBodyGeometry());

  // Wheel-arch flares (half tori hugging the openings).
  for (let f = 0; f < 4; f++) {
    const front = f < 2;
    const sx = f % 2 === 0 ? -1 : 1;
    const flare = new THREE.TorusGeometry(front ? 0.4 : 0.42, front ? 0.05 : 0.055, 10, 22, Math.PI);
    place(flare, sx * 0.86, WHEEL_Y, front ? AXLE_F : AXLE_R, 0, Math.PI / 2, 0);
    paintG.push(flare);
    // Dark wheel-well liner.
    const liner = new THREE.CylinderGeometry(0.44, 0.44, 0.34, 18, 1, true, 0, Math.PI);
    place(liner, sx * 0.7, WHEEL_Y, front ? AXLE_F : AXLE_R, 0, 0, Math.PI / 2);
    darkG.push(liner);
  }

  // Glass canopy bubble (Apollo-IE style teardrop).
  const canopy = new THREE.SphereGeometry(1, 28, 18);
  canopy.scale(0.62, 0.38, 0.95);
  canopy.translate(0, 0.14, 0.0);
  glassG.push(canopy);

  // Underbody plate + center tub (blocks see-through across arches).
  box(darkG, 1.5, 0.05, 4.2, 0, -0.47, 0);
  box(darkG, 1.05, 0.57, 3.0, 0, -0.185, 0.1);

  // Front splitter + canards.
  box(carbonG, 1.72, 0.045, 0.6, 0, -0.46, -2.12);
  box(accentG, 0.3, 0.018, 0.18, -0.62, -0.28, -2.16, 0, 0, -0.15);
  box(accentG, 0.3, 0.018, 0.18, 0.62, -0.28, -2.16, 0, 0, 0.15);

  // Side sills.
  box(carbonG, 0.09, 0.12, 2.3, -0.88, -0.44, 0);
  box(carbonG, 0.09, 0.12, 2.3, 0.88, -0.44, 0);

  // Rear diffuser + fins.
  box(carbonG, 1.5, 0.06, 0.55, 0, -0.4, 2.16, -0.4, 0, 0);
  for (let i = 0; i < 4; i++) {
    const fx = -0.55 + (i * 1.1) / 3;
    box(carbonG, 0.025, 0.16, 0.5, fx, -0.35, 2.18, -0.4, 0, 0);
  }

  // Rear wing: extruded airfoil on swan pylons + accent endplates.
  const af = new THREE.Shape();
  af.moveTo(-0.2, 0);
  af.quadraticCurveTo(-0.05, 0.055, 0.16, 0.012);
  af.quadraticCurveTo(0.02, -0.032, -0.2, 0);
  const wing = new THREE.ExtrudeGeometry(af, { depth: 1.66, bevelEnabled: false, curveSegments: 10 });
  wing.rotateY(Math.PI / 2);
  wing.computeBoundingBox();
  wing.translate(-(wing.boundingBox.min.x + wing.boundingBox.max.x) / 2, 0, 0); // center span
  place(wing, 0, 0.36, 2.02, 0.1, 0, 0);
  carbonG.push(wing);
  box(carbonG, 0.05, 0.26, 0.3, -0.34, 0.22, 2.0, 0.35, 0, 0);
  box(carbonG, 0.05, 0.26, 0.3, 0.34, 0.22, 2.0, 0.35, 0, 0);
  box(accentG, 0.02, 0.16, 0.42, -0.84, 0.36, 2.02, 0.1, 0, 0);
  box(accentG, 0.02, 0.16, 0.42, 0.84, 0.36, 2.02, 0.1, 0, 0);

  // Mirrors, hood vents, side intakes, roof detail.
  box(paintG, 0.16, 0.06, 0.1, -0.94, 0.14, -0.5, 0, 0.25, 0);
  box(paintG, 0.16, 0.06, 0.1, 0.94, 0.14, -0.5, 0, -0.25, 0);
  box(darkG, 0.3, 0.016, 0.5, -0.28, 0.155, -1.05, -0.07, 0, 0.04);
  box(darkG, 0.3, 0.016, 0.5, 0.28, 0.155, -1.05, -0.07, 0, -0.04);
  box(darkG, 0.12, 0.22, 0.55, -0.86, 0.02, 1.0, 0, 0.12, 0);
  box(darkG, 0.12, 0.22, 0.55, 0.86, 0.02, 1.0, 0, -0.12, 0);

  // Headlight DRL blades (angled check-mark strips, half-embedded in nose).
  for (const s of [-1, 1]) {
    box(headG, 0.4, 0.035, 0.06, s * 0.48, -0.19, -2.14, -0.15, -s * 0.32, s * 0.22);
    box(headG, 0.16, 0.03, 0.06, s * 0.28, -0.24, -2.2, -0.15, -s * 0.15, s * 0.85);
  }

  // Full-width rear light bar + vertical blades + wing brake strip.
  box(tailG, 1.58, 0.045, 0.05, 0, -0.02, 2.31);
  box(tailG, 0.05, 0.14, 0.05, -0.76, -0.08, 2.29);
  box(tailG, 0.05, 0.14, 0.05, 0.76, -0.08, 2.29);
  box(tailG, 0.34, 0.022, 0.03, 0, 0.375, 2.1, 0.1, 0, 0);

  // Twin exhausts.
  for (const s of [-1, 1]) {
    const tip = new THREE.TorusGeometry(0.055, 0.014, 8, 18);
    place(tip, s * 0.16, -0.16, 2.335);
    metalG.push(tip);
    const throat = new THREE.CircleGeometry(0.05, 14);
    place(throat, s * 0.16, -0.16, 2.325);
    darkG.push(throat);
  }

  /* ---- merged body meshes ---- */
  const buckets = [
    [paintG, paintMat, true],
    [carbonG, carbonMat, true],
    [darkG, darkMat, false],
    [accentG, accentMat, false],
    [glassG, glassMat, true],
    [metalG, metalMat, false],
    [headG, headlightMat, false],
    [tailG, brakeLightMat, false],
  ];
  for (let i = 0; i < buckets.length; i++) {
    const [list, mat, cast] = buckets[i];
    if (!list.length) continue;
    const mesh = new THREE.Mesh(mergeBucket(list), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  /* ---- wheels [FL, FR, RL, RR] ---- */
  const wg = wheelGeometry();
  const wheels = [];
  const slots = [
    [-WHEEL_X, AXLE_F],
    [WHEEL_X, AXLE_F],
    [-WHEEL_X, AXLE_R],
    [WHEEL_X, AXLE_R],
  ];
  for (let i = 0; i < 4; i++) {
    const [x, z] = slots[i];
    const pivot = new THREE.Group(); // steering yaw + suspension travel
    pivot.position.set(x, WHEEL_Y, z);
    const mirror = new THREE.Group(); // flip so rim face points outboard
    const left = x < 0;
    if (left) mirror.rotation.y = Math.PI;
    pivot.add(mirror);
    const spin = new THREE.Group();
    mirror.add(spin);
    const tire = new THREE.Mesh(wg.tire, tireMat);
    tire.castShadow = true;
    const hw = new THREE.Mesh(wg.hardware, rimMat);
    spin.add(tire, hw);
    const caliper = new THREE.Mesh(wg.caliper, accentMat);
    caliper.position.set(0.03, 0.125, -0.07);
    mirror.add(caliper);
    pivot.userData.spin = spin;
    pivot.userData.spinSign = left ? -1 : 1;
    pivot.userData.restY = WHEEL_Y;
    group.add(pivot);
    wheels.push(pivot);
  }

  /* ---- headlight SpotLights ---- */
  const headlights = [];
  for (const s of [-1, 1]) {
    const light = new THREE.SpotLight(0xdfe9ff, 0, 70, 0.48, 0.6, 1.35);
    light.position.set(s * 0.52, -0.08, -2.05);
    light.castShadow = false;
    light.visible = false;
    light.userData.maxIntensity = 3200;
    const target = new THREE.Object3D();
    target.position.set(s * 0.9, -1.7, -22);
    light.target = target;
    group.add(light, target);
    headlights.push(light);
  }

  /* ---- boost flames (additive cones, base at exhausts, apex +Z) ---- */
  const boostFlames = [];
  for (const s of [-1, 1]) {
    const outerGeo = new THREE.ConeGeometry(0.1, 1.0, 12, 1, true);
    outerGeo.rotateX(Math.PI / 2);
    outerGeo.translate(0, 0, 0.5);
    const outer = new THREE.Mesh(
      outerGeo,
      new THREE.MeshBasicMaterial({
        map: tex.flameTex,
        color: 0xff8a3c,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
        side: THREE.DoubleSide,
      })
    );
    const innerGeo = new THREE.ConeGeometry(0.05, 0.62, 10, 1, true);
    innerGeo.rotateX(Math.PI / 2);
    innerGeo.translate(0, 0, 0.31);
    const inner = new THREE.Mesh(
      innerGeo,
      new THREE.MeshBasicMaterial({
        map: tex.flameTex,
        color: 0xfff2cf,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      })
    );
    outer.add(inner);
    outer.userData.inner = inner;
    outer.position.set(s * 0.16, -0.16, 2.35);
    outer.visible = false;
    outer.renderOrder = 4;
    group.add(outer);
    boostFlames.push(outer);
  }

  // Exhaust heat glow light (CarVisuals flickers it while boosting).
  const boostGlow = new THREE.PointLight(0xff8a3c, 0, 7, 1.8);
  boostGlow.position.set(0, -0.14, 2.6);
  boostGlow.visible = false;
  group.add(boostGlow);

  /* ---- accent underglow ---- */
  const col = new THREE.Color(accent);
  const r = Math.round(col.r * 255);
  const g = Math.round(col.g * 255);
  const b = Math.round(col.b * 255);
  const glowTex = makeRadialTexture([
    [0, `rgba(${r},${g},${b},0.6)`],
    [0.5, `rgba(${r},${g},${b},0.28)`],
    [1, `rgba(${r},${g},${b},0)`],
  ]);
  const underglowGeo = new THREE.PlaneGeometry(2.5, 4.9);
  underglowGeo.rotateX(-Math.PI / 2);
  const underglow = new THREE.Mesh(
    underglowGeo,
    new THREE.MeshBasicMaterial({
      map: glowTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.2,
    })
  );
  underglow.position.y = -0.52;
  underglow.renderOrder = 3;
  group.add(underglow);

  group.userData.underglow = underglow;
  group.userData.boostGlow = boostGlow;
  group.userData.headlightMat = headlightMat;

  return { group, wheels, brakeLightMat, headlights, boostFlames, paintMat };
}
