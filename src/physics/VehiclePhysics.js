// ============================================================================
// APEX: CATACLYSM CANYON — VehiclePhysics
// Custom arcade-sim raycast vehicle. 120 Hz fixed step.
//
// Architecture per step:
//   1. read inputs (phase-gated), steering model + assists
//   2. 4x suspension raycasts along -chassisUp -> spring/damper loads
//   3. air / landing bookkeeping (car:jump, car:landed)
//   4. gearbox + engine -> per-wheel drive & brake demands
//   5. slip-curve tire forces (separate long/lat, friction ellipse, surface grip)
//   6. aero (quadratic drag, v^2 downforce), boost, loop adhesion gravity
//   7. integrate linear + angular, swept front ray (anti-tunnel) then move
//   8. 8-ray wall ring -> push-out + velocity slide + car:collision
//   9. drift / boost state machines, write EVERY state.car field
//
// Forward = local -Z, up = +Y, right = +X. Wheels [FL, FR, RL, RR].
// Zero allocations in the hot path: all temps are module-level or pooled.
// ============================================================================

import * as THREE from 'three';
import { T, SURFACE_GRIP } from './tuning.js';

// ---------------------------------------------------------------- temp pool
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// Pacejka-lite: rises ~linearly, peaks (~13 deg for lat slip), falls to ~0.7.
// The past-peak falloff is what makes drifts break away progressively.
function tireCurve(s) {
  return Math.sin(T.TIRE_C * Math.atan(T.TIRE_B * s));
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

export class VehiclePhysics {
  constructor(ctx) {
    this.ctx = ctx;

    // ------------------------------------------------------ rigid body
    this.pos = new THREE.Vector3(0, T.RIDE_HEIGHT, 0);
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVelL = new THREE.Vector3();      // angular velocity, LOCAL frame
    this._prevVel = new THREE.Vector3();
    this._force = new THREE.Vector3();       // accumulated world force
    this._torque = new THREE.Vector3();      // accumulated world torque
    this._gravityDir = new THREE.Vector3(0, -1, 0);

    // chassis basis (world), refreshed each step
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._right = new THREE.Vector3(1, 0, 0);
    this._omegaW = new THREE.Vector3();      // angular velocity, world frame

    // ------------------------------------------------------ wheels [FL,FR,RL,RR]
    const hx = T.TRACK_HALF, hz = T.WHEELBASE / 2, hy = T.HP_Y;
    this.wheels = [
      { local: new THREE.Vector3(-hx, hy, -hz), front: true },
      { local: new THREE.Vector3(hx, hy, -hz), front: true },
      { local: new THREE.Vector3(-hx, hy, hz), front: false },
      { local: new THREE.Vector3(hx, hy, hz), front: false },
    ];
    for (const w of this.wheels) {
      w.hpW = new THREE.Vector3();           // hardpoint world
      w.normal = new THREE.Vector3(0, 1, 0); // contact normal (world)
      w.cp = new THREE.Vector3();            // contact point (world)
      w.center = new THREE.Vector3();        // wheel center (world)
      w.fwdDir = new THREE.Vector3();        // tire forward on contact plane
      w.rightDir = new THREE.Vector3();
      w.comp = 0.35;                         // compression 0..1(+)
      w.prevComp = 0.35;
      w.contact = false;
      w.load = T.STATIC_LOAD;
      w.surface = 'asphalt';
      w.spin = 0;
      w.slipVis = 0;
      w.steerAngle = 0;
    }

    // ------------------------------------------------------ drivetrain
    this.gear = 1;
    this.rpm = T.RPM_IDLE;
    this._shiftT = 0;
    this._gearTops = T.GEAR_RATIOS.map((r) => T.RPM_SPEED / r);
    this._reversing = false;

    // ------------------------------------------------------ steering / assists
    this._steerY = 0;                        // wheel angle about +up (positive = left)
    this._driftF = 0;                        // smoothed drifting 0..1 for assist blending

    // ------------------------------------------------------ air state
    this._airT = 0;
    this._wasAirborne = false;
    this._contactCount = 4;
    this._avgN = new THREE.Vector3(0, 1, 0);

    // ------------------------------------------------------ drift state
    this._drifting = false;
    this._driftRun = 0;                      // score banked this drift
    this._driftDur = 0;
    this._driftGrace = 0;
    this._driftAngle = 0;

    // ------------------------------------------------------ boost
    this._boostTank = 1;
    this._boosting = false;

    // ------------------------------------------------------ wall ring (8 dirs, local)
    this._ringDirs = [];
    this._ringExt = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;           // 0 = front (-Z)
      const d = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      this._ringDirs.push(d);
      this._ringExt.push(1 / Math.max(Math.abs(d.x) / T.HALF_W, Math.abs(d.z) / T.HALF_L));
    }
    this._collisionCd = 0;

    // ------------------------------------------------------ misc
    this._steerNorm = 0;                     // -1..1 written to state.car.steer
    this._surface = 'asphalt';
    this._warned = false;
    this._safePos = new THREE.Vector3(0, T.RIDE_HEIGHT, 0);
    this._safeQuat = new THREE.Quaternion();
  }

  async init() {
    // Nothing heavy to build — but push a coherent state.car once so every
    // system that inits after us sees a valid, settled car.
    this._writeState(1 / 120);
  }

  // Per-render-frame hook (unused — all work is in fixedUpdate). Kept for
  // lifecycle symmetry with other systems.
  update(dt, time) {} // eslint-disable-line no-unused-vars

  // -------------------------------------------------------------- respawn
  respawn(position, quaternion) {
    if (position) this.pos.copy(position);
    if (quaternion) this.quat.copy(quaternion).normalize();
    this.vel.set(0, 0, 0);
    this.angVelL.set(0, 0, 0);
    this._prevVel.set(0, 0, 0);
    this._steerY = 0;
    this._airT = 0;
    this._wasAirborne = false;
    this._shiftT = 0;
    this.gear = 1;
    this.rpm = T.RPM_IDLE;
    this._reversing = false;
    this._collisionCd = 0;

    // End any live drift cleanly (UI banks the score).
    if (this._drifting) {
      this._drifting = false;
      this._driftF = 0;
      this.ctx.events?.emit('drift:end', {
        score: Math.round(this._driftRun),
        duration: this._driftDur,
      });
      this._driftRun = 0;
      this._driftDur = 0;
    }

    // Settle snap: drop the chassis to natural ride height on whatever is
    // below, so the car never spawns hovering or buried.
    _v0.set(0, 1, 0).applyQuaternion(this.quat);
    _v1.copy(_v0).negate();
    const hit = this.ctx.world?.raycast(this.pos, _v1, 6);
    if (hit) {
      this.pos.copy(hit.point).addScaledVector(_v0, T.RIDE_HEIGHT);
    }
    for (const w of this.wheels) {
      w.comp = 0.35;
      w.prevComp = 0.35;
      w.contact = true;
      w.load = T.STATIC_LOAD;
      w.slipVis = 0;
      w.normal.copy(_v0);
    }
    this._safePos.copy(this.pos);
    this._safeQuat.copy(this.quat);
    this._writeState(1 / 120);
  }

  // ---------------------------------------------------------- fixed update
  fixedUpdate(fdt) {
    try {
      this._step(clamp(fdt || 1 / 120, 1 / 1000, 1 / 60));
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[VehiclePhysics] step error (suppressed)', err);
      }
    }
  }

  _step(fdt) {
    const ctx = this.ctx;
    const st = ctx.state;
    if (!st || !st.car || !ctx.world) return;

    const racing = st.phase === 'racing';
    const finished = st.phase === 'finished';
    const events = ctx.events;

    // ------------------------------------------------ 1. inputs (phase-gated)
    // SPEC: before racing, main still steps us — keep the car settled on its
    // suspension but ignore drive inputs. Revving on the grid is allowed for
    // audio (rpm follows throttle, no force).
    const acts = ctx.input?.actions;
    const rawThrottle = acts ? acts.throttle : 0;
    let throttle = racing ? rawThrottle : 0;
    let brake = racing ? (acts ? acts.brake : 0) : 0;
    const handbrake = racing && !!(acts && acts.handbrake);
    const boostIn = racing && !!(acts && acts.boost);
    const steerIn = racing || finished ? (acts ? acts.steer : 0) : 0;

    // ------------------------------------------------ chassis basis & scalars
    const q = this.quat;
    this._fwd.set(0, 0, -1).applyQuaternion(q);
    this._up.set(0, 1, 0).applyQuaternion(q);
    this._right.set(1, 0, 0).applyQuaternion(q);
    this._omegaW.copy(this.angVelL).applyQuaternion(q);
    _q0.copy(q).invert(); // world -> local

    const speed = this.vel.length();
    const fwdSpeed = this.vel.dot(this._fwd);
    const latSpeed = this.vel.dot(this._right);

    // Signed body slip (drift angle). Denominator floor kills parking jitter.
    this._driftAngle = Math.atan2(latSpeed, Math.max(Math.abs(fwdSpeed), 2.5));

    // ------------------------------------------------ reverse state machine
    // Not in SPEC (gear is 1..6) but mandatory for playability: S at a near
    // stop backs up; W always drives forward and cancels reverse.
    if (racing) {
      if (!this._reversing && brake > 0.15 && fwdSpeed < 0.6) this._reversing = true;
      if (this._reversing && (throttle > 0.15 || fwdSpeed > 1.0)) this._reversing = false;
    } else {
      this._reversing = false;
    }

    // ------------------------------------------------ steering model
    // Speed-sensitive authority (tight at speed, full lock in the pits),
    // widened while drifting so countersteer has room, plus auto-countersteer
    // so keyboard players can HOLD a 35-degree drift with taps, not wrestling.
    let maxSteer = T.STEER_MAX / (1 + Math.pow(speed / T.STEER_FADE, T.STEER_FADE_POW));
    maxSteer *= 1 + T.STEER_DRIFT_WIDEN * this._driftF;
    let steerTarget = -steerIn * maxSteer - this._driftAngle * T.CS_GAIN * this._driftF;
    steerTarget = clamp(steerTarget, -T.STEER_MAX * 1.15, T.STEER_MAX * 1.15);
    this._steerY += (steerTarget - this._steerY) * Math.min(1, T.STEER_SLEW * fdt);
    this._steerNorm = clamp(-this._steerY / T.STEER_MAX, -1, 1);

    // ------------------------------------------------ 2. suspension raycasts
    this._force.set(0, 0, 0);
    this._torque.set(0, 0, 0);

    let contactCount = 0;
    let bestLoad = 0;
    this._avgN.set(0, 0, 0);
    _v6.copy(this._up).negate(); // ray direction (shared by all four)

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.hpW.copy(w.local).applyQuaternion(q).add(this.pos);

      const hit = ctx.world.raycast(w.hpW, _v6, T.RAY_LEN + 0.05);
      if (hit && hit.distance <= T.RAY_LEN + 0.02) {
        // world.raycast returns SHARED vectors — copy immediately.
        w.normal.copy(hit.normal);
        if (w.normal.dot(_v6) > 0) w.normal.negate(); // always oppose the ray
        w.cp.copy(hit.point);
        w.surface = hit.surface || 'asphalt';

        const rawComp = (T.RAY_LEN - hit.distance) / T.TRAVEL; // may exceed 1 (bump stop)
        const comp = clamp(rawComp, 0, 1.4);
        const compVel = ((comp - w.prevComp) * T.TRAVEL) / fdt;

        // Spring + damper (asym: firmer rebound = no float) + bump stop.
        let N = T.SPRING * Math.min(comp, 1) * T.TRAVEL;
        N += (compVel > 0 ? T.DAMP_C : T.DAMP_R) * compVel;
        if (rawComp > 1) N += (rawComp - 1) * T.TRAVEL * T.BUMP_K; // CRUNCH
        N = clamp(N, 0, T.MAX_LOAD);

        // Suspension force along the CONTACT NORMAL — this is what lets the
        // car ride the inside of the 360 loop.
        _v0.copy(w.normal).multiplyScalar(N);
        this._force.add(_v0);
        _v1.copy(w.hpW).sub(this.pos);
        this._torque.add(_v2.crossVectors(_v1, _v0));

        w.load += (N - w.load) * 0.5; // light smoothing for the tire model
        w.contact = true;
        w.comp = comp;
        w.center.copy(w.hpW).addScaledVector(_v6, hit.distance - T.WHEEL_R);

        contactCount++;
        this._avgN.add(w.normal);
        if (w.load > bestLoad) { bestLoad = w.load; this._surface = w.surface; }
      } else {
        w.contact = false;
        w.load = 0;
        w.comp += (0 - w.comp) * Math.min(1, 8 * fdt); // droop out smoothly
        w.center.copy(w.hpW).addScaledVector(_v6, T.RAY_LEN - T.WHEEL_R);
        w.normal.copy(this._up);
      }
      w.prevComp = w.comp;
    }
    const grounded = contactCount >= 2;
    const airborne = contactCount === 0;
    if (contactCount > 0) this._avgN.normalize();
    else this._avgN.copy(UP);
    this._contactCount = contactCount;

    // Hard-floor guard: a brutal landing can bury a wheel past the bump stop
    // faster than spring forces can respond — if compression blows past
    // FLOOR_COMP, positionally eject the chassis along the contact normal and
    // kill the closing velocity. The car can NEVER sink through the road.
    let floorPen = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (w.contact && w.comp > T.FLOOR_COMP) {
        floorPen = Math.max(floorPen, (w.comp - T.FLOOR_COMP) * T.TRAVEL);
      }
    }
    if (floorPen > 0) {
      this.pos.addScaledVector(this._avgN, Math.min(floorPen, T.FLOOR_PUSH_CAP));
      const vnf = this.vel.dot(this._avgN);
      if (vnf < 0) this.vel.addScaledVector(this._avgN, -vnf * 0.7);
    }

    // ------------------------------------------------ 3. air & landing events
    if (airborne) {
      if (!this._wasAirborne) {
        // Just left the ground. Ramp-lip launch? (SPEC: >15 m/s, upward)
        if (speed > T.JUMP_SPEED_MIN && this.vel.y > T.JUMP_VY_MIN && racing) {
          events?.emit('car:jump', { speed });
        }
      }
      this._airT += fdt;
      if (racing) {
        st.stats.airTime += fdt;
        this._boostTank = Math.min(1, this._boostTank + T.BOOST_REFILL_AIR * fdt);
      }
    } else if (this._wasAirborne) {
      // Touchdown. Impact speed = closing speed along the surface normal,
      // sampled BEFORE the suspension eats it -> real crash-y numbers.
      const impactSpeed = Math.max(0, -this.vel.dot(this._avgN));
      if (this._airT > T.LAND_MIN_AIR) {
        events?.emit('car:landed', { impactSpeed, airTime: this._airT });
        if (racing && this._airT > 1.6) {
          events?.emit('ui:message', {
            text: 'MASSIVE AIR!',
            sub: `${this._airT.toFixed(1)}s FLIGHT`,
            style: 'epic',
          });
        }
        // Landing crunch: swallow part of the normal velocity so the car
        // plants instead of trampolining. Suspension bump stops do the rest.
        const vn = this.vel.dot(this._avgN);
        if (vn < 0) this.vel.addScaledVector(this._avgN, -vn * T.LAND_ABSORB);
      }
      this._airT = 0;
    }
    this._wasAirborne = airborne;

    // ------------------------------------------------ 4. gearbox & engine
    const gearTop = this._gearTops[this.gear - 1];
    let rpmBase;
    if (this._reversing) {
      rpmBase = T.RPM_IDLE + (1 - T.RPM_IDLE) * clamp01(Math.abs(fwdSpeed) / T.REVERSE_TOP);
    } else {
      rpmBase = T.RPM_IDLE + (1 - T.RPM_IDLE) * clamp01(Math.max(0, fwdSpeed) / gearTop);
    }
    // Free-revving when the wheels are unloaded, and grid-revving pre-race.
    if (airborne) rpmBase = Math.max(rpmBase, 0.3 + 0.55 * throttle);
    if (!racing && !finished) rpmBase = Math.max(rpmBase, T.RPM_IDLE + 0.72 * rawThrottle);

    this._shiftT = Math.max(0, this._shiftT - fdt);
    if (racing && !this._reversing && this._shiftT === 0 && !airborne) {
      if (rpmBase > T.SHIFT_UP_RPM && this.gear < 6) {
        this.gear++;
        this._shiftT = T.SHIFT_TIME;
      } else if (rpmBase < T.SHIFT_DOWN_RPM && this.gear > 1) {
        this.gear--;
        this._shiftT = T.SHIFT_TIME * 0.6;
      }
    }
    // Smoothed rpm with audible dips: during a shift the target sags, and the
    // gear-top change re-lands it lower — AudioSystem hears both.
    const rpmTarget = this._shiftT > 0 ? rpmBase * 0.72 : rpmBase;
    const rpmRate = rpmTarget > this.rpm ? 7 : 10;
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, rpmRate * fdt);
    this.rpm = clamp01(this.rpm);

    // Boost state machine (tank 0..1). Drains while held, refills from drift
    // + air. +45% engine force and a small direct shove = real top-speed gain.
    const canBoost = boostIn && (this._boosting ? this._boostTank > 0.005 : this._boostTank > T.BOOST_MIN_START);
    if (canBoost !== this._boosting) {
      this._boosting = canBoost;
      events?.emit(canBoost ? 'boost:start' : 'boost:end', {});
    }
    if (this._boosting) this._boostTank = Math.max(0, this._boostTank - T.BOOST_DRAIN * fdt);

    // Wheel-force demand from the engine.
    const torqueCurve = 0.55 + 0.9 * this.rpm - 0.5 * this.rpm * this.rpm;
    let driveTotal = 0;
    if (this._reversing) {
      const revBrake = brake; // S is reverse throttle in this mode
      brake = 0;
      const headroom = clamp01((T.REVERSE_TOP + fwdSpeed) / 3); // fade at reverse top
      driveTotal = -T.REVERSE_FORCE * revBrake * headroom;
    } else {
      driveTotal =
        T.ENGINE_FORCE *
        T.GEAR_RATIOS[this.gear - 1] *
        torqueCurve *
        throttle *
        (this._shiftT > 0 ? 0.3 : 1) *
        (this._boosting ? T.BOOST_FORCE_MUL : 1);
    }

    // ------------------------------------------------ 5. tire forces
    const wetness = st.weather ? st.weather.wetness || 0 : 0;
    const brakeScaleV = clamp01(Math.abs(fwdSpeed) / 0.4); // no brake buzz at rest
    let waterWheels = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.steerAngle = w.front ? this._steerY : 0;

      if (!w.contact || w.load <= 1) {
        // Free wheel: visual spin bleeds toward rpm-ish speed.
        const freeSpin = airborne ? throttle * 40 : Math.abs(fwdSpeed) / T.WHEEL_R;
        w.spin += freeSpin * fdt * Math.sign(fwdSpeed >= 0 ? 1 : -1);
        w.slipVis += (0 - w.slipVis) * Math.min(1, 6 * fdt);
        continue;
      }
      if (w.surface === 'water') waterWheels++;

      // Tire basis on the contact plane.
      w.fwdDir.copy(this._fwd);
      if (w.front && this._steerY !== 0) {
        _q1.setFromAxisAngle(this._up, this._steerY);
        w.fwdDir.applyQuaternion(_q1);
      }
      w.fwdDir.addScaledVector(w.normal, -w.fwdDir.dot(w.normal)).normalize();
      w.rightDir.crossVectors(w.fwdDir, w.normal); // fwd x up = right

      // Contact-patch velocity (chassis + rotation).
      _v0.copy(w.cp).sub(this.pos);
      _v1.crossVectors(this._omegaW, _v0).add(this.vel);
      const vLong = _v1.dot(w.fwdDir);
      const vLat = _v1.dot(w.rightDir);

      // Surface grip, rain penalty (asphalt suffers most when wet).
      let grip = SURFACE_GRIP[w.surface] !== undefined ? SURFACE_GRIP[w.surface] : 1;
      grip *= 1 - 0.12 * wetness * (w.surface === 'asphalt' ? 1 : 0.5);

      // ---- lateral: slip-angle curve, drift-aware rear looseness
      let latMu = T.MU_LAT * grip * (w.front ? T.FRONT_LAT : T.REAR_LAT);
      if (!w.front) {
        if (handbrake) latMu *= T.HB_REAR_LAT;
        latMu *= 1 - this._driftF * (T.DRIFT_REAR_LOOSE + T.DRIFT_THROTTLE_LOOSE * throttle);
      }
      const slipA = Math.atan2(vLat, Math.max(Math.abs(vLong), 2.2));
      const latCurve = -tireCurve(slipA) * latMu * w.load;
      // Below walking pace the curve chatters — blend to a viscous damper.
      const ls = clamp01(speed / T.LOWSPEED_BLEND);
      let fLat = latCurve * ls + -vLat * w.load * 0.35 * (1 - ls);

      // ---- longitudinal: drive + brakes, traction-clamped
      const driveShare = (w.front ? T.DRIVE_FRONT : T.DRIVE_REAR) * 0.5;
      let fLong = driveTotal * driveShare;
      let brakeF = T.BRAKE_FORCE * brake * (w.front ? T.BRAKE_FRONT : 1 - T.BRAKE_FRONT) * 0.5;
      if (!w.front && handbrake) brakeF += T.HB_BRAKE * 0.5;
      fLong -= brakeF * Math.sign(vLong) * brakeScaleV;

      const longMax = T.MU_LONG * grip * w.load;
      const overLong = Math.abs(fLong) / Math.max(longMax, 1);
      fLong = clamp(fLong, -longMax, longMax);
      // Friction ellipse: spending grip on drive/brake steals lateral —
      // power-oversteer and trail-braking fall out of this for free.
      fLat *= Math.sqrt(Math.max(0.1, 1 - Math.min(1, overLong) * Math.min(1, overLong) * 0.85));

      // Apply above the contact point (roll-center trick): enough lever for
      // readable roll/dive, not enough to barrel-roll at 2 g.
      _v2.copy(w.fwdDir).multiplyScalar(fLong).addScaledVector(w.rightDir, fLat);
      this._force.add(_v2);
      _v3.copy(w.cp).addScaledVector(w.normal, T.FORCE_LIFT).sub(this.pos);
      this._torque.add(_v4.crossVectors(_v3, _v2));

      // ---- visual spin & slip intensity (VFX/audio food)
      const locked = !w.front && handbrake && Math.abs(vLong) > 1;
      if (!locked) w.spin += (vLong / T.WHEEL_R) * fdt;
      const slipNow = clamp01(
        Math.max(
          Math.abs(slipA) / 0.5,
          overLong > 0.85 ? (overLong - 0.85) * 4 : 0,
          locked ? 1 : 0
        ) * ls
      );
      w.slipVis += (slipNow - w.slipVis) * Math.min(1, 10 * fdt);
    }

    // ------------------------------------------------ 6. aero, boost, adhesion
    // Quadratic drag balances 6th-gear force at ~64 m/s => ~230 km/h.
    this._force.addScaledVector(this.vel, -(T.DRAG_Q * speed + T.DRAG_LIN));
    if (waterWheels > 0) {
      this._force.addScaledVector(this.vel, -T.WATER_DRAG * waterWheels); // ford bog
    }
    if (contactCount > 0) {
      const df = Math.min(T.DOWNFORCE * speed * speed, T.DOWNFORCE_CAP);
      this._force.addScaledVector(this._up, -df); // presses along -chassisUp: loop-safe
    }
    if (this._boosting && grounded) {
      this._force.addScaledVector(this._fwd, T.BOOST_THRUST * clamp01(1.2 - speed / 80));
    }

    // Lateral-velocity bleed when NOT drifting: gentle invisible hand that
    // keeps keyboard driving tight without killing slides you asked for.
    if (grounded && !handbrake) {
      const stab = T.LAT_ASSIST * (1 - this._driftF) * (1 - 0.5 * throttle);
      this._force.addScaledVector(this._right, -latSpeed * T.MASS * stab);
    }

    // Loop adhesion: at speed on steep/inverted surfaces gravity blends toward
    // -surfaceNormal (and presses a bit harder). Crawl into the loop -> normal
    // gravity wins and you peel off. Exactly the SPEC behavior.
    let gMag = T.GRAVITY;
    if (contactCount >= 2) {
      const steep = clamp01((1 - this._avgN.y) * T.ADH_STEEP);
      const adh = steep * clamp01((speed - T.ADH_SPEED_LO) / (T.ADH_SPEED_HI - T.ADH_SPEED_LO));
      this._gravityDir.copy(DOWN).lerp(_v0.copy(this._avgN).negate(), adh);
      if (this._gravityDir.lengthSq() < 1e-6) this._gravityDir.copy(DOWN);
      this._gravityDir.normalize();
      gMag = T.GRAVITY * (1 + T.ADH_EXTRA_G * adh);
    } else {
      this._gravityDir.copy(DOWN);
    }

    // ------------------------------------------------ airborne authority
    if (airborne) {
      // Mild arcade control: throttle = nose up, brake = nose down, steer = yaw.
      _v0.set(
        (throttle - brake) * T.AIR_PITCH,
        -steerIn * T.AIR_YAW,
        0
      ); // local torque
      _v1.copy(_v0).applyQuaternion(q);
      this._torque.add(_v1);
      // Auto-level: spring the chassis up-axis toward world up.
      _v2.crossVectors(this._up, UP).multiplyScalar(T.AIR_LEVEL);
      this._torque.add(_v2);
    }

    // ------------------------------------------------ pre-race / finish calm
    if (!racing) {
      // Grid hold & post-finish coast-down: bleed planar velocity so the car
      // sits on its springs without creeping off the line.
      const bleed = finished ? 1.2 : 4.0;
      _v0.copy(this.vel).addScaledVector(this._up, -this.vel.dot(this._up));
      this._force.addScaledVector(_v0, -T.MASS * Math.min(bleed, 1 / fdt));
    }

    // ------------------------------------------------ 7. integrate
    this.vel.addScaledVector(this._force, T.INV_MASS * fdt);
    this.vel.addScaledVector(this._gravityDir, gMag * fdt);
    const sp2 = this.vel.length();
    if (sp2 > T.VEL_CAP) this.vel.multiplyScalar(T.VEL_CAP / sp2);

    // Angular: torque -> local, diagonal inertia, per-axis damping.
    _v0.copy(this._torque).applyQuaternion(_q0);
    // Yaw assist: nudge yaw rate toward what the steering commands (bicycle
    // model), heavily faded while drifting so slides stay yours.
    if (grounded) {
      const targetYaw = (this._steerY * clamp(fwdSpeed, 0, 30)) / T.WHEELBASE;
      let assist = (targetYaw - this.angVelL.y) * T.YAW_ASSIST * (1 - 0.75 * this._driftF);
      assist = clamp(assist, -T.YAW_ASSIST_CAP, T.YAW_ASSIST_CAP);
      _v0.y += assist;
    }
    this.angVelL.x += (_v0.x / T.IX) * fdt;
    this.angVelL.y += (_v0.y / T.IY) * fdt;
    this.angVelL.z += (_v0.z / T.IZ) * fdt;
    const dR = airborne ? T.DAMP_AIR : T.DAMP_ROLL;
    const dP = airborne ? T.DAMP_AIR : T.DAMP_PITCH;
    const dY = airborne ? T.DAMP_AIR : T.DAMP_YAW;
    this.angVelL.x /= 1 + dP * fdt;
    this.angVelL.y /= 1 + dY * fdt;
    this.angVelL.z /= 1 + dR * fdt;
    this._omegaW.copy(this.angVelL).applyQuaternion(q);

    // Swept front ray BEFORE moving: at 75 m/s a step is 0.63 m — the sweep
    // guarantees we never place the bumper inside (or past) a wall.
    let moved = false;
    const spd = this.vel.length();
    if (spd > 1) {
      _v0.copy(this.vel).multiplyScalar(1 / spd); // dir
      _v1.copy(_v0).applyQuaternion(_q0);         // local dir
      const ext =
        1 /
        Math.max(
          Math.abs(_v1.x) / T.HALF_W,
          Math.abs(_v1.z) / T.HALF_L,
          Math.abs(_v1.y) / T.HALF_H,
          1e-4
        );
      _v2.copy(this.pos).addScaledVector(this._up, T.BUMPER_Y); // bumper-height origin
      const travel = spd * fdt;
      const hit = ctx.world.raycast(_v2, _v0, ext + travel + T.WALL_SKIN + 0.1);
      if (hit && Math.abs(hit.normal.dot(this._up)) < T.WALL_GROUND_DOT) {
        const allowed = hit.distance - ext - T.WALL_SKIN;
        if (travel > allowed) {
          _v3.copy(hit.normal);
          if (_v3.dot(_v0) > 0) _v3.negate();
          this.pos.addScaledVector(_v0, Math.max(allowed, 0));
          moved = true;
          this._resolveWallHit(_v3, hit.point, events, racing || finished, fdt);
        }
      }
    }
    if (!moved) this.pos.addScaledVector(this.vel, fdt);

    // Quaternion integration + renormalize.
    _q1.set(
      this._omegaW.x * fdt * 0.5,
      this._omegaW.y * fdt * 0.5,
      this._omegaW.z * fdt * 0.5,
      0
    );
    _q1.multiply(q);
    q.x += _q1.x; q.y += _q1.y; q.z += _q1.z; q.w += _q1.w;
    q.normalize();

    // ------------------------------------------------ 8. wall ring (post-move)
    this._collisionCd = Math.max(0, this._collisionCd - fdt);
    _v5.set(0, 0, 0); // accumulated push-out
    _v2.copy(this.pos).addScaledVector(this._up, T.BUMPER_Y);
    for (let k = 0; k < 8; k++) {
      _v0.copy(this._ringDirs[k]).applyQuaternion(q);
      const ext = this._ringExt[k];
      const hit = ctx.world.raycast(_v2, _v0, ext + T.WALL_MARGIN);
      if (!hit) continue;
      if (Math.abs(hit.normal.dot(this._up)) >= T.WALL_GROUND_DOT) continue; // floor/ceiling
      const pen = ext + T.WALL_SKIN - hit.distance;
      if (pen <= 0) continue;
      _v3.copy(hit.normal);
      if (_v3.dot(_v0) > 0) _v3.negate(); // normal must face us
      _v5.addScaledVector(_v3, pen);
      this._resolveWallHit(_v3, hit.point, events, racing || finished, fdt);
    }
    const pushLen = _v5.length();
    if (pushLen > 0) {
      if (pushLen > T.WALL_PUSH_CAP) _v5.multiplyScalar(T.WALL_PUSH_CAP / pushLen);
      this.pos.add(_v5);
    }

    // ------------------------------------------------ 9. drift & boost economy
    const absA = Math.abs(this._driftAngle);
    const speedOK = speed > T.DRIFT_MIN_SPEED && fwdSpeed > 3 && grounded;
    if (!this._drifting) {
      const enter = handbrake ? T.DRIFT_ENTER_HB : T.DRIFT_ENTER;
      if (racing && speedOK && absA > enter && absA < 1.35) {
        this._drifting = true;
        this._driftRun = 0;
        this._driftDur = 0;
        this._driftGrace = T.DRIFT_GRACE;
        events?.emit('drift:start', {});
      }
    } else {
      this._driftDur += fdt;
      if (racing && speedOK && absA > T.DRIFT_EXIT && absA < 1.5) {
        this._driftGrace = T.DRIFT_GRACE;
        const deg = (absA * 180) / Math.PI;
        const pts = st.car.speedKmh * (0.4 + deg / 28) * T.DRIFT_PTS * fdt;
        this._driftRun += pts;
        st.stats.driftScore += pts;
        // Nitrous economy: style pays. Scaled by angle & speed per SPEC.
        const intensity = clamp01(absA / 0.5) * clamp01(speed / 25);
        this._boostTank = Math.min(1, this._boostTank + T.BOOST_REFILL_DRIFT * intensity * fdt);
      } else {
        this._driftGrace -= fdt;
        if (this._driftGrace <= 0 || !racing || spd < 3) {
          this._drifting = false;
          events?.emit('drift:end', {
            score: Math.round(this._driftRun),
            duration: this._driftDur,
          });
        }
      }
    }
    this._driftF += ((this._drifting ? 1 : 0) - this._driftF) * Math.min(1, 4 * fdt);

    // Parking sleep: dead-still car stays dead still (no solver hum on the grid).
    if (!racing && this.vel.lengthSq() < 0.09 && this.angVelL.lengthSq() < 0.04) {
      this.vel.set(0, 0, 0);
      this.angVelL.multiplyScalar(0.8);
    }

    // NaN airbag: if anything exploded, restore last known-good transform.
    if (
      !Number.isFinite(this.pos.x + this.pos.y + this.pos.z + this.vel.x + this.vel.y + this.vel.z + q.x + q.w)
    ) {
      this.pos.copy(this._safePos);
      this.quat.copy(this._safeQuat);
      this.vel.set(0, 0, 0);
      this.angVelL.set(0, 0, 0);
    } else {
      this._safePos.copy(this.pos);
      this._safeQuat.copy(this.quat);
    }

    // ------------------------------------------------ write the contract
    this._writeState(fdt, throttle, brake, grounded, airborne);
  }

  // ------------------------------------------------------ wall hit response
  _resolveWallHit(normal, point, events, active, fdt) {
    const vn = this.vel.dot(normal);
    if (vn < 0) {
      const impact = -vn;
      // Reflect the normal component (small restitution), keep the slide.
      this.vel.addScaledVector(normal, -vn * (1 + T.WALL_REST));
      // Tangential scrub: walls are not ice.
      this.vel.multiplyScalar(1 - Math.min(0.25, impact * 0.01));
      // Glancing hits rotate the car: torque from impulse at the hit point.
      _tmpA.copy(point).sub(this.pos);
      _tmpB.copy(normal).multiplyScalar(impact * (1 + T.WALL_REST) * T.MASS * T.WALL_SPIN);
      _tmpC.crossVectors(_tmpA, _tmpB).applyQuaternion(_q0);
      this.angVelL.x = clamp(this.angVelL.x + (_tmpC.x / T.IX) * fdt * 20, -4, 4);
      this.angVelL.y = clamp(this.angVelL.y + (_tmpC.y / T.IY) * fdt * 20, -4, 4);
      this.angVelL.z = clamp(this.angVelL.z + (_tmpC.z / T.IZ) * fdt * 20, -3, 3);

      if (active && impact > T.COLLISION_EVENT_SPEED && this._collisionCd === 0) {
        this._collisionCd = T.COLLISION_COOLDOWN;
        events?.emit('car:collision', {
          point: point.clone(),
          normal: normal.clone(),
          speed: impact,
        });
      }
    }
  }

  // ------------------------------------------------------ state.car contract
  _writeState(fdt, throttle = 0, brake = 0, grounded = true, airborne = false) {
    const st = this.ctx.state;
    if (!st || !st.car) return;
    const c = st.car;

    c.position.copy(this.pos);
    c.quaternion.copy(this.quat);
    c.velocity.copy(this.vel);
    c.speedKmh = this.vel.length() * 3.6;
    c.rpm = this.rpm;
    c.gear = this.gear;
    c.steer = this._steerNorm;
    c.throttle = throttle;
    c.brake = brake;
    c.grounded = grounded;
    c.airborne = airborne;
    c.airTime = this._airT;
    c.drifting = this._drifting;
    c.driftAngle = this._driftAngle;
    c.boost = this._boostTank;
    c.boosting = this._boosting;
    c.surface = this._surface;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const cw = c.wheels[i];
      if (!cw) continue;
      cw.worldPos.copy(w.center);
      cw.radius = T.WHEEL_R;
      cw.spinAngle = w.spin;
      cw.steerAngle = w.steerAngle;
      cw.compression = clamp01(w.comp);
      cw.contact = w.contact;
      cw.slip = w.slipVis;
      cw.normal.copy(w.normal);
    }

    // Proper acceleration (accelerometer-style: includes reaction to gravity)
    // in chassis space — CarVisuals / Camera read this for weight transfer.
    _tmpA.copy(this.vel).sub(this._prevVel).multiplyScalar(1 / Math.max(fdt, 1e-4));
    _tmpA.y += T.GRAVITY;
    _q1.copy(this.quat).invert();
    _tmpA.applyQuaternion(_q1);
    c.localAccel.lerp(_tmpA, 0.3);
    this._prevVel.copy(this.vel);
  }
}

// Extra temps used inside methods that already saturate _v0.._v6.
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
