// spline.js — centerline authoring, rotation-minimizing frames, banking, sampling, progress lookup.
//
// The whole course is authored as a "turtle" march in the XZ plane with an elevation script,
// emitting CatmullRom control points every ~14-38 m. Zone boundaries are recorded as markers
// and refined to exact t after the frames are baked. The 360° stunt loop is IN the centerline:
// 13 control points around a vertical circle (r = 26 m) with an 8 m lateral (helical) shift so
// the exit ribbon does not intersect the entry ribbon.
//
// Frames: N = 3072 arc-length-uniform frames. Up vectors are computed with double-reflection
// rotation-minimizing frames (RMF) so they stay continuous through the vertical loop (no flips),
// then blended back to projected-world-up everywhere OUTSIDE the loop window (RMF drift-free),
// then authored banking (per-zone design speed, curvature-derived, box-blurred) is rolled in
// around the tangent.
import * as THREE from 'three';

export const SURF = ['asphalt', 'dirt', 'sand', 'wood', 'metal', 'water', 'rock'];
export const S_ASPHALT = 0, S_DIRT = 1, S_SAND = 2, S_WOOD = 3, S_METAL = 4, S_WATER = 5, S_ROCK = 6;

const N_FRAMES = 3072;
const N_LOOKUP = 1536;

// ---------------------------------------------------------------------------
// Path authoring
// ---------------------------------------------------------------------------

class Turtle {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, 0);
    this.heading = 0; // radians, 0 = -Z, positive = turn right (toward +X when facing -Z)
    this.points = [];
    this.arc = 0;
    this.markers = {}; // name -> {arc, index}
    this._emit();
  }
  dir(out) {
    // facing -Z at heading 0; right turn rotates toward +X.
    return out.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
  }
  _emit() {
    this.points.push(this.pos.clone());
  }
  mark(name) {
    this.markers[name] = { arc: this.arc, index: this.points.length - 1, pos: this.pos.clone() };
  }
  /** March `len` meters turning `turnDeg` total, climbing `dy` total, control point every `step` m. */
  seg(len, turnDeg, dy, step = 34) {
    const n = Math.max(1, Math.round(len / step));
    const dTurn = THREE.MathUtils.degToRad(turnDeg) / n;
    const dLen = len / n;
    const dDy = dy / n;
    const d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.heading += dTurn * 0.5;
      this.dir(d);
      this.pos.addScaledVector(d, dLen);
      this.heading += dTurn * 0.5;
      this.pos.y += dDy;
      this.arc += Math.hypot(dLen, dDy);
      this._emit();
    }
  }
  /** Vertical 360° loop, radius r, with lateral helical offset so exit clears entry. */
  loop(r, lateralOffset) {
    const d = new THREE.Vector3();
    this.dir(d);
    const right = new THREE.Vector3(-d.z, 0, d.x); // right of travel (y-up)
    const base = this.pos.clone();
    const STEPS = 13; // control points every ~27.7°, CatmullRom rounds them nicely
    for (let i = 1; i <= STEPS; i++) {
      const th = (i / STEPS) * Math.PI * 2;
      this.pos.copy(base)
        .addScaledVector(d, Math.sin(th) * r)
        .addScaledVector(right, (i / STEPS) * lateralOffset);
      this.pos.y = base.y + (1 - Math.cos(th)) * r;
      this._emit();
    }
    this.arc += Math.PI * 2 * r;
  }
}

// Zone definition table: filled with exact t values after baking.
// surfaces + widths + bank design speeds are authored here.
const ZONE_DEFS = [
  // name          surface     width  bankSpeed(m/s) maxBankDeg
  ['desert',       S_ASPHALT,  14.0,  46,            30],
  ['canyon',       S_ASPHALT,  11.0,  30,            32],
  ['jump',         S_ASPHALT,  13.0,  40,            10],
  ['rockslide',    S_DIRT,     12.0,  34,            18],
  ['forest',       S_DIRT,     10.0,  32,            16],
  ['tunnel',       S_WOOD,     10.0,  30,            10],
  ['loop',         S_METAL,    12.0,  40,             6],
  ['water',        S_DIRT,     12.0,  34,            14],
  ['bridge',       S_WOOD,     11.0,  40,             5],
  ['finish',       S_ASPHALT,  14.0,  46,            20],
];

