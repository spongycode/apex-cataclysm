// ============================================================================
// APEX: CATACLYSM CANYON — CameraSystem (SPEC §9)
// The camera director. Owns ctx.camera completely.
//   mode 0: chase       — spring-damped, velocity-blended anchor, speed FOV
//   mode 1: close chase — tighter, lower, more violent
//   mode 2: hood        — bolted to chassis, rpm vibration
// Plus: menu aerial showcase dolly, countdown swoop, finish orbit, trauma
// shake, slow-mo hooks, terrain occlusion pull-in.
// Zero per-frame allocations: everything below the class is pooled.
// ============================================================================
import * as THREE from 'three';

// ---- pooled temporaries (module scope, never allocated in update) ----------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _v8 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4();
const _UP = new THREE.Vector3(0, 1, 0);
const _sd = { p: 0, v: 0 };

const DEG = Math.PI / 180;

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

// Smooth band-limited pseudo-perlin noise, ~[-1, 1], cheap & allocation-free.
function noise1(t) {
  return Math.sin(t * 1.37) * 0.50 +
         Math.sin(t * 2.93 + 1.71) * 0.30 +
         Math.sin(t * 6.11 + 4.13) * 0.20;
}

// Critically-damped smooth-damp (scalar). Results in module pool `_sd`.
function sdamp(cur, target, vel, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  _sd.v = (vel - omega * temp) * e;
  _sd.p = target + (change + temp) * e;
  return _sd;
}

// ---- per-mode tuning -------------------------------------------------------
const CHASE_MODES = [
  { // 0: chase — the money shot
    dist: 5.2, distMax: 7.0, height: 1.9, lookH: 1.0,
    fov: 62, fovRamp: 18, fovBoost: 6,
    stXZ: 0.085, stY: 0.15, stYAir: 0.50, stLook: 0.07,
    shakeMul: 1.0, velBlend: 0.55,
  },
  { // 1: close chase — intense
    dist: 3.4, distMax: 4.35, height: 1.28, lookH: 0.82,
    fov: 70, fovRamp: 11, fovBoost: 6,
    stXZ: 0.06, stY: 0.11, stYAir: 0.40, stLook: 0.055,
    shakeMul: 1.65, velBlend: 0.62,
  },
];

const HOOD = { fov: 78, fovRamp: 3.5, fovBoost: 2.5, offX: 0, offY: 0.62, offZ: -0.55 };

// Menu showcase shots: aerial dollies past the set pieces (t along spline).
// Hard cuts between shots, ~6 s each. side = lateral offset (m, signed along
// road right), h = height above road, lookH = look height offset at focus.
const MENU_SHOTS = [
  { t0: 0.004, t1: 0.050, focus: 0.024, side:  17, h:  9,  lookH: 2.5, fov: 57 }, // start mesa grid
  { t0: 0.230, t1: 0.300, focus: 0.275, side: -32, h: 22,  lookH: 4.0, fov: 55 }, // THE BIG JUMP gap
  { t0: 0.615, t1: 0.665, focus: 0.640, side:  26, h: 14,  lookH: 11,  fov: 56 }, // THE LOOP
  { t0: 0.775, t1: 0.835, focus: 0.805, side: -27, h: 17,  lookH: -3,  fov: 55 }, // collapsing bridge gorge
  { t0: 0.905, t1: 0.965, focus: 0.936, side:  14, h:  7,  lookH: 3.0, fov: 58 }, // sunset finish arch
];
const SHOT_LEN = 6.0;

const SLOWMO_COOLDOWN = 20;   // s between airborne slow-mo beats
const SLOWMO_DURATION = 1.4;

