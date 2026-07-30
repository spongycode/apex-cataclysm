// CarVisuals.js — player car presentation layer for APEX: CATACLYSM CANYON.
// Syncs the procedural hypercar to state.car (physics is truth), animates wheels,
// brake/head lights, boost flames + heat glow, underglow pulse and a ground-following
// radial contact shadow. Zero per-frame allocations.

import * as THREE from 'three';
import { buildCarMesh, makeRadialTexture } from './carFactory.js';

const PLAYER_PAINT = 0xff1e55; // electric magenta-red
const PLAYER_ACCENT = 0xff7a1a; // hot orange

const WHEEL_REST_Y = -0.26;
const WHEEL_TRAVEL = 0.35;
const TUNNEL_T0 = 0.545;
const TUNNEL_T1 = 0.645;

// Module-level scratch — never allocate in update().
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _invMat = new THREE.Matrix4();
const _basis = new THREE.Matrix4();

export class CarVisuals {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = null;
    this.rig = null;
    this.shadow = null;
    this._headOn = 0; // headlight fade envelope 0..1
    this._brakeGlow = 1.0; // smoothed brake emissive
    this._flame = 0; // boost flame envelope 0..1
    this._shadowOpacity = 0;
    this._lastGear = 1;
    this._shiftFlash = 0;
  }

  async init() {
    const ctx = this.ctx;
    this.rig = buildCarMesh({ paint: PLAYER_PAINT, accent: PLAYER_ACCENT });
    this.group = this.rig.group;
    this.group.name = 'playerCar';

    const car = ctx.state && ctx.state.car;
    if (car) {
      this.group.position.copy(car.position);
      this.group.quaternion.copy(car.quaternion);
    }
    ctx.scene.add(this.group);

    // Radial-gradient contact shadow, scene-level so it can hug the ground
    // independently of chassis pitch/roll.
    const shadowTex = makeRadialTexture([
      [0, 'rgba(0,0,0,0.92)'],
      [0.42, 'rgba(0,0,0,0.6)'],
      [0.75, 'rgba(0,0,0,0.2)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
    const shadowGeo = new THREE.PlaneGeometry(3.3, 5.3);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        color: 0x000000,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      })
    );
    this.shadow.renderOrder = 2;
    this.shadow.matrixAutoUpdate = true;
    ctx.scene.add(this.shadow);
  }

  update(dt, time) {
    const st = this.ctx.state;
    const car = st && st.car;
    const g = this.group;
    if (!car || !g) return;

    /* ---- chassis: physics quaternion/position is truth ---- */
    g.position.copy(car.position);
    g.quaternion.copy(car.quaternion);
    g.updateMatrixWorld(true);
    _invMat.copy(g.matrixWorld).invert();

    /* ---- wheels: suspension travel + spin + steer ---- */
    const wheels = this.rig.wheels;
    const carWheels = car.wheels;
    if (wheels && carWheels) {
      for (let i = 0; i < 4; i++) {
        const wd = carWheels[i];
        const pivot = wheels[i];
        if (!wd || !pivot) continue;

        // Prefer physics-authored world position; fall back to compression.
        let y = null;
        const wp = wd.worldPos;
        if (wp && (wp.x !== 0 || wp.y !== 0 || wp.z !== 0)) {
          _v1.copy(wp).applyMatrix4(_invMat);
          if (_v1.y > -0.75 && _v1.y < 0.15) y = _v1.y;
        }
        if (y === null) {
          const c = typeof wd.compression === 'number' ? wd.compression : 0.5;
          y = WHEEL_REST_Y + (c - 0.5) * WHEEL_TRAVEL * 0.8;
        }
        if (y < -0.55) y = -0.55;
        else if (y > -0.06) y = -0.06;
        // Light smoothing kills fixed-step aliasing without feeling laggy.
        pivot.position.y += (y - pivot.position.y) * Math.min(1, 30 * dt);

        pivot.rotation.y = i < 2 ? wd.steerAngle || 0 : 0;
        const spin = pivot.userData.spin;
        if (spin) spin.rotation.x = (wd.spinAngle || 0) * pivot.userData.spinSign;
      }
    }

    /* ---- brake lights: flare on brake/handbrake, blip on shifts ---- */
    const actions = this.ctx.input && this.ctx.input.actions;
    const braking = car.brake > 0.15 || !!(actions && actions.handbrake);
    if (car.gear !== this._lastGear) {
      this._shiftFlash = 0.09;
      this._lastGear = car.gear;
    }
    if (this._shiftFlash > 0) this._shiftFlash -= dt;
    let brakeTarget = braking ? 6.0 : this._headOn > 0.5 ? 1.4 : 0.6;
    if (this._shiftFlash > 0 && brakeTarget < 3.0) brakeTarget = 3.0;
    this._brakeGlow += (brakeTarget - this._brakeGlow) * Math.min(1, 18 * dt);
    if (this.rig.brakeLightMat) this.rig.brakeLightMat.emissiveIntensity = this._brakeGlow;

    /* ---- headlights: rain or tunnel, with smooth fade ---- */
    const weather = st.weather;
    const p = st.progress || 0;
    const wantLights =
      (weather && weather.rain > 0.3) || (p >= TUNNEL_T0 && p <= TUNNEL_T1) || car.surface === 'metal';
    this._headOn += ((wantLights ? 1 : 0) - this._headOn) * Math.min(1, 3.2 * dt);
    if (this._headOn < 0.015 && !wantLights) this._headOn = 0;
    const lights = this.rig.headlights;
    if (lights) {
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        l.intensity = (l.userData.maxIntensity || 3200) * this._headOn;
        l.visible = this._headOn > 0.01;
      }
    }
    const hm = g.userData.headlightMat;
    if (hm) hm.emissiveIntensity = 2.4 + 3.6 * this._headOn;

    /* ---- boost flames + heat glow ---- */
    const boosting = !!car.boosting;
    this._flame += ((boosting ? 1 : 0) - this._flame) * Math.min(1, 14 * dt);
    if (this._flame < 0.02 && !boosting) this._flame = 0;
    const flames = this.rig.boostFlames;
    const glow = g.userData.boostGlow;
    if (flames) {
      const show = this._flame > 0.01;
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i];
        f.visible = show;
        if (!show) continue;
        const flick =
          0.62 +
          0.38 * Math.abs(Math.sin(time * 63.0 + i * 7.7) * (0.6 + 0.4 * Math.sin(time * 21.3 + i)));
        const w = this._flame * (0.75 + 0.35 * flick);
        f.scale.set(w, w, this._flame * (0.55 + 0.95 * flick) + 0.001);
        f.material.opacity = this._flame * (0.65 + 0.35 * flick);
        const inner = f.userData.inner;
        if (inner) inner.material.opacity = this._flame * (0.8 + 0.2 * flick);
        if (glow) {
          glow.visible = true;
          glow.intensity = this._flame * (22 + 26 * flick);
        }
      }
      if (!show && glow) {
        glow.visible = false;
        glow.intensity = 0;
      }
    }

    /* ---- underglow pulse ---- */
    const ug = g.userData.underglow;
    if (ug) ug.material.opacity = 0.15 + 0.05 * Math.sin(time * 2.1) + 0.28 * this._flame;

    /* ---- contact shadow: hug ground when grounded, fade airborne ---- */
    const world = this.ctx.world;
    let shadowTarget = 0;
    if (world && this.shadow) {
      _v2.set(0, -1, 0).applyQuaternion(car.quaternion); // -chassisUp
      const hit = world.raycast(car.position, _v2, 7);
      if (hit) {
        const d = hit.distance;
        let k = 1 - (d - 0.62) / 5.4;
        if (k < 0) k = 0;
        else if (k > 1) k = 1;
        shadowTarget = 0.62 * k * (car.grounded ? 1 : 0.8);
        this.shadow.position.copy(hit.point).addScaledVector(hit.normal, 0.05);
        // Basis: y = surface normal, -z = car forward projected onto surface.
        _fwd.set(0, 0, -1).applyQuaternion(car.quaternion);
        _fwd.addScaledVector(hit.normal, -_fwd.dot(hit.normal));
        if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0);
        _fwd.normalize();
        _v3.copy(_fwd).negate(); // plane local +z
        _right.crossVectors(hit.normal, _v3).normalize();
        _basis.makeBasis(_right, hit.normal, _v3);
        this.shadow.quaternion.setFromRotationMatrix(_basis);
        const s = 1 + d * 0.05;
        this.shadow.scale.set(s, 1, s);
      }
    }
    if (this.shadow) {
      this._shadowOpacity += (shadowTarget - this._shadowOpacity) * Math.min(1, 10 * dt);
      this.shadow.material.opacity = this._shadowOpacity;
      this.shadow.visible = this._shadowOpacity > 0.01;
    }
  }
}
