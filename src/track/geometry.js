// geometry.js — road ribbon, guard rails, chevron decals, and the sculpted terrain.
// Everything static is merged per-material; every drivable/hittable surface is returned
// with a surface tag so TrackSystem can register colliders.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SURF, S_ASPHALT, S_DIRT, S_WOOD, S_METAL, S_WATER } from './spline.js';

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();

/** t-windows where the road ribbon (and rails) must NOT exist — jump gaps + bridge deck. */
export function computeGaps(data) {
  const m = data.markerT;
  return {
    bigJump: [m.gapStart - 0.0002, m.gapEnd + 0.0002],
    kicker: [m.kickStart - 0.0002, m.kickEnd + 0.0002],
    // static ribbon overlaps the deck ends by ~4 m so the ribbon↔segment seam is sealed
    bridge: [m.bridgeDeck + 0.0005, m.bridgeDeckEnd - 0.0005], // 24 separate dynamic segments

  };
}

function inAnyGap(t, gaps) {
  for (const k in gaps) { const g = gaps[k]; if (t >= g[0] && t <= g[1]) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Road ribbon
// ---------------------------------------------------------------------------
// Cross-section (5 verts): left skirt (drop 0.55), left edge, center, right edge, right skirt.
// UV.u: skirts slightly outside 0..1 so the painted lines sit at the road edge proper.
// Vertex color: AO darkening at edges + zone tint + subtle length variation.

const ZONE_TINT = {
  asphalt: new THREE.Color(1.0, 0.97, 0.95),
  dirt: new THREE.Color(1.0, 0.94, 0.85),
  wood: new THREE.Color(1.0, 1.0, 1.0),
  metal: new THREE.Color(0.95, 1.0, 1.05),
  water: new THREE.Color(0.85, 0.95, 1.0),
};

export function buildRoad(data, sampler, materials, gaps) {
  const N = data.N;
  // split frames into contiguous runs of (same surface material, not in gap)
  const runs = [];
  let run = null;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const sname = SURF[data.surf[i]];
    const matKey = sname === 'sand' || sname === 'rock' ? 'dirt' : sname;
    if (inAnyGap(t, gaps)) { run = null; continue; }
    if (!run || run.mat !== matKey) {
      run = { mat: matKey, i0: i, i1: i };
      runs.push(run);
    } else run.i1 = i;
  }

  const byMat = new Map();
  for (const r of runs) {
    if (r.i1 - r.i0 < 2) continue;
    const g = ribbonGeometry(data, r.i0, r.i1, r.mat);
    let arr = byMat.get(r.mat);
    if (!arr) byMat.set(r.mat, (arr = []));
    arr.push(g);
  }

  const meshes = [];
  for (const [mat, geos] of byMat) {
    const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, materials.road[mat]);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `road_${mat}`;
    meshes.push({ mesh, surface: mat === 'water' ? 'water' : mat });
  }
  return meshes;
}