export class CameraSystem {
  constructor(ctx) {
    this.ctx = ctx;

    // Spring state (position + look target, velocities per axis).
    this._pos = new THREE.Vector3(0, 30, 60);
    this._posVel = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._lookVel = new THREE.Vector3();
    this._snap = true;              // next drive frame: hard-set springs

    // Smoothed helpers.
    this._roadUp = new THREE.Vector3(0, 1, 0);
    this._upMix = new THREE.Vector3(0, 1, 0);
    this._occl = 1;                 // 0..1 fraction of desired camera distance
    this._roll = 0;                 // smoothed camera roll (drift + cinematic)
    this._boostK = 0;               // smoothed 0..1 boosting envelope
    this._fov = 64;
    this._fovTarget = 62;

    // Trauma shake.
    this._trauma = 0;
    this._traumaDecay = 1.4;

    // Landing dip.
    this._dipT = 99;                // seconds since landing (99 = idle)
    this._dipAmp = 0;

    // Slow-mo cinematic beat.
    this._cineUntil = -99;
    this._lastSlowmo = -99;
    this._time = 0;

    // Phase-driven cinematics.
    this._prevPhase = 'loading';
    this._menuT = 0;
    this._menuShot = -1;
    this._cdSide = 1;               // countdown sweep side (±1)
    this._orbitA = 0;
    this._orbitInit = false;
  }

  async init() {
    const ev = this.ctx.events;

    ev.on('camera:shake', (p) => {
      if (!p) return;
      const i = clamp(+p.intensity || 0, 0, 1);
      const d = Math.max(0.12, +p.duration || 0.4);
      this._trauma = Math.min(1.25, this._trauma + i);
      this._traumaDecay = Math.max(0.8, this._trauma / d);
    });

    ev.on('car:landed', (p) => {
      const impact = p ? Math.abs(+p.impactSpeed || 0) : 0;
      const i = clamp(impact / 22, 0.08, 0.85);
      this._trauma = Math.min(1.25, this._trauma + i * 0.7);
      this._traumaDecay = Math.max(0.9, this._trauma / 0.55);
      this._dipT = 0;
      this._dipAmp = clamp(0.25 * (0.45 + impact / 18), 0.1, 0.42);
    });

    ev.on('car:collision', (p) => {
      const s = p ? Math.abs(+p.speed || 0) : 0;
      const i = clamp(s / 34, 0.08, 0.75);
      this._trauma = Math.min(1.25, this._trauma + i);
      this._traumaDecay = Math.max(1.0, this._trauma / 0.5);
    });

    // Cinematic slow-mo on BIG air only: fast + genuinely airborne, throttled.
    ev.on('car:jump', (p) => this._onJump(p));

    ev.on('car:respawn', () => { this._snap = true; this._trauma = 0; this._dipT = 99; });
    ev.on('race:restart', () => {
      this._snap = true;
      this._trauma = 0;
      this._dipT = 99;
      this._cineUntil = -99;
      this._lastSlowmo = -99;
      this._orbitInit = false;
      this._menuT = 0;
      this._menuShot = -1;
    });

    ev.on('race:finish', () => { this._orbitInit = false; });

    // Start somewhere sane before the first menu frame lands.
    const cam = this.ctx.camera;
    cam.position.set(0, 40, 90);
    cam.lookAt(0, 0, 0);
    this._fov = cam.fov;
  }

  _onJump(p) {
    const st = this.ctx.state;
    if (!st || st.phase !== 'racing') return;
    if (this._time - this._lastSlowmo < SLOWMO_COOLDOWN) return;
    // Payload speed units are ambiguous in the wild; trust state.car (km/h)
    // and accept payload if it already reads as km/h.
    const raw = p ? +p.speed || 0 : 0;
    const kmh = Math.max(st.car ? st.car.speedKmh || 0 : 0, raw > 90 ? raw : raw * 3.6);
    const vy = st.car && st.car.velocity ? st.car.velocity.y : 0;
    if (kmh < 150 || vy < 5) return; // must be fast AND properly launched
    this._lastSlowmo = this._time;
    this._cineUntil = this._time + SLOWMO_DURATION;
    this.ctx.events.emit('time:slowmo', { scale: 0.3, duration: SLOWMO_DURATION });
    this.ctx.events.emit('camera:shake', { intensity: 0.3, duration: 0.7 });
  }