function authorPath() {
  const T = new Turtle();

  // NOTE: cumulative heading sweeps ~+360° over the course so the 8 km path coils into a
  // ~2.5 km horseshoe instead of running off to the horizon (keeps the terrain sculpt dense).
  // --- 0.00 DESERT MESA START — golden hour, banked sweepers (~1160 m) ---
  T.mark('desert');
  T.seg(280, 0, 2);            // grid straight, gentle rise
  T.seg(420, 88, 5, 35);       // big banked sweeper right
  T.seg(120, 4, -2);
  T.seg(340, -34, 4, 34);      // sweeper left            (cum ≈ +58)
  // --- 0.14 CANYON DRIFT GAUNTLET — cliff shelf hairpins (~980 m) ---
  T.mark('canyon');
  T.seg(240, 30, 24, 30);      // climb onto the shelf
  T.seg(230, 158, 6, 20);      // hairpin right (drift!)
  T.seg(150, -16, 2);
  T.seg(230, -132, -4, 20);    // hairpin left
  T.seg(130, 40, -6);          //                          (cum ≈ +138)
  // --- 0.26 THE BIG JUMP (~560 m incl. flight + landing) ---
  //   Ramp lip pitch ≈ 9° (rises 11 m over 70 m). Gap = 62 m. Landing plateau 12 m BELOW lip.
  //   Projectile check (y measured from lip, g = 9.81):
  //     v = 29 m/s, θ=9°:  lands y=-12 at x ≈  66 m  → just clears the 62 m gap.
  //     v = 45 m/s:        lands at x ≈ 105 m        → mid-plateau.
  //     v = 65 m/s (flat out + boost): t from -12 = 10.17t - 4.905t² → t=2.91 s, x ≈ 187 m.
  //   So the landing plateau extends 235 m past the lip. Anything ≥ ~29 m/s clears; the
  //   approach is a long straight so even a coasting car carries 40+.
  T.mark('jump');
  T.seg(200, -4, -4);          // approach straight, slight drop (build speed)
  T.seg(70, 0, 11, 23);        // THE RAMP — 9° lip
  T.mark('gapStart');
  T.seg(31, 0, -3.4, 15.5);    // spline arcs over the void (ribbon is SKIPPED here)
  T.seg(31, 0, -8.6, 15.5);
  T.mark('gapEnd');
  T.seg(235, 4, -6, 30);       // landing plateau, long + slightly downhill = soft catches
  // --- 0.32 ROCKSLIDE PASS — canyon floor, boulders cross the road (~820 m) ---
  T.mark('rockslide');
  T.seg(220, 46, -8, 30);
  T.seg(240, -34, -4, 30);
  T.seg(200, 44, 2, 30);
  T.seg(160, 8, 0);            //                          (cum ≈ +198)
  // --- 0.42 FOREST RUN — fog, pines, dirt, breakable fences (~1100 m) ---
  T.mark('forest');
  T.seg(240, -34, 10, 30);
  T.seg(260, 58, 8, 30);
  T.seg(240, -36, -4, 30);
  T.seg(220, 44, 6, 30);
  T.seg(140, 18, -2);          //                          (cum ≈ +248)
  // --- 0.55 MINE TUNNEL — supports collapse behind you (~560 m) ---
  T.mark('tunnel');
  T.seg(180, 16, -6, 30);
  T.seg(200, -14, -8, 30);
  T.seg(180, 30, -2, 30);      //                          (cum ≈ +280)
  T.mark('tunnelEnd');
  // --- 0.64 THE LOOP — giant 360° stunt loop, r = 26 m (~640 m zone) ---
  //   v_top ≥ √(g·r) = √(9.81·26) ≈ 16 m/s to hold the top ballistically; physics adds
  //   adhesion assist, entry speeds are 40+. Helical lateral shift 8 m keeps ribbons clear.
  T.mark('loop');
  T.seg(210, 0, 0);            // dead straight run-up
  T.mark('loopCircle');
  T.loop(26, 8);
  T.mark('loopCircleEnd');
  T.seg(240, 6, -2);           // exit straight
  // --- 0.72 WATER CROSSING — shallow river ford (~620 m) ---
  T.mark('water');
  T.seg(170, -26, -14, 30);    // drop to the river flat
  T.mark('fordStart');
  T.seg(120, 8, 0, 30);        // THE FORD — surface 'water'
  T.mark('fordEnd');
  T.seg(160, 34, 10, 30);      // climb out
  T.seg(170, 14, 8, 30);       //                          (cum ≈ +316)
  // --- 0.80 THE COLLAPSING BRIDGE — gorge crossing, segments explode behind you (~1060 m) ---
  T.mark('bridge');
  T.seg(230, 18, 10, 30);      // cliff approach
  T.mark('bridgeDeck');
  T.seg(504, 8, 0, 28);        // THE BRIDGE — 24 segments × 21 m over an 80 m deep gorge
  T.mark('bridgeDeckEnd');
  T.seg(300, -14, -6, 30);     // off-ramp to the sunset flats  (cum ≈ +328)
  // --- 0.93 SUNSET FINISH — kicker through a flaming arch (~620 m) ---
  //   Kicker: 6.5° lip, 16 m gap, lands 2 m low. v_min ≈ 18 m/s. At 60 m/s touchdown ≈ 97 m
  //   past the lip; the straight is flat for 150 m after the kicker. Arch at +58 m — a fast
  //   car flies THROUGH it (~+2 m altitude), a slow car drives under it. Aperture 15×12 m.
  T.mark('finish');
  T.seg(200, 36, -8, 30);      // sweeping right onto the final straight (cum ≈ +364)
  T.seg(120, 0, -2);
  T.seg(22, 0, 2.5, 11);       // kicker lip (6.5°)
  T.mark('kickStart');
  T.seg(16, 0, -2.5, 8);       // kicker gap (ribbon skipped; shallow sand dip below)
  T.mark('kickEnd');
  T.seg(120, 0, -0.5, 24);     // arch + landing
  T.mark('finishGate');
  T.seg(110, -4, 0);           // run-off past the gate
  T.mark('end');

  return T;
}

