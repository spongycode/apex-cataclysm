// ============================================================================
// AISystem — SPEC section 7
// 3 rival hypercars. Spline followers on ctx.track.sample(t) with personality
// (racing-line noise, curvature-lookahead braking, mistakes, late-brake
// aggression), rubber-banding to the player, ghost-adjacent 3 m repulsion,
// grid starts, post-finish sunset cruise. Computes state.racePosition.
// fixedUpdate() = motion @120 Hz, update() = visuals only.
// ============================================================================

import * as THREE from 'three';
import { buildCarMesh } from '../car/carFactory.js';

// ---------------------------------------------------------------------------
// module-level scratch (zero per-frame allocations)
// ---------------------------------------------------------------------------
const _tmpV1 = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _tmpV3 = new THREE.Vector3();
const _tmpV4 = new THREE.Vector3();
const _tmpM = new THREE.Matrix4();
const _tmpQ = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _down = new THREE.Vector3();

const WHEEL_RADIUS = 0.34;
const RIDE_HEIGHT = 0.58; // chassis center above road surface
const PLAN_INTERVAL = 6; // re-plan target speed every N fixed steps (~20 Hz)
const PROBE_INTERVAL = 4; // gap probe every N fixed steps (~30 Hz)
const LOOKAHEAD_SECONDS = 1.2;
const RUBBER_WINDOW_S = 6; // pack clamped to ±6 s of player
const RUBBER_GAIN = 0.12; // ±12% target-speed scale
const REPULSE_DIST = 3.0; // gentle player repulsion radius

// Drivers. Paints chosen to read hard against red rock + storm grey.
const DRIVERS = [
  { name: 'VEX', paint: 0x14e3d4, accent: 0x00fff2, aggression: 0.92, skill: 0.84, seed: 17.3 }, // cyan/teal
  { name: 'SOL', paint: 0xffb02e, accent: 0xff5e1f, aggression: 0.72, skill: 0.96, seed: 41.7 }, // sunset yellow-orange
  { name: 'NYX', paint: 0x6a1fe0, accent: 0xc44dff, aggression: 0.86, skill: 0.70, seed: 88.1 }, // deep violet
];