  // --------------------------------------------------------------------------
  update(dt, time) {
    const ctx = this.ctx;
    const st = ctx.state;
    const cam = ctx.camera;
    if (!st || !st.car || !cam) return;
    if (!(dt > 0)) dt = 1e-4;
    this._time = time;

    // Trauma decay (uses scaled dt — slow-mo stretches shakes, feels right).
    if (this._trauma > 0) {
      this._trauma = Math.max(0, this._trauma - this._traumaDecay * dt);
    }
    if (this._dipT < 10) this._dipT += dt;

    const phase = st.phase;
    if (phase !== this._prevPhase) {
      this._onPhaseChange(phase, this._prevPhase);
      this._prevPhase = phase;
    }

    try {
      if (phase === 'menu') this._updateMenu(dt, time);
      else if (phase === 'countdown') this._updateCountdown(dt, time);
      else if (phase === 'finished') this._updateOrbit(dt, time);
      else this._updateDrive(dt, time); // 'racing' (and any fallback)
    } catch (err) {
      // Defensive: a missing system's data must never kill the frame.
    }

    this._applyShake(dt, time);
    this._applyFov(dt);
  }

  _onPhaseChange(next, prev) {
    if (next === 'countdown') {
      this._cdSide = (Math.floor(this._menuT) & 1) ? -1 : 1; // deterministic-ish variety
      this._snap = false;
    } else if (next === 'racing') {
      // Hand off springs from wherever the sweep left the camera — seamless.
      this._pos.copy(this.ctx.camera.position);
      this._posVel.set(0, 0, 0);
      this._lookVel.set(0, 0, 0);
      this._snap = false;
    } else if (next === 'menu') {
      this._menuT = 0;
      this._menuShot = -1;
    } else if (next === 'finished') {
      this._orbitInit = false;
    }
  }

  // ---- MENU: cinematic aerial dolly across the set pieces -------------------
  _updateMenu(dt, time) {
    const trk = this.ctx.track;
    const cam = this.ctx.camera;
    if (!trk || !trk.sample) { this._fovTarget = 58; return; }

    this._menuT += dt;
    const idx = Math.floor(this._menuT / SHOT_LEN) % MENU_SHOTS.length;
    const u = (this._menuT % SHOT_LEN) / SHOT_LEN;
    const shot = MENU_SHOTS[idx];
    this._menuShot = idx;

    // Camera dolly point along the road (copy immediately — sample() pools).
    const tCam = shot.t0 + (shot.t1 - shot.t0) * u;
    const sc = trk.sample(clamp01(tCam));
    _v1.copy(sc.position);          // road point under camera
    _v2.copy(sc.right);
    _v1.addScaledVector(_v2, shot.side).addScaledVector(_UP, shot.h);
    // Gentle vertical breathe so the dolly never feels rail-locked.
    _v1.y += Math.sin(time * 0.4 + idx * 2.1) * 1.2;

    // Look at the set piece (focus point), drifting slightly along the road.
    const sf = trk.sample(clamp01(shot.focus + (u - 0.5) * 0.006));
    _v3.copy(sf.position).addScaledVector(_UP, shot.lookH);

    cam.position.copy(_v1);
    _m1.lookAt(_v1, _v3, _UP);
    cam.quaternion.setFromRotationMatrix(_m1);

    // Keep springs synced so the countdown cut has valid state behind it.
    this._pos.copy(_v1);
    this._look.copy(_v3);
    this._posVel.set(0, 0, 0);
    this._lookVel.set(0, 0, 0);

    // Slow push-in per shot: subtle zoom sells scale.
    this._fovTarget = shot.fov - 3 * smoothstep01(u);
    this._roll = 0;
  }

  // ---- COUNTDOWN: swoop from front of car around into chase, arrive by GO ---
  _updateCountdown(dt, time) {
    const st = this.ctx.state;
    const cam = this.ctx.camera;
    const car = st.car;
    if (!car || !car.position) return;

    const u = clamp01((3 - st.countdown) / 3);
    const e = smoothstep01(u);

    // Car frame.
    _v1.copy(car.position);
    _v2.set(0, 0, -1).applyQuaternion(car.quaternion); // forward
    _v2.y = 0;
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, -1); else _v2.normalize();

    // Arc: theta 0 = dead ahead of the car, PI = directly behind.
    const theta = lerp(0.32, Math.PI, e) * this._cdSide;
    _q1.setFromAxisAngle(_UP, theta);
    _v3.copy(_v2).applyQuaternion(_q1); // offset direction from car

    const p = CHASE_MODES[0];
    const radius = lerp(9.0, p.dist, e);
    const height = lerp(2.3, p.height, e);
    _v4.copy(_v1).addScaledVector(_v3, radius).addScaledVector(_UP, height);