// ---------------------------------------------------------------------------
// Frame baking
// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

export function buildTrackData() {
  const T = authorPath();
  const curve = new THREE.CatmullRomCurve3(T.points, false, 'centripetal', 0.5);
  curve.arcLengthDivisions = 4000;
  const totalLen = curve.getLength();

  const N = N_FRAMES;
  const pos = new Float32Array(N * 3);
  const tan = new Float32Array(N * 3);
  const up = new Float32Array(N * 3);
  const curv = new Float32Array(N); // signed curvature (1/m), + = left turn

  // 1) positions + tangents, arc-length uniform
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    tan[i * 3] = t.x; tan[i * 3 + 1] = t.y; tan[i * 3 + 2] = t.z;
  }
  const ds = totalLen / (N - 1);

  // 2) RMF via double reflection (Wang et al.), seeded with projected world-up.
  const rmf = new Float32Array(N * 3);
  {
    const t0 = _v1.set(tan[0], tan[1], tan[2]);
    const r0 = _v2.set(0, 1, 0).addScaledVector(t0, -t0.y).normalize();
    rmf[0] = r0.x; rmf[1] = r0.y; rmf[2] = r0.z;
    const xi = new THREE.Vector3(), xn = new THREE.Vector3(), ti = new THREE.Vector3(),
      tn = new THREE.Vector3(), ri = new THREE.Vector3(), v1 = new THREE.Vector3(),
      v2 = new THREE.Vector3(), rL = new THREE.Vector3(), tL = new THREE.Vector3();
    for (let i = 0; i < N - 1; i++) {
      xi.fromArray(pos, i * 3); xn.fromArray(pos, (i + 1) * 3);
      ti.fromArray(tan, i * 3); tn.fromArray(tan, (i + 1) * 3);
      ri.fromArray(rmf, i * 3);
      v1.subVectors(xn, xi);
      const c1 = Math.max(1e-10, v1.lengthSq());
      rL.copy(ri).addScaledVector(v1, (-2 / c1) * v1.dot(ri));
      tL.copy(ti).addScaledVector(v1, (-2 / c1) * v1.dot(ti));
      v2.subVectors(tn, tL);
      const c2 = Math.max(1e-10, v2.lengthSq());
      rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL)).normalize();
      rmf[(i + 1) * 3] = rL.x; rmf[(i + 1) * 3 + 1] = rL.y; rmf[(i + 1) * 3 + 2] = rL.z;
    }
  }

  // 3) refine marker t values (nearest frame to authored marker positions)
  const markerT = {};
  for (const name in T.markers) {
    const mp = T.markers[name].pos;
    let best = 0, bd = Infinity;
    const guess = Math.round((T.markers[name].arc / T.arc) * (N - 1));
    const lo = Math.max(0, guess - 200), hi = Math.min(N - 1, guess + 200);
    for (let i = lo; i <= hi; i++) {
      const dx = pos[i * 3] - mp.x, dy = pos[i * 3 + 1] - mp.y, dz = pos[i * 3 + 2] - mp.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    markerT[name] = best / (N - 1);
  }

  // Loop window: only region where up is driven purely by RMF.
  const loopT0 = markerT.loopCircle - 0.004, loopT1 = markerT.loopCircleEnd + 0.004;
  const BLEND = 0.006;

  // 4) blend RMF → projected-world-up outside loop, then apply banking.
  //    Zone lookup per frame:
  const zoneStarts = ZONE_DEFS.map(([name]) => markerT[name]);
  const zoneOf = (t) => {
    let z = 0;
    for (let i = 0; i < zoneStarts.length; i++) if (t >= zoneStarts[i]) z = i;
    return z;
  };

  // signed curvature from tangent deltas in the road plane
  {
    const ti = new THREE.Vector3(), tn = new THREE.Vector3(), cr = new THREE.Vector3(), u0 = new THREE.Vector3();
    for (let i = 0; i < N - 1; i++) {
      ti.fromArray(tan, i * 3); tn.fromArray(tan, (i + 1) * 3);
      u0.fromArray(rmf, i * 3);
      cr.crossVectors(ti, tn);
      const ang = Math.asin(THREE.MathUtils.clamp(cr.length(), -1, 1));
      curv[i] = (ang / ds) * Math.sign(cr.dot(u0) || 1); // + = left turn
    }
    curv[N - 1] = curv[N - 2];
  }

  // banking targets, then box blur (2 passes, window ±40 frames ≈ ±100 m)
  const bank = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = zoneOf(t);
    const vDes = ZONE_DEFS[z][3], maxB = THREE.MathUtils.degToRad(ZONE_DEFS[z][4]);
    let b = Math.atan((vDes * vDes * Math.abs(curv[i])) / 9.81);
    b = Math.min(b, maxB) * -Math.sign(curv[i]); // right turn (curv<0) → positive roll = right edge dips
    // kill authored banking near/inside loop + gaps (RMF/flat)
    if (t > loopT0 - BLEND && t < loopT1 + BLEND) b = 0;
    bank[i] = b;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = bank.slice();
    const W = 40;
    let acc = 0;
    for (let i = -W; i <= W; i++) acc += src[THREE.MathUtils.clamp(i, 0, N - 1)];
    for (let i = 0; i < N; i++) {
      bank[i] = acc / (2 * W + 1);
      const drop = THREE.MathUtils.clamp(i - W, 0, N - 1);
      const add = THREE.MathUtils.clamp(i + W + 1, 0, N - 1);
      acc += src[add] - src[drop];
    }
  }

  {
    const ti = new THREE.Vector3(), ru = new THREE.Vector3(), du = new THREE.Vector3(), cr = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      ti.fromArray(tan, i * 3);
      ru.fromArray(rmf, i * 3);
      // desired = projected world up
      du.set(0, 1, 0).addScaledVector(ti, -ti.y);
      let w = 1; // weight of "snap to world up"
      if (t > loopT0 && t < loopT1) w = 0;
      else if (t > loopT0 - BLEND && t <= loopT0) w = (loopT0 - t) / BLEND;
      else if (t >= loopT1 && t < loopT1 + BLEND) w = (t - loopT1) / BLEND;
      if (du.lengthSq() < 1e-6) w = 0; // vertical tangent → keep RMF
      if (w > 0) {
        du.normalize();
        cr.crossVectors(ru, du);
        const a = Math.atan2(cr.dot(ti), ru.dot(du));
        _q1.setFromAxisAngle(ti, a * w);
        ru.applyQuaternion(_q1);
      }
      // authored banking roll
      if (bank[i] !== 0) {
        _q1.setFromAxisAngle(ti, bank[i]);
        ru.applyQuaternion(_q1);
      }
      // re-orthogonalize
      ru.addScaledVector(ti, -ru.dot(ti)).normalize();
      up[i * 3] = ru.x; up[i * 3 + 1] = ru.y; up[i * 3 + 2] = ru.z;
    }
  }

  // 5) per-frame width + surface (smooth width transitions over ~80 m)
  const width = new Float32Array(N);
  const surf = new Uint8Array(N);
  const fordT0 = markerT.fordStart, fordT1 = markerT.fordEnd;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = zoneOf(t);
    width[i] = ZONE_DEFS[z][2];
    surf[i] = ZONE_DEFS[z][1];
    if (t >= fordT0 - 0.001 && t <= fordT1 + 0.001) surf[i] = S_WATER;
  }
  { // width smoothing
    const src = width.slice();
    const W = 16;
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let j = -W; j <= W; j++) a += src[THREE.MathUtils.clamp(i + j, 0, N - 1)];
      width[i] = a / (2 * W + 1);
    }
  }

  // 6) progress lookup grid
  const lk = new Float32Array(N_LOOKUP * 3);
  for (let i = 0; i < N_LOOKUP; i++) {
    const fi = (i / (N_LOOKUP - 1)) * (N - 1);
    const a = Math.floor(fi), f = fi - a, b = Math.min(N - 1, a + 1);
    lk[i * 3] = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * f;
    lk[i * 3 + 1] = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * f;
    lk[i * 3 + 2] = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * f;
  }
  // XZ spatial hash of lookup samples (cell 32 m) for cold global queries
  const CELL = 32;
  const hash = new Map();
  for (let i = 0; i < N_LOOKUP; i++) {
    const key = ((lk[i * 3] / CELL) | 0) * 73856 + ((lk[i * 3 + 2] / CELL) | 0);
    let arr = hash.get(key);
    if (!arr) hash.set(key, (arr = []));
    arr.push(i);
  }

  return {
    curve, totalLen, N, pos, tan, up, width, surf, curv, bank,
    markerT, zoneDefs: ZONE_DEFS, zoneStarts, zoneOf,
    loopT0: markerT.loopCircle, loopT1: markerT.loopCircleEnd,
    lookup: { data: lk, n: N_LOOKUP, cell: CELL, hash },
  };
}