// Smooth 1-D value noise from layered sines — deterministic, allocation-free.
function smoothNoise(x, seed) {
  return (
    Math.sin(x * 0.013 + seed) * 0.55 +
    Math.sin(x * 0.031 + seed * 2.31 + 1.7) * 0.30 +
    Math.sin(x * 0.0071 + seed * 4.13 + 4.2) * 0.15
  );
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export class AISystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.cars = []; // per-rival state, built in init()
    this._trackLen = 8000;
    this._finishOrder = []; // 'player' | rival index, in crossing order
    this._playerFinished = false;
    this._racing = false;
    this._step = 0; // fixed-step counter for staggered planning
    this._ready = false;
  }

  async init() {
    const { ctx } = this;
    const track = ctx.track;
    if (!track) throw new Error('AISystem.init: ctx.track missing (init order violated)');

    try {
      this._trackLen = track.spline?.getLength?.() ?? 8000;
    } catch (_) {
      this._trackLen = 8000;
    }
    if (!(this._trackLen > 100)) this._trackLen = 8000;

    for (let i = 0; i < DRIVERS.length; i++) {
      const d = DRIVERS[i];
      const rig = buildCarMesh({ paint: d.paint, accent: d.accent });
      rig.group.name = `ai-car-${d.name}`;
      // AI headlights: no shadows, modest reach — perf budget.
      if (Array.isArray(rig.headlights)) {
        for (const hl of rig.headlights) {
          if (!hl) continue;
          hl.castShadow = false;
          hl.visible = false;
        }
      }
      if (Array.isArray(rig.boostFlames)) {
        for (const f of rig.boostFlames) if (f) f.visible = false;
      }
      ctx.scene.add(rig.group);

      this.cars.push({
        driver: d,
        rig,
        // --- motion state (fixedUpdate) ---
        t: 0, // 0..1 spline progress
        speed: 0, // m/s along spline
        targetSpeed: 0,
        lateral: 0, // current lateral offset (m, along frame right)
        lateralGrid: 0, // spawn-slot lateral, blended out after GO
        gridBlend: 1, // 1 = on grid line, 0 = full racing line
        repulse: 0, // smoothed player-repulsion lateral (m)
        sagY: 0, // ballistic vertical sag over gaps (m, <= 0)
        sagVel: 0,
        overGap: false,
        curvature: 0, // signed, at current t (for steer + lean)
        braking: false,
        boosting: false,
        mistakeTimer: 0,
        mistakePhase: 0,
        spinAngle: 0,
        steerAngle: 0,
        finished: false,
        cruising: false,
        cruisePos: new THREE.Vector3(),
        cruiseDir: new THREE.Vector3(0, 0, -1),
        // --- pose written by fixedUpdate, consumed by update() ---
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        // smoothed visual signals
        brakeGlow: 0,
        // personality-derived tuning
        topSpeed: 61 + d.aggression * 10, // 61..71 m/s
        latGrip: 17 + d.skill * 10, // m/s^2 usable lateral accel
        accel: 15 + d.aggression * 7, // m/s^2
        brakeDecel: 24 + d.skill * 6,
        // aggression shortens the braking lookahead => late-brake lunges
        lookaheadScale: 1.35 - d.aggression * 0.45,
      });
    }

    this._resetToGrid();

    ctx.events.on('race:start', () => {
      this._racing = true;
    });
    ctx.events.on('race:finish', () => {
      if (!this._playerFinished) {
        this._playerFinished = true;
        this._finishOrder.push('player');
      }
    });
    ctx.events.on('race:restart', () => this._resetToGrid());
    ctx.events.on('car:respawn', () => {
      // player teleported; avoid a one-frame repulsion pop
      for (const c of this.cars) c.repulse = 0;
    });

    this._ready = true;
  }

  // -------------------------------------------------------------------------
  _resetToGrid() {
    const track = this.ctx.track;
    this._finishOrder.length = 0;
    this._playerFinished = false;
    this._racing = false;
    this._step = 0;

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      c.speed = 0;
      c.targetSpeed = 0;
      c.finished = false;
      c.cruising = false;
      c.sagY = 0;
      c.sagVel = 0;
      c.overGap = false;
      c.repulse = 0;
      c.mistakeTimer = 0;
      c.gridBlend = 1;
      c.braking = false;
      c.boosting = false;
      c.brakeGlow = 0;
      c.curvature = 0;
      c.steerAngle = 0;

      let spawned = false;
      try {
        const spawn = track?.getSpawn?.(i); // slots 0,1,2 — player takes 3
        if (spawn && spawn.position && spawn.quaternion) {
          c.pos.copy(spawn.position);
          c.quat.copy(spawn.quaternion);
          c.t = clamp(track.progressAt?.(spawn.position) ?? 0.002 + i * 0.001, 0, 0.05);
          // recover the grid slot's lateral offset relative to the centerline
          const s = track.sample(c.t);
          if (s) {
            _tmpV1.copy(spawn.position).sub(s.position);
            c.lateralGrid = clamp(_tmpV1.dot(s.right), -8, 8);
          } else {
            c.lateralGrid = 0;
          }
          spawned = true;
        }
      } catch (_) {
        /* fall through to spline fallback */
      }
      if (!spawned) {
        // fallback: stagger along the first meters of the spline
        c.t = 0.0018 * (i + 1);
        c.lateralGrid = (i - 1) * 3;
        this._poseFromSpline(c, 0);
      }
      c.lateral = c.lateralGrid;
      this._applyPoseToRig(c);
    }
  }

  // -------------------------------------------------------------------------
  // fixed-step motion @120 Hz
  // -------------------------------------------------------------------------
  fixedUpdate(fdt) {
    if (!this._ready) return;
    const track = this.ctx.track;
    if (!track || typeof track.sample !== 'function') return;
    this._step++;

    const st = this.ctx.state;
    const holding = !this._racing; // menu / countdown: sit on the grid

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];

      if (c.cruising) {
        this._cruiseStep(c, fdt);
        continue;
      }
      if (holding) {
        c.spinAngle += (c.speed / WHEEL_RADIUS) * fdt; // 0 — kept for symmetry
        continue;
      }

      // --- plan target speed (staggered ~20 Hz per car) ---
      if ((this._step + i * 2) % PLAN_INTERVAL === 0) {
        this._planSpeed(c, st, PLAN_INTERVAL * fdt);
      }

      // --- longitudinal integration toward target ---
      const dv = c.targetSpeed - c.speed;
      c.braking = dv < -1.5;
      if (dv > 0) {
        // power tapers near top speed
        const a = c.accel * (1 - 0.72 * clamp(c.speed / c.topSpeed, 0, 1));
        c.speed += Math.min(dv, a * fdt);
      } else {
        c.speed += Math.max(dv, -c.brakeDecel * fdt);
      }
      if (c.speed < 0) c.speed = 0;

      // --- advance along spline ---
      c.t += (c.speed / this._trackLen) * fdt;
      if (c.t >= 0.9995 && !c.finished) {
        c.finished = true;
        this._finishOrder.push(i);
        this._beginCruise(c);
        continue;
      }

      // grid line blends into racing line over the first ~4 s of running
      if (c.gridBlend > 0) c.gridBlend = Math.max(0, c.gridBlend - fdt * 0.25);

      // --- mistakes: wobble on tight sections, skill-gated ---
      if (c.mistakeTimer > 0) {
        c.mistakeTimer -= fdt;
      } else if (Math.abs(c.curvature) > 0.02 && c.speed > 18) {
        // per-second trigger probability grows as skill falls
        const p = (1 - c.driver.skill) * 0.55 * fdt;
        if (Math.random() < p) {
          c.mistakeTimer = 1.1 + Math.random() * 0.6;
          c.mistakePhase = Math.random() * Math.PI * 2;
        }
      }

      // --- gentle repulsion from player (no phasing) ---
      let repulseTarget = 0;
      const car = st.car;
      if (car && car.position) {
        const dx = c.pos.x - car.position.x;
        const dy = c.pos.y - car.position.y;
        const dz = c.pos.z - car.position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < REPULSE_DIST * REPULSE_DIST && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          // push along this car's own right axis, away from the player
          _tmpV1.set(dx, dy, dz);
          _tmpV2.set(1, 0, 0).applyQuaternion(c.quat);
          const side = _tmpV1.dot(_tmpV2) >= 0 ? 1 : -1;
          repulseTarget = side * (1 - d / REPULSE_DIST) * 2.4;
        }
      }
      c.repulse += (repulseTarget - c.repulse) * Math.min(1, 6 * fdt);

      // --- pose from spline frame ---
      this._poseFromSpline(c, fdt, i);

      // --- wheels ---
      c.spinAngle += (c.speed / WHEEL_RADIUS) * fdt;
      if (c.spinAngle > 1e4) c.spinAngle %= Math.PI * 2; // keep float precision healthy
      const steerTarget = c.overGap
        ? 0
        : clamp(Math.atan(2.7 * c.curvature) * 1.6, -0.42, 0.42);
      c.steerAngle += (steerTarget - c.steerAngle) * Math.min(1, 10 * fdt);

      // --- boost read (visual flames on flat-out straights) ---
      c.boosting =
        !c.braking &&
        c.speed > c.topSpeed * 0.82 &&
        Math.abs(c.curvature) < 0.006 &&
        c.targetSpeed >= c.speed - 0.5;
    }
  }

  // curvature-lookahead speed planning + rubber-band
  _planSpeed(c, st, planDt) {
    const track = this.ctx.track;
    const lookM = Math.max(18, c.speed * LOOKAHEAD_SECONDS * c.lookaheadScale);
    const probes = 5;
    const segM = lookM / probes;
    const segT = segM / this._trackLen;

    // walk probes ahead, find the tightest curvature (angle between tangents)
    const s0 = track.sample(clamp(c.t, 0, 0.9995));
    if (!s0) return;
    _tmpV3.copy(s0.tangent); // previous tangent (sample() object may be reused)
    _tmpV1.copy(s0.up); // frame up at the car, copied before re-sampling
    let vMax = c.topSpeed;
    let signedCurvAtCar = 0;
    for (let p = 1; p <= probes; p++) {
      const s = track.sample(clamp(c.t + segT * p, 0, 0.9995));
      if (!s) break;
      const dot = clamp(_tmpV3.dot(s.tangent), -1, 1);
      const angle = Math.acos(dot);
      const curv = angle / Math.max(segM, 1e-3);
      if (p === 1) {
        // signed curvature for steering/lean: sign from cross(t0,t1)·up
        _tmpV4.copy(_tmpV3).cross(s.tangent);
        signedCurvAtCar = curv * (_tmpV4.dot(_tmpV1) >= 0 ? 1 : -1);
      }
      if (curv > 1e-4) {
        // corner speed limit v = sqrt(a_lat / k); banking in frames adds margin
        const vCorner = Math.sqrt(c.latGrip / curv);
        // farther probes matter less right now — allow braking-distance slack
        const slack = 1 + (p - 1) * 0.06;
        if (vCorner * slack < vMax) vMax = vCorner * slack;
      }
      _tmpV3.copy(s.tangent);
    }
    c.curvature = signedCurvAtCar;

    // rubber-band: clamp pack spread to ±6 s of player progress
    let scale = 1;
    if (st && st.phase === 'racing' && !this._playerFinished) {
      const refSpeed = Math.max((st.car?.speedKmh ?? 0) / 3.6, 22);
      const gapS = ((c.t - st.progress) * this._trackLen) / refSpeed;
      scale = 1 - clamp(gapS / RUBBER_WINDOW_S, -1, 1) * RUBBER_GAIN;
    }

    // mistakes bleed a little pace too
    const mistakeMul = c.mistakeTimer > 0 ? 0.88 : 1;
    c.targetSpeed = clamp(vMax * scale * mistakeMul, 0, c.topSpeed * 1.08);
  }

  // Build world pose for a rival from the spline frame + offsets.
  _poseFromSpline(c, fdt, index = 0) {
    const track = this.ctx.track;
    const s = track.sample(clamp(c.t, 0, 0.9995));
    if (!s) return; // defensive: skip a frame gracefully

    _up.copy(s.up);
    _right.copy(s.right);
    _fwd.copy(s.tangent);

    const width = s.width || 12;
    const maxLat = width * 0.35;
    const dist = c.t * this._trackLen;
    let lat = smoothNoise(dist, c.driver.seed) * maxLat;
    if (c.mistakeTimer > 0) {
      // wobble: runs wide with a decaying shimmy
      const env = Math.min(1, c.mistakeTimer * 1.6);
      lat += Math.sin(dist * 0.11 + c.mistakePhase) * 1.6 * env;
    }
    lat = lat * (1 - c.gridBlend) + c.lateralGrid * c.gridBlend;
    lat = clamp(lat + c.repulse, -width * 0.42, width * 0.42);
    c.lateral = lat;

    // --- gap probe + ballistic sag (jump zones) ---
    if (fdt > 0 && (this._step + index) % PROBE_INTERVAL === 0) {
      _tmpV1.copy(s.position).addScaledVector(_right, lat).addScaledVector(_up, 2.0);
      _down.copy(_up).negate();
      let hit = null;
      try {
        hit = this.ctx.world.raycast(_tmpV1, _down, 9);
      } catch (_) {
        hit = null;
      }
      c.overGap = !hit && c.speed > 12;
    }
    if (c.overGap) {
      c.sagVel -= 9.8 * 0.55 * fdt; // styled half-gravity arc
      c.sagY = Math.max(-4.2, c.sagY + c.sagVel * fdt);
    } else {
      c.sagVel = 0;
      c.sagY += (0 - c.sagY) * Math.min(1, 9 * fdt); // firm landing recovery
    }

    // --- position: centerline + right·lat + up·ride + sag ---
    c.pos
      .copy(s.position)
      .addScaledVector(_right, lat)
      .addScaledVector(_up, RIDE_HEIGHT)
      .addScaledVector(_up, c.sagY);

    // --- orientation: forward = -Z along tangent, up from frame (banking) ---
    // small lean into corners + nose-down over gaps, for life
    const lean = clamp(-c.curvature * c.speed * 0.02, -0.09, 0.09);
    _tmpQ.setFromAxisAngle(_fwd, lean);
    _up.applyQuaternion(_tmpQ);
    _right.applyQuaternion(_tmpQ);
    _tmpV2.copy(_fwd).negate(); // car forward is local -Z ⇒ +Z axis = -tangent
    if (c.overGap) {
      // slight ballistic pitch: nose follows the sag arc
      const pitch = clamp(c.sagVel * 0.045, -0.14, 0.05);
      _tmpQ.setFromAxisAngle(_right, pitch);
      _tmpV2.applyQuaternion(_tmpQ);
      _up.applyQuaternion(_tmpQ);
    }
    _tmpM.makeBasis(_right, _up, _tmpV2);
    c.quat.setFromRotationMatrix(_tmpM);
  }

  _beginCruise(c) {
    // drive off into the sunset: hold the finish-line heading, roll on
    const s = this.ctx.track?.sample?.(0.9995);
    if (s) {
      c.cruiseDir.copy(s.tangent).normalize();
    } else {
      c.cruiseDir.set(0, 0, -1).applyQuaternion(c.quat);
    }
    c.cruisePos.copy(c.pos);
    c.cruising = true;
    c.overGap = false;
    c.sagY = 0;
    c.braking = false;
    c.boosting = true; // victory flames for a beat
    c.steerAngle = 0;
    c.curvature = 0;
  }

  _cruiseStep(c, fdt) {
    // ease to a triumphant 38 m/s and hold heading
    c.speed += (38 - c.speed) * Math.min(1, 0.5 * fdt);
    c.cruisePos.addScaledVector(c.cruiseDir, c.speed * fdt);
    c.pos.copy(c.cruisePos);
    c.spinAngle += (c.speed / WHEEL_RADIUS) * fdt;
    if (c.speed < 45) c.boosting = false;
  }

  // -------------------------------------------------------------------------
  // per-frame visuals
  // -------------------------------------------------------------------------
  update(dt, time) {
    if (!this._ready) return;
    const st = this.ctx.state;

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      this._applyPoseToRig(c);

      const rig = c.rig;

      // wheels: spin on all, steer on fronts (order [FL, FR, RL, RR])
      const wheels = rig.wheels;
      if (Array.isArray(wheels)) {
        for (let w = 0; w < wheels.length; w++) {
          const wm = wheels[w];
          if (!wm) continue;
          if (wm.rotation.order !== 'YXZ') wm.rotation.order = 'YXZ';
          wm.rotation.x = c.spinAngle;
          if (w < 2) wm.rotation.y = c.steerAngle;
        }
      }

      // brake lights: glow while decelerating (smoothed, no popping)
      const glowTarget = c.braking ? 1 : 0;
      c.brakeGlow += (glowTarget - c.brakeGlow) * Math.min(1, 12 * dt);
      const blm = rig.brakeLightMat;
      if (blm && 'emissiveIntensity' in blm) {
        blm.emissiveIntensity = 0.6 + c.brakeGlow * 3.4;
      }

      // headlights: rain or tunnel, same rules as the player
      const rain = st?.weather?.rain ?? 0;
      const inTunnel = c.t > 0.55 && c.t < 0.64;
      const lightsOn = rain > 0.3 || inTunnel;
      if (Array.isArray(rig.headlights)) {
        for (let h = 0; h < rig.headlights.length; h++) {
          const hl = rig.headlights[h];
          if (hl && hl.visible !== lightsOn) hl.visible = lightsOn;
        }
      }

      // boost flames: flicker scale when flat-out
      if (Array.isArray(rig.boostFlames)) {
        for (let f = 0; f < rig.boostFlames.length; f++) {
          const flame = rig.boostFlames[f];
          if (!flame) continue;
          flame.visible = c.boosting;
          if (c.boosting) {
            const fl =
              0.75 +
              0.35 * Math.abs(Math.sin(time * 31 + f * 2.1)) +
              0.18 * Math.sin(time * 87 + f * 5.3 + i);
            flame.scale.set(fl * 0.9, fl * 0.9, 0.8 + fl * 0.55);
          }
        }
      }
    }

    // --- race position from all four progress values ---
    if (st && (st.phase === 'racing' || st.phase === 'finished')) {
      if (this._playerFinished) {
        const rank = this._finishOrder.indexOf('player');
        if (rank !== -1) st.racePosition = rank + 1;
      } else {
        let pos = 1;
        for (let i = 0; i < this.cars.length; i++) {
          const c = this.cars[i];
          if (c.finished || c.t > st.progress) pos++;
        }
        st.racePosition = pos;
      }
    }
  }

  _applyPoseToRig(c) {
    const g = c.rig?.group;
    if (!g) return;
    g.position.copy(c.pos);
    g.quaternion.copy(c.quat);
  }
}