    // Look: hero-shot at the car early, easing to the chase look-ahead point.
    _v5.copy(_v1).addScaledVector(_UP, 0.9);                       // at the car
    _v6.copy(_v1).addScaledVector(_v2, 6).addScaledVector(_UP, p.lookH); // ahead
    _v5.lerp(_v6, e);

    cam.position.copy(_v4);
    _m1.lookAt(_v4, _v5, _UP);
    cam.quaternion.setFromRotationMatrix(_m1);

    // Sync springs continuously → zero-pop handoff at GO.
    this._pos.copy(_v4);
    this._look.copy(_v5);
    this._posVel.set(0, 0, 0);
    this._lookVel.set(0, 0, 0);
    this._roadUp.set(0, 1, 0);

    this._fovTarget = lerp(50, p.fov, e);
    this._roll = 0;
  }

  // ---- FINISHED: slow victory orbit -----------------------------------------
  _updateOrbit(dt, time) {
    const st = this.ctx.state;
    const cam = this.ctx.camera;
    const car = st.car;
    if (!car || !car.position) return;

    if (!this._orbitInit) {
      this._orbitInit = true;
      const dx = cam.position.x - car.position.x;
      const dz = cam.position.z - car.position.z;
      this._orbitA = Math.atan2(dx, dz); // start from current bearing, no snap
    }
    this._orbitA += 0.25 * dt;

    const bob = Math.sin(time * 0.55) * 0.7;
    _v1.set(
      car.position.x + Math.sin(this._orbitA) * 9,
      car.position.y + 2.1 + bob,
      car.position.z + Math.cos(this._orbitA) * 9
    );
    _v2.copy(car.position).addScaledVector(_UP, 0.7);

    // Ease into the orbit path through the springs (soft, cinematic).
    this._springTo(_v1, _v2, 0.4, 0.4, 0.3, dt);

    cam.position.copy(this._pos);
    _m1.lookAt(this._pos, this._look, _UP);
    cam.quaternion.setFromRotationMatrix(_m1);

    this._fovTarget = 54;
    this._roll += (Math.sin(time * 0.3) * 0.8 * DEG - this._roll) * Math.min(1, 2 * dt);
    this._applyRoll(cam);
  }

  // ---- RACING: chase / close chase / hood ------------------------------------
  _updateDrive(dt, time) {
    const st = this.ctx.state;
    const mode = st.settings ? (st.settings.cameraMode | 0) % 3 : 0;
    if (mode === 2) this._updateHood(dt, time);
    else this._updateChase(dt, time, CHASE_MODES[mode] || CHASE_MODES[0]);
  }

  _updateHood(dt, time) {
    const st = this.ctx.state;
    const cam = this.ctx.camera;
    const car = st.car;
    if (!car || !car.position) return;

    // Bolted to the chassis at the windshield.
    _v1.set(HOOD.offX, HOOD.offY, HOOD.offZ).applyQuaternion(car.quaternion);
    _v1.add(car.position);

    // Subtle engine vibration keyed to rpm (positional, chassis-local).
    const rpm = clamp01(car.rpm || 0);
    const vib = 0.006 * (0.35 + rpm) + (car.boosting ? 0.004 : 0);
    _v2.set(
      noise1(time * 41.0) * vib,
      noise1(time * 47.3 + 9.1) * vib,
      0
    ).applyQuaternion(car.quaternion);
    _v1.add(_v2);

    cam.position.copy(_v1);
    cam.quaternion.copy(car.quaternion);

    // Keep springs trailing so switching back to chase doesn't teleport.
    this._pos.copy(_v1);
    this._look.copy(car.position).addScaledVector(_v3.set(0, 0, -1).applyQuaternion(car.quaternion), 10);
    this._posVel.set(0, 0, 0);
    this._lookVel.set(0, 0, 0);

    const speed01 = clamp01((car.speedKmh || 0) / 240);
    this._boostK += ((car.boosting ? 1 : 0) - this._boostK) * Math.min(1, 5 * dt);
    this._fovTarget = HOOD.fov + HOOD.fovRamp * speed01 + HOOD.fovBoost * this._boostK;
    this._roll = 0;
  }

  _updateChase(dt, time, p) {
    const ctx = this.ctx;
    const st = ctx.state;
    const cam = ctx.camera;
    const car = st.car;
    if (!car || !car.position || !car.quaternion) return;

    const carPos = car.position;
    const vel = car.velocity;
    const speed = vel ? vel.length() : 0;
    const speed01 = clamp01((car.speedKmh || speed * 3.6) / 240);

    // --- Anchor direction: chassis forward blended with velocity direction.
    // This is what makes drifts read — the car yaws away from its motion and
    // the camera keeps trailing the MOTION, showing the car at an angle.
    _v1.set(0, 0, -1).applyQuaternion(car.quaternion); // chassis forward
    if (vel && speed > 2.5) _v2.copy(vel).multiplyScalar(1 / speed);
    else _v2.copy(_v1);
    const blend = clamp01((speed - 2.5) / 10) * p.velBlend;
    _v3.copy(_v1).lerp(_v2, blend);
    _v3.y *= 0.35; // keep the anchor mostly horizontal; jumps handled by Y spring
    if (_v3.lengthSq() < 1e-6) _v3.copy(_v1);
    _v3.normalize(); // anchor forward

    // --- Road up (banking) — smoothed so seams never kick the horizon.
    const trk = ctx.track;
    if (trk && trk.sample) {
      const s = trk.sample(clamp01(st.progress || 0));
      if (s && s.up) _v4.copy(s.up); else _v4.set(0, 1, 0);
    } else _v4.set(0, 1, 0);
    this._roadUp.lerp(_v4, Math.min(1, 4.5 * dt));
    if (this._roadUp.lengthSq() < 1e-6) this._roadUp.set(0, 1, 0);
    this._roadUp.normalize();
    // Lean camera up-vector ~35% toward road up: banked corners tilt the shot.
    this._upMix.copy(_UP).lerp(this._roadUp, 0.35).normalize();

    // --- Desired camera position: behind + above along the anchor.
    const dist = lerp(p.dist, p.distMax, speed01);
    _v5.copy(carPos).addScaledVector(_v3, -dist).addScaledVector(this._upMix, p.height);

    // --- Look target: ahead along velocity (6→14 m with speed).
    const lookAhead = lerp(6, 14, speed01);
    _v6.copy(carPos).addScaledVector(_v2, lookAhead).addScaledVector(this._upMix, p.lookH);

    // --- Terrain avoidance: ray from near the look origin back to the camera.
    let occlTarget = 1;
    if (ctx.world && ctx.world.raycast) {
      _v7.copy(carPos).addScaledVector(this._upMix, 0.9); // ray origin at roofline
      _v8.copy(_v5).sub(_v7);
      const rayLen = _v8.length();
      if (rayLen > 0.5) {
        _v8.multiplyScalar(1 / rayLen);
        const hit = ctx.world.raycast(_v7, _v8, rayLen + 0.3);
        if (hit) occlTarget = clamp(Math.max(1.4, hit.distance - 0.35) / rayLen, 0.2, 1);
      }
      // Pull in fast, release slow — never see the wall, never pump.
      const k = occlTarget < this._occl ? 16 : 2.2;
      this._occl += (occlTarget - this._occl) * Math.min(1, k * dt);
      _v5.copy(_v7).addScaledVector(_v8, rayLen * this._occl);
    }

    // --- Springs. Vertical is softer (much softer airborne): the car falls
    // away from the camera on jumps = airtime, then the camera catches up.
    const airborne = !!car.airborne;
    const stY = airborne ? p.stYAir : p.stY;
    if (this._snap) {
      this._snap = false;
      this._pos.copy(_v5); this._posVel.set(0, 0, 0);
      this._look.copy(_v6); this._lookVel.set(0, 0, 0);
      this._occl = 1;
      this._roadUp.copy(_v4.set(0, 1, 0));
    } else {
      this._springTo(_v5, _v6, p.stXZ, stY, p.stLook, dt);
    }

    // --- Landing dip: quick 0.25 m-ish crouch that recovers.
    let dip = 0;
    if (this._dipT < 0.34) dip = -this._dipAmp * Math.sin((this._dipT / 0.34) * Math.PI);

    cam.position.copy(this._pos).addScaledVector(this._upMix, dip);

    // --- Orientation: look at target with banked up-vector, then roll.
    _m1.lookAt(cam.position, this._look, this._upMix);
    cam.quaternion.setFromRotationMatrix(_m1);

    // Drift roll (≤6°) leans the shot into the slide; slow-mo adds a drift.
    const cine = clamp01((this._cineUntil - time) / SLOWMO_DURATION);
    let rollTarget = clamp((car.driftAngle || 0) * 0.28, -6 * DEG, 6 * DEG);
    rollTarget += cine * Math.sin(time * 1.7) * 2.4 * DEG; // cinematic beat
    this._roll += (rollTarget - this._roll) * Math.min(1, 6 * dt);
    this._applyRoll(cam);

    // --- FOV: 62 → 80 with speed, +6 boost kick, slight pull during slow-mo.
    this._boostK += ((car.boosting ? 1 : 0) - this._boostK) * Math.min(1, 5 * dt);
    this._fovTarget =
      p.fov + p.fovRamp * Math.pow(speed01, 1.15) + p.fovBoost * this._boostK - cine * 5;
  }

  // Spring-damp this._pos / this._look toward targets (XZ vs Y split).
  _springTo(posTarget, lookTarget, stXZ, stY, stLook, dt) {
    let r;
    r = sdamp(this._pos.x, posTarget.x, this._posVel.x, stXZ, dt); this._pos.x = r.p; this._posVel.x = r.v;
    r = sdamp(this._pos.z, posTarget.z, this._posVel.z, stXZ, dt); this._pos.z = r.p; this._posVel.z = r.v;
    r = sdamp(this._pos.y, posTarget.y, this._posVel.y, stY, dt); this._pos.y = r.p; this._posVel.y = r.v;
    r = sdamp(this._look.x, lookTarget.x, this._lookVel.x, stLook, dt); this._look.x = r.p; this._lookVel.x = r.v;
    r = sdamp(this._look.y, lookTarget.y, this._lookVel.y, stLook * 1.6, dt); this._look.y = r.p; this._lookVel.y = r.v;
    r = sdamp(this._look.z, lookTarget.z, this._lookVel.z, stLook, dt); this._look.z = r.p; this._lookVel.z = r.v;
  }

  _applyRoll(cam) {
    if (Math.abs(this._roll) < 1e-5) return;
    _q1.setFromAxisAngle(_v1.set(0, 0, 1), this._roll); // local view-axis roll
    cam.quaternion.multiply(_q1);
  }

  // ---- shake + boost micro-vibration (rotational perlin-ish, trauma²) -------
  _applyShake(dt, time) {
    const st = this.ctx.state;
    const cam = this.ctx.camera;
    const mode = st.settings ? (st.settings.cameraMode | 0) % 3 : 0;
    const shakeMul =
      st.phase === 'racing' || st.phase === 'countdown' || st.phase === 'finished'
        ? (mode === 1 ? CHASE_MODES[1].shakeMul : 1.0)
        : 0.6; // menu barely shakes even if something explodes off-screen

    const t2 = this._trauma * this._trauma;
    const boosting = st.phase === 'racing' && st.car && st.car.boosting;
    const bAmp = boosting ? 0.0035 * this._boostK : 0;

    const amp = t2 * 0.05 * shakeMul;
    if (amp < 1e-5 && bAmp < 1e-5) return;

    const pitch = noise1(time * 13.1) * amp + noise1(time * 51.7) * bAmp;
    const yaw = noise1(time * 11.7 + 31.4) * amp + noise1(time * 47.3 + 8.8) * bAmp;
    const roll = noise1(time * 15.3 + 62.8) * amp * 1.3;

    _e1.set(pitch, yaw, roll);
    _q2.setFromEuler(_e1);
    cam.quaternion.multiply(_q2);

    // Tiny positional judder sells impact without smearing the framing.
    if (t2 > 0.01) {
      _v1.set(noise1(time * 19.3 + 4) * 0.06, noise1(time * 17.9 + 40) * 0.05, 0)
        .multiplyScalar(t2 * shakeMul)
        .applyQuaternion(cam.quaternion);
      cam.position.add(_v1);
    }
  }

  _applyFov(dt) {
    const cam = this.ctx.camera;
    this._fov += (this._fovTarget - this._fov) * Math.min(1, 6 * dt);
    if (Math.abs(cam.fov - this._fov) > 0.005) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
  }
}