// ---------------------------------------------------------------------------
// Runtime sampling (zero-alloc: pooled sample records)
// ---------------------------------------------------------------------------

function makeSampleRecord() {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    width: 12,
    surface: 'asphalt',
  };
}

export class TrackSampler {
  constructor(data) {
    this.d = data;
    // rotating pool: callers use the record immediately or copy it out.
    this._pool = [];
    for (let i = 0; i < 32; i++) this._pool.push(makeSampleRecord());
    this._poolI = 0;
  }

  sample(t, out) {
    const d = this.d;
    const rec = out || this._pool[this._poolI = (this._poolI + 1) & 31];
    t = THREE.MathUtils.clamp(t, 0, 1);
    const fi = t * (d.N - 1);
    const a = Math.floor(fi), f = fi - a, b = Math.min(d.N - 1, a + 1);
    const p = rec.position, tn = rec.tangent, u = rec.up;
    p.set(
      d.pos[a * 3] + (d.pos[b * 3] - d.pos[a * 3]) * f,
      d.pos[a * 3 + 1] + (d.pos[b * 3 + 1] - d.pos[a * 3 + 1]) * f,
      d.pos[a * 3 + 2] + (d.pos[b * 3 + 2] - d.pos[a * 3 + 2]) * f,
    );
    tn.set(
      d.tan[a * 3] + (d.tan[b * 3] - d.tan[a * 3]) * f,
      d.tan[a * 3 + 1] + (d.tan[b * 3 + 1] - d.tan[a * 3 + 1]) * f,
      d.tan[a * 3 + 2] + (d.tan[b * 3 + 2] - d.tan[a * 3 + 2]) * f,
    ).normalize();
    u.set(
      d.up[a * 3] + (d.up[b * 3] - d.up[a * 3]) * f,
      d.up[a * 3 + 1] + (d.up[b * 3 + 1] - d.up[a * 3 + 1]) * f,
      d.up[a * 3 + 2] + (d.up[b * 3 + 2] - d.up[a * 3 + 2]) * f,
    );
    u.addScaledVector(tn, -u.dot(tn)).normalize();
    rec.right.crossVectors(tn, u);
    rec.width = d.width[a] + (d.width[b] - d.width[a]) * f;
    rec.surface = SURF[d.surf[f > 0.5 ? b : a]];
    return rec;
  }