function ribbonGeometry(data, i0, i1, matKey) {
  const count = i1 - i0 + 1;
  const posA = new Float32Array(count * 5 * 3);
  const uvA = new Float32Array(count * 5 * 2);
  const colA = new Float32Array(count * 5 * 3);
  const idx = [];
  const tint = ZONE_TINT[matKey] || ZONE_TINT.asphalt;
  const ds = data.totalLen / (data.N - 1);
  for (let k = 0; k < count; k++) {
    const i = i0 + k;
    _p.fromArray(data.pos, i * 3);
    _t.fromArray(data.tan, i * 3);
    _u.fromArray(data.up, i * 3);
    _r.crossVectors(_t, _u);
    const w = data.width[i], hw = w * 0.5;
    const v = (i * ds) / 3; // texture repeats every 3 m
    const lanes = [
      [-hw - 1.1, -0.55, -0.09, 0.28],
      [-hw, 0, 0.0, 0.82],
      [0, 0.06, 0.5, 1.0],
      [hw, 0, 1.0, 0.82],
      [hw + 1.1, -0.55, 1.09, 0.28],
    ];
    for (let l = 0; l < 5; l++) {
      const [off, drop, uu, ao] = lanes[l];
      const b = (k * 5 + l) * 3;
      posA[b] = _p.x + _r.x * off + _u.x * drop;
      posA[b + 1] = _p.y + _r.y * off + _u.y * drop;
      posA[b + 2] = _p.z + _r.z * off + _u.z * drop;
      uvA[(k * 5 + l) * 2] = uu;
      uvA[(k * 5 + l) * 2 + 1] = v;
      const vary = 0.9 + 0.1 * Math.sin(i * 0.113) * Math.sin(i * 0.041);
      colA[b] = tint.r * ao * vary;
      colA[b + 1] = tint.g * ao * vary;
      colA[b + 2] = tint.b * ao * vary;
    }
    if (k < count - 1) {
      for (let l = 0; l < 4; l++) {
        const a = k * 5 + l, b2 = a + 1, c = a + 5, d = a + 6;
        idx.push(a, b2, c, c, b2, d); // CCW seen from +up → front faces UP (raycastable)
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Chevron decal ribbons before the two jumps (float 6 cm above the deck)
// ---------------------------------------------------------------------------

export function buildChevrons(data, materials, gaps) {
  const spans = [
    [gaps.bigJump[0] - 0.011, gaps.bigJump[0] - 0.0006],
    [gaps.kicker[0] - 0.006, gaps.kicker[0] - 0.0004],
  ];
  const geos = [];
  for (const [t0, t1] of spans) {
    const i0 = Math.max(0, Math.round(t0 * (data.N - 1)));
    const i1 = Math.min(data.N - 1, Math.round(t1 * (data.N - 1)));
    if (i1 - i0 < 2) continue;
    const count = i1 - i0 + 1;
    const posA = new Float32Array(count * 2 * 3);
    const uvA = new Float32Array(count * 2 * 2);
    const idx = [];
    const ds = data.totalLen / (data.N - 1);
    for (let k = 0; k < count; k++) {
      const i = i0 + k;
      _p.fromArray(data.pos, i * 3);
      _t.fromArray(data.tan, i * 3);
      _u.fromArray(data.up, i * 3);
      _r.crossVectors(_t, _u);
      const hw = data.width[i] * 0.44;
      for (let l = 0; l < 2; l++) {
        const off = l === 0 ? -hw : hw;
        const b = (k * 2 + l) * 3;
        posA[b] = _p.x + _r.x * off + _u.x * 0.06;
        posA[b + 1] = _p.y + _r.y * off + _u.y * 0.06;
        posA[b + 2] = _p.z + _r.z * off + _u.z * 0.06;
        uvA[(k * 2 + l) * 2] = l;
        uvA[(k * 2 + l) * 2 + 1] = (i * ds) / 9;
      }
      if (k < count - 1) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // front faces up
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, materials.chevron);
  mesh.matrixAutoUpdate = false;
  mesh.name = 'chevrons';
  return mesh;
}

// ---------------------------------------------------------------------------
// Guard rails — invisible tall collider ribbons along deadly edges (NEVER in gaps
// or flight/landing corridors), plus a visible low metal barrier where it reads well.
// ---------------------------------------------------------------------------

export function buildRails(data, materials, gaps) {
  const m = data.markerT;
  // [t0, t1, sides] sides: 'both'|'left'|'right'  (right = outer of canyon shelf by authoring)
  const spans = [
    [0.004, m.canyon, 'both'],                    // desert sweepers
    [m.canyon, m.jump, 'both'],                   // canyon shelf hairpins — deadly edges
    [m.jump, m.gapStart - 0.0005, 'both'],        // ramp approach + lip sides
    [m.gapEnd + 0.004, m.rockslide, 'both'],      // landing plateau after touchdown zone opens
    [m.loop - 0.002, m.water - 0.002, 'both'],    // loop run-up, loop, exit
    [m.bridge, m.bridgeDeck - 0.0002, 'both'],    // bridge cliff approach
    [m.bridgeDeckEnd + 0.0002, m.finish, 'both'], // off-ramp
    [m.finish, m.kickStart - 0.0005, 'both'],     // final sweeper + kicker sides
    [m.kickEnd + 0.0015, 0.997, 'both'],          // arch + finish gate straight
  ];
  const colGeos = [];
  const visGeos = [];
  for (const [t0, t1] of spans) {
    const i0 = Math.max(0, Math.round(t0 * (data.N - 1)));
    const i1 = Math.min(data.N - 1, Math.round(t1 * (data.N - 1)));
    if (i1 - i0 < 3) continue;
    for (const side of [-1, 1]) {
      colGeos.push(railStrip(data, i0, i1, side, 2.2, 0.75, 4)); // tall invisible wall
      visGeos.push(railStrip(data, i0, i1, side, 0.55, 0.62, 4, 0.32)); // visible W-beam band
    }
  }
  const colMerged = mergeGeometries(colGeos, false);
  colMerged.computeBoundingSphere();
  const collider = new THREE.Mesh(colMerged, materials.invisible);
  collider.name = 'rail_colliders';
  collider.matrixAutoUpdate = false;
  const visMerged = mergeGeometries(visGeos, false);
  visMerged.computeBoundingSphere();
  const visible = new THREE.Mesh(visMerged, materials.guardrail);
  visible.name = 'rail_visible';
  visible.matrixAutoUpdate = false;
  visible.castShadow = false;
  visible.receiveShadow = true;
  return { collider, visible };
}

function railStrip(data, i0, i1, side, height, inset, step, lift = 0) {
  const idxs = [];
  for (let i = i0; i <= i1; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== i1) idxs.push(i1);
  const count = idxs.length;
  const posA = new Float32Array(count * 2 * 3);
  const idx = [];
  for (let k = 0; k < count; k++) {
    const i = idxs[k];
    _p.fromArray(data.pos, i * 3);
    _t.fromArray(data.tan, i * 3);
    _u.fromArray(data.up, i * 3);
    _r.crossVectors(_t, _u);
    const off = side * (data.width[i] * 0.5 + inset);
    for (let l = 0; l < 2; l++) {
      const b = (k * 2 + l) * 3;
      const h = lift + l * height;
      posA[b] = _p.x + _r.x * off + _u.x * h;
      posA[b + 1] = _p.y + _r.y * off + _u.y * h;
      posA[b + 2] = _p.z + _r.z * off + _u.z * h;
    }
    if (k < count - 1) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, // one winding
        a, a + 2, a + 1, a + 1, a + 2, a + 3);       // + reverse → double-sided raycast hits
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Terrain — one big vertex-colored, road-conforming sculpt.
// ---------------------------------------------------------------------------

function vnoise(x, z) { // cheap value-ish noise, stable, no allocation
  const s = Math.sin(x * 0.013 + z * 0.007) * 43758.5453;
  return s - Math.floor(s);
}
function fbm(x, z) {
  let a = 0, amp = 1, fx = x, fz = z, norm = 0;
  for (let o = 0; o < 4; o++) {
    a += amp * (Math.sin(fx * 0.011 + Math.cos(fz * 0.017)) * Math.cos(fz * 0.009 - Math.sin(fx * 0.005)));
    norm += amp; amp *= 0.5; fx = fx * 2.03 + 13.7; fz = fz * 1.97 - 7.3;
  }
  return a / norm; // ~[-1,1]
}

const C_SAND = new THREE.Color(0.80, 0.56, 0.34);
const C_RED = new THREE.Color(0.66, 0.28, 0.16);
const C_ROCKD = new THREE.Color(0.38, 0.20, 0.14);
const C_FOREST = new THREE.Color(0.16, 0.26, 0.13);
const C_RIVER = new THREE.Color(0.42, 0.40, 0.30);
const _col = new THREE.Color();

export function buildTerrain(data, sampler, materials, gaps) {
  // bounds from the lookup samples
  const lk = data.lookup.data;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < data.lookup.n; i++) {
    minX = Math.min(minX, lk[i * 3]); maxX = Math.max(maxX, lk[i * 3]);
    minZ = Math.min(minZ, lk[i * 3 + 2]); maxZ = Math.max(maxZ, lk[i * 3 + 2]);
  }
  const M = 340; // margin
  minX -= M; maxX += M; minZ -= M; maxZ += M;
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  const RES = 320; // (RES+1)² verts ≈ 103k — ~10 m grid over the ~3.3 km sculpt
  const gx = spanX / RES, gz = spanZ / RES;

  const vcount = (RES + 1) * (RES + 1);
  const posA = new Float32Array(vcount * 3);
  const colA = new Float32Array(vcount * 3);
  const uvA = new Float32Array(vcount * 2);

  const m = data.markerT;
  const gorge0 = m.bridgeDeck - 0.004, gorge1 = m.bridgeDeckEnd + 0.004;
  const gap0 = gaps.bigJump[0], gap1 = gaps.bigJump[1];
  const kick0 = gaps.kicker[0], kick1 = gaps.kicker[1];
  const loop0 = data.loopT0, loop1 = data.loopT1;

  // Sample cache for nearest-road queries: use the sampler's cold path (spatial hash).
  const samplePos = new THREE.Vector3();

  let vi = 0;
  for (let iz = 0; iz <= RES; iz++) {
    for (let ix = 0; ix <= RES; ix++) {
      const x = minX + ix * gx, z = minZ + iz * gz;
      // base sculpt: rolling desert + long ridge waves
      let y = fbm(x, z) * 14 + fbm(x * 0.23 + 400, z * 0.23 - 220) * 42;
      // giant rim mountains toward the terrain border (contains the eye)
      const ex = Math.min(x - minX, maxX - x), ez = Math.min(z - minZ, maxZ - z);
      const edge = Math.min(ex, ez);
      if (edge < 300) {
        const k = 1 - edge / 300;
        y += k * k * (120 + fbm(x * 0.6, z * 0.6) * 60);
      }

      // nearest road sample
      const t = sampler.progressAt(x, y, z, -1);
      const rec = sampler.sample(t); // pooled rec
      samplePos.copy(rec.position);
      const dx = x - samplePos.x, dz = z - samplePos.z;
      const distXZ = Math.hypot(dx, dz);
      const latSigned = dx * rec.right.x + dz * rec.right.z;
      const sideSign = Math.sign(latSigned) || 1;
      const w = rec.width * 0.5;
      // deck height AT this lateral offset — on 30° banked sweepers the low edge sits
      // several meters below the centerline, so conform to the banked plane, not center Y.
      const roadY = samplePos.y + rec.right.y * THREE.MathUtils.clamp(latSigned, -w - 2, w + 2);

      const inLoop = t > loop0 - 0.006 && t < loop1 + 0.006;
      const inGorge = t > gorge0 && t < gorge1;
      const inGap = t > gap0 - 0.0015 && t < gap1 + 0.0015;
      const inKick = t > kick0 - 0.001 && t < kick1 + 0.001;
      const zone = data.zoneOf(t);
      const zoneName = data.zoneDefs[zone][0];

      if (inGorge && distXZ < 150) {
        // THE GORGE — sheer 80 m drop under the bridge, river at the bottom
        const k = THREE.MathUtils.smoothstep(distXZ, 26, 130);
        y = roadY - 80 + k * (y - (roadY - 80) + 90) * 0.9 + fbm(x * 2.1, z * 2.1) * 6;
      } else if (inGap && distXZ < 90) {
        // slot canyon under the big jump — deep enough that the kill plane (roadY-60) fires first
        const k = THREE.MathUtils.smoothstep(distXZ, 18, 85);
        y = roadY - 74 + k * 86 + fbm(x * 1.7, z * 1.7) * 5;
      } else if (inKick && distXZ < 26) {
        // kicker gap: harmless sandy dip
        y = Math.min(y, roadY - 3.2 + THREE.MathUtils.smoothstep(distXZ, 6, 24) * 4);
      } else if (!inLoop && distXZ < w + 90) {
        // conform terrain to the roadbed, then zone-shape the surroundings
        const shoulder = THREE.MathUtils.smoothstep(distXZ, w * 0.75, w + 90);
        let wild = y;
        if (zoneName === 'canyon') {
          // cliff shelf: inner wall towers +55, outer side falls away -45
          wild = sideSign < 0
            ? roadY + 55 * THREE.MathUtils.smoothstep(distXZ, w, w + 60) + fbm(x * 1.3, z * 1.3) * 8
            : roadY - 46 * THREE.MathUtils.smoothstep(distXZ, w, w + 70) + fbm(x * 1.3, z * 1.3) * 6;
        } else if (zoneName === 'rockslide') {
          // slot pass: walls both sides
          wild = roadY + 44 * THREE.MathUtils.smoothstep(distXZ, w, w + 55) + fbm(x * 1.6, z * 1.6) * 7;
        } else if (zoneName === 'tunnel') {
          // buried in the mountain
          wild = roadY + 60 * THREE.MathUtils.smoothstep(distXZ, w * 0.9, w + 40);
        } else if (zoneName === 'water') {
          wild = Math.max(y, roadY - 2) * 0.4 + (roadY + 2) * 0.6 + fbm(x * 0.9, z * 0.9) * 3;
        } else {
          wild = Math.max(y, roadY - 18);
        }
        y = (roadY - 0.42) * (1 - shoulder) + wild * shoulder;
      } else if (inLoop && distXZ < w + 50) {
        // ground under the loop: flat industrial pad at run-up level
        const padY = data.pos[Math.round(loop0 * (data.N - 1)) * 3 + 1] - 0.4;
        const k = THREE.MathUtils.smoothstep(distXZ, w + 10, w + 50);
        y = padY * (1 - k) + y * k;
      }

      posA[vi * 3] = x; posA[vi * 3 + 1] = y; posA[vi * 3 + 2] = z;
      uvA[vi * 2] = (x - minX) / spanX; uvA[vi * 2 + 1] = (z - minZ) / spanZ;

      // ---- vertex color script (the color story of the whole level) ----
      const n = vnoise(x, z);
      if (zoneName === 'forest' && distXZ < 260) _col.copy(C_FOREST).offsetHSL(0, 0, (n - 0.5) * 0.06);
      else if (zoneName === 'water' && distXZ < 160) _col.copy(C_RIVER).offsetHSL(0, 0, (n - 0.5) * 0.05);
      else if (y > roadY + 24 || inGorge) _col.copy(C_RED).lerp(C_ROCKD, THREE.MathUtils.clamp((y - roadY) / 90, 0, 1));
      else _col.copy(C_SAND).lerp(C_RED, THREE.MathUtils.clamp(fbm(x * 0.4 + 90, z * 0.4) * 0.5 + 0.35, 0, 1) * 0.55);
      // banded strata on steep rock
      const strata = Math.sin(y * 0.55) * 0.5 + 0.5;
      _col.offsetHSL(0, 0, (strata - 0.5) * 0.045 + (n - 0.5) * 0.03);
      colA[vi * 3] = _col.r; colA[vi * 3 + 1] = _col.g; colA[vi * 3 + 2] = _col.b;
      vi++;
    }
  }

  const idx = new Uint32Array(RES * RES * 6);
  let ii = 0;
  for (let iz = 0; iz < RES; iz++) {
    for (let ix = 0; ix < RES; ix++) {
      const a = iz * (RES + 1) + ix, b = a + 1, c = a + RES + 1, d = c + 1;
      idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
      idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, materials.terrain);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'terrain';
  return { mesh, bounds: { minX, maxX, minZ, maxZ } };
}

// ---------------------------------------------------------------------------
// Water planes (visual only; the ford's drivable surface is the road ribbon tagged 'water')
// ---------------------------------------------------------------------------

export function buildWater(data, sampler, materials) {
  const m = data.markerT;
  const group = new THREE.Group();
  // ford pool
  const fordMid = (m.fordStart + m.fordEnd) / 2;
  const s = sampler.sample(fordMid);
  const ford = new THREE.Mesh(new THREE.PlaneGeometry(340, 200, 1, 1), materials.waterPlane);
  ford.rotation.x = -Math.PI / 2;
  ford.position.set(s.position.x, s.position.y + 0.34, s.position.z);
  ford.name = 'water_ford';
  group.add(ford);
  // gorge river far below the bridge
  const gMid = (m.bridgeDeck + m.bridgeDeckEnd) / 2;
  const s2 = sampler.sample(gMid);
  const river = new THREE.Mesh(new THREE.PlaneGeometry(760, 250, 1, 1), materials.waterPlane);
  river.rotation.x = -Math.PI / 2;
  river.position.set(s2.position.x, s2.position.y - 76, s2.position.z);
  // align river with bridge direction
  river.rotation.z = Math.atan2(s2.tangent.x, s2.tangent.z);
  river.name = 'water_gorge';
  group.add(river);
  group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
  return group;
}