  /** Nearest t to a world position. `hint` (previous t) makes it a ~60-sample local search. */
  progressAt(px, py, pz, hint = -1) {
    const { data, n, cell, hash } = this.d.lookup;
    let best = -1, bd = Infinity;
    let localBest = -1, localBd = Infinity;
    if (hint >= 0) {
      const c = Math.round(hint * (n - 1));
      const lo = Math.max(0, c - 120), hi = Math.min(n - 1, c + 120);
      for (let i = lo; i <= hi; i++) {
        const dx = data[i * 3] - px, dy = data[i * 3 + 1] - py, dz = data[i * 3 + 2] - pz;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = i; }
      }
      if (bd < 45 * 45) return this._refine(best, px, py, pz);
      localBest = best; localBd = bd; // keep as sticky fallback
    }
    // cold / lost: spatial hash 3×3 cells, fall back to full scan
    best = -1; bd = Infinity;
    const cx = (px / cell) | 0, cz = (pz / cell) | 0;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const arr = hash.get((cx + ox) * 73856 + (cz + oz));
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const i = arr[k];
        const dx = data[i * 3] - px, dy = data[i * 3 + 1] - py, dz = data[i * 3 + 2] - pz;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = i; }
      }
    }
    if (best < 0) {
      for (let i = 0; i < n; i++) {
        const dx = data[i * 3] - px, dy = data[i * 3 + 1] - py, dz = data[i * 3 + 2] - pz;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = i; }
      }
    }
    // Sticky hint: an off-road car (e.g. mid-desert inside the horseshoe) must not teleport its
    // progress to a far branch of the coil. Only accept the global answer when it is at least
    // 2x closer than the best sample near the previous t (true after respawns, never from drift).
    if (localBest >= 0 && !(bd < localBd * 0.25)) {
      return this._refine(localBest, px, py, pz);
    }
    return this._refine(best, px, py, pz);
  }

  /** Parabolic-ish refinement: project onto the two segments adjacent to the best sample. */
  _refine(i, px, py, pz) {
    const { data, n } = this.d.lookup;
    let bestT = i / (n - 1);
    let bd = Infinity;
    for (let s = Math.max(0, i - 1); s <= Math.min(n - 2, i + 1); s++) {
      const ax = data[s * 3], ay = data[s * 3 + 1], az = data[s * 3 + 2];
      const bx = data[(s + 1) * 3] - ax, by = data[(s + 1) * 3 + 1] - ay, bz = data[(s + 1) * 3 + 2] - az;
      const len2 = bx * bx + by * by + bz * bz;
      let u = len2 > 1e-9 ? ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / len2 : 0;
      u = THREE.MathUtils.clamp(u, 0, 1);
      const dx = ax + bx * u - px, dy = ay + by * u - py, dz = az + bz * u - pz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) { bd = dd; bestT = (s + u) / (n - 1); }
    }
    return bestT;
  }
}
