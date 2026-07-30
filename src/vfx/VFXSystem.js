// VFXSystem — every particle effect in the game, driven by two shared GPU pools
// (one normal-blended for smoke/dust/debris/confetti, one additive for fire/sparks/
// glow/wisps). All spawning goes through ParticlePool.emit (ring buffer, zero
// steady-state allocation); simulation runs entirely on the GPU.
//
// Continuous (reads state.car each frame): tire smoke / dirt & sand plumes per
// slipping wheel, rooster tails on loose surfaces, water-ford bow spray + splash
// rings + droplets, boost flame jets + heat streaks + backfire pops, speed wisps
// past the camera > 180 km/h, ambient tunnel spark showers.
// Event-driven: car:collision sparks, setpiece:explosion / barrel prop:break
// fireball+smoke+debris+shockwave, prop:break debris bursts, setpiece:rockslide
// dust wall, car:landed dust ring, race:finish confetti + fireworks.

import * as THREE from 'three';
import {
  ParticlePool, MODE_BILLBOARD, MODE_FLAT, MODE_STRETCH,
  TILE_BLOB, TILE_DOT, TILE_RING, TILE_CHUNK,
} from './ParticlePool.js';
import { buildParticleAtlas } from './particleTexture.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const EXHAUSTS = [new THREE.Vector3(-0.42, -0.16, 2.08), new THREE.Vector3(0.42, -0.16, 2.08)];

// surface → [r0,g0,b0, r1,g1,b1] dust/smoke ramp
const DUST_COLORS = {
  asphalt: [0.82, 0.82, 0.86, 0.94, 0.94, 0.98],
  metal: [0.78, 0.78, 0.84, 0.9, 0.9, 0.95],
  wood: [0.6, 0.49, 0.37, 0.74, 0.65, 0.53],
  dirt: [0.45, 0.33, 0.21, 0.63, 0.51, 0.38],
  sand: [0.79, 0.66, 0.45, 0.9, 0.8, 0.62],
  rock: [0.5, 0.47, 0.43, 0.68, 0.66, 0.62],
  water: [0.8, 0.88, 0.94, 0.9, 0.95, 1.0],
};
const HARD_SURF = { asphalt: 1, metal: 1, wood: 1 };

const PROP_COLORS = {
  sign: [0.76, 0.78, 0.82, 0.45, 0.47, 0.5],
  cone: [1.0, 0.42, 0.08, 0.72, 0.26, 0.05],
  crate: [0.58, 0.42, 0.24, 0.4, 0.28, 0.15],
  fence: [0.55, 0.45, 0.32, 0.38, 0.3, 0.2],
  barrel: [0.7, 0.2, 0.12, 0.35, 0.12, 0.06],
};

const FW_COLORS = [
  [1.7, 0.35, 0.95], [1.7, 0.95, 0.3], [0.4, 1.25, 1.7],
  [1.7, 1.5, 0.5], [0.7, 1.6, 0.6], [1.6, 1.6, 1.6],
];
const CONFETTI_COLORS = [
  [1, 0.16, 0.45], [1, 0.55, 0.15], [1, 0.9, 0.25],
  [0.25, 0.8, 1], [0.55, 1, 0.45], [1, 1, 1],
];

function randSphere(out) {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * 6.28318;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  out.set(r * Math.cos(a), u, r * Math.sin(a));
  return out;
}

export class VFXSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.events = ctx.events;
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    this._simTime = 0;
    this._lod = 1;

    // fractional spawn accumulators (continuous emitters)
    this._accWheel = new Float32Array(4);
    this._accRooster = new Float32Array(2);
    this._accSpray = new Float32Array(2);
    this._accDrops = 0;
    this._accRing = 0;
    this._accFlame = new Float32Array(2);
    this._accHeat = 0;
    this._accWisp = 0;
    this._backfireT = 0.5;
    this._tunnelT = 0.8;

    // fireworks scheduler: [fireTime, x, y, z, colorIdx] x 12 slots
    this._fw = new Float32Array(12 * 5);
    this._fwN = 0;
  }

  async init() {
    const atlas = buildParticleAtlas();
    // normal-blended: smoke, dust, debris, confetti, spray
    this.smoke = new ParticlePool({
      capacity: 22000, blending: THREE.NormalBlending, map: atlas, renderOrder: 20,
    });
    // additive: fire, sparks, glow, wisps, fireworks, shockwaves
    this.glow = new ParticlePool({
      capacity: 20000, blending: THREE.AdditiveBlending, map: atlas, renderOrder: 21,
    });
    this.scene.add(this.smoke.mesh);
    this.scene.add(this.glow.mesh);

    const ev = this.events;
    ev.on('car:collision', (p) => {
      if (!p || !p.point) return;
      this._sparks(p.point, p.normal || null, p.speed || 10);
    });
    ev.on('setpiece:explosion', (p) => {
      if (!p || !p.position) return;
      this._explosion(p.position, Math.min(p.radius || 8, 28), 1);
    });
    ev.on('prop:break', (p) => this._propBreak(p));
    ev.on('setpiece:rockslide', (p) => {
      if (!p || !p.position) return;
      this._rockslide(p.position);
    });
    ev.on('setpiece:collapse', (p) => {
      if (!p || !p.position) return;
      this._collapseDust(p.position);
    });
    ev.on('car:landed', (p) => this._landingDust(p));
    ev.on('race:finish', () => this._finishCelebration());
    ev.on('race:restart', () => {
      this.smoke.killAll();
      this.glow.killAll();
      this._fwN = 0;
      this._accWheel.fill(0);
      this._accRooster.fill(0);
      this._accSpray.fill(0);
      this._accDrops = this._accRing = this._accHeat = this._accWisp = 0;
      this._accFlame.fill(0);
    });
  }

  update(dt, time) {
    const st = this.state;
    if (!st) return;
    this._simTime += Math.max(0, dt);
    const t = this._simTime;
    this.smoke.setTime(t);
    this.glow.setTime(t);

    const q = st.settings ? st.settings.quality : 'high';
    this._lod = q === 'high' ? 1 : q === 'low' ? 0.35 : 0.5;

    const car = st.car;
    const active = st.phase === 'racing' || st.phase === 'finished' || st.phase === 'countdown';
    if (car && car.position && car.velocity && car.quaternion && car.wheels && active) {
      if (car.surface === 'water') this._updateWater(car, dt, t);
      else this._updateWheels(car, dt, t);
      this._updateBoost(car, dt, t);
      this._updateWisps(car, dt, t);
      this._updateTunnelSparks(car, st, dt, t);
    }
    this._updateFireworks(t);

    this.smoke.flush();
    this.glow.flush();
  }

  // ------------------------------------------------------------------ wheels

  _updateWheels(car, dt, t) {
    const surf = car.surface || 'asphalt';
    const col = DUST_COLORS[surf] || DUST_COLORS.asphalt;
    const hard = HARD_SURF[surf] === 1;
    const speed = car.velocity.length();
    const speed01 = Math.min(1, speed / 42);
    const lod = this._lod;
    _v4.set(0, 0, 1).applyQuaternion(car.quaternion); // backward

    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      if (!w || !w.contact || !w.worldPos) { this._accWheel[i] = 0; continue; }
      const slip = w.slip || 0;
      const rad = w.radius || 0.34;
      const nrm = w.normal && w.normal.lengthSq() > 0.5 ? w.normal : _up;

      let rate = 0;
      if (hard) {
        if (slip > 0.32 && speed > 3) rate = ((slip - 0.32) / 0.68) * 30 * Math.min(1, speed / 7);
      } else if (speed > 3 || slip > 0.35) {
        rate = (0.3 * speed01 + slip * 0.85) * 20;
      }
      this._accWheel[i] += rate * lod * dt;
      let n = this._accWheel[i] | 0;
      if (n > 0) {
        this._accWheel[i] -= n;
        if (n > 6) n = 6;
        for (let j = 0; j < n; j++) {
          _v1.copy(w.worldPos).addScaledVector(nrm, -rad * 0.65);
          _v1.x += (Math.random() - 0.5) * 0.35;
          _v1.y += Math.random() * 0.08;
          _v1.z += (Math.random() - 0.5) * 0.35;
          _v2.copy(car.velocity).multiplyScalar(0.14)
            .addScaledVector(nrm, 0.5 + Math.random() * 1.3);
          _v2.x += (Math.random() - 0.5) * 1.4;
          _v2.z += (Math.random() - 0.5) * 1.4;
          if (hard) {
            // white rubber smoke — buoyant, curling, grows fast
            this.smoke.emit(t, 0.9 + Math.random() * 0.9,
              _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
              -0.4, 1.5, 0.3 + speed01 * 0.3, 1.9 + speed01 * 1.6,
              col[0], col[1], col[2], col[3], col[4], col[5],
              Math.min(0.62, 0.38 + slip * 0.3),
              Math.random() * 6.28, (Math.random() - 0.5) * 2.4,
              TILE_BLOB, MODE_BILLBOARD, 0.9);
          } else {
            // dirt / sand / rock plume — heavier, settles
            this.smoke.emit(t, 0.7 + Math.random() * 0.6,
              _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
              2.2, 1.1, 0.28, 1.5 + speed01,
              col[0], col[1], col[2], col[3], col[4], col[5],
              0.55, Math.random() * 6.28, (Math.random() - 0.5) * 3,
              TILE_BLOB, MODE_BILLBOARD, 0.5);
          }
        }
      }

      // rooster tails — rear wheels, loose surface, at speed
      if (!hard && i >= 2 && (surf === 'dirt' || surf === 'sand') && speed > 15) {
        const ri = i - 2;
        this._accRooster[ri] += 30 * lod * Math.min(1, (speed - 15) / 28) * dt;
        let m = this._accRooster[ri] | 0;
        if (m > 0) {
          this._accRooster[ri] -= m;
          if (m > 5) m = 5;
          for (let j = 0; j < m; j++) {
            _v1.copy(w.worldPos).addScaledVector(nrm, -rad * 0.6);
            _v2.copy(_v4).multiplyScalar(5 + speed * 0.28 + Math.random() * 3);
            _v2.y += 2.5 + Math.random() * 4.5;
            _v2.x += (Math.random() - 0.5) * 2;
            _v2.z += (Math.random() - 0.5) * 2;
            this.smoke.emit(t, 0.7 + Math.random() * 0.5,
              _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
              9.5, 0.55, 0.24, 1.2,
              col[0], col[1], col[2], col[3], col[4], col[5],
              0.7, Math.random() * 6.28, (Math.random() - 0.5) * 4,
              TILE_BLOB, MODE_BILLBOARD, 0.2);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ water ford

  _updateWater(car, dt, t) {
    const speed = car.velocity.length();
    if (speed < 3) return;
    const speed01 = Math.min(1, speed / 30);
    const lod = this._lod;
    const col = DUST_COLORS.water;
    _v4.set(0, 0, -1).applyQuaternion(car.quaternion); // forward
    _v5.crossVectors(_v4, _up); // lateral
    if (_v5.lengthSq() < 1e-4) _v5.set(1, 0, 0);
    _v5.normalize();

    // bow-wave spray sheets from the front wheels
    for (let f = 0; f < 2; f++) {
      const w = car.wheels[f];
      if (!w || !w.worldPos) continue;
      const waterY = w.worldPos.y - (w.radius || 0.34) + 0.05;
      const side = f === 0 ? -1 : 1;
      this._accSpray[f] += 55 * speed01 * lod * dt;
      let n = this._accSpray[f] | 0;
      if (n > 0) {
        this._accSpray[f] -= n;
        if (n > 6) n = 6;
        for (let j = 0; j < n; j++) {
          _v1.copy(w.worldPos).addScaledVector(_v4, 0.4);
          _v1.y = waterY;
          _v2.copy(_v4).multiplyScalar(speed * (0.3 + Math.random() * 0.22))
            .addScaledVector(_v5, side * (2 + Math.random() * 3.5));
          _v2.y = 2.2 + Math.random() * 3.5;
          this.smoke.emit(t, 0.45 + Math.random() * 0.45,
            _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
            8.5, 0.9, 0.22, 1.2,
            col[0], col[1], col[2], col[3], col[4], col[5],
            0.8, Math.random() * 6.28, (Math.random() - 0.5) * 3,
            TILE_BLOB, MODE_BILLBOARD, 0.15);
        }
      }
    }

    // sparkling droplets
    this._accDrops += 45 * speed01 * lod * dt;
    let n = this._accDrops | 0;
    if (n > 0) {
      this._accDrops -= n;
      if (n > 5) n = 5;
      const w = car.wheels[(Math.random() * 4) | 0];
      if (w && w.worldPos) {
        const waterY = w.worldPos.y - (w.radius || 0.34) + 0.05;
        for (let j = 0; j < n; j++) {
          _v1.copy(w.worldPos);
          _v1.y = waterY;
          _v2.copy(car.velocity).multiplyScalar(0.4);
          _v2.x += (Math.random() - 0.5) * 5;
          _v2.y = 3 + Math.random() * 5;
          _v2.z += (Math.random() - 0.5) * 5;
          this.glow.emit(t, 0.35 + Math.random() * 0.4,
            _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
            11, 0.4, 0.055 + Math.random() * 0.03, 0.02,
            1.1, 1.3, 1.5, 0.5, 0.65, 0.85,
            0.7, 0, 0, TILE_DOT, MODE_STRETCH, 4);
        }
      }
    }

    // expanding splash rings on the surface
    this._accRing += 9 * speed01 * lod * dt;
    let m = this._accRing | 0;
    if (m > 0) {
      this._accRing -= m;
      if (m > 2) m = 2;
      for (let j = 0; j < m; j++) {
        const w = car.wheels[(Math.random() * 4) | 0];
        if (!w || !w.worldPos) continue;
        const waterY = w.worldPos.y - (w.radius || 0.34) + 0.04;
        this.smoke.emit(t, 0.55,
          w.worldPos.x, waterY, w.worldPos.z, 0, 0, 0,
          0, 0, 0.5, 3.2,
          0.9, 0.96, 1.0, 0.72, 0.84, 0.92,
          0.5, Math.random() * 6.28, 0.6,
          TILE_RING, MODE_FLAT, 0);
      }
    }
  }

  // ------------------------------------------------------------------ boost

  _updateBoost(car, dt, t) {
    if (!car.boosting) { this._backfireT = Math.min(this._backfireT, 0.35); return; }
    const lod = this._lod;
    _v4.set(0, 0, 1).applyQuaternion(car.quaternion); // backward

    for (let e = 0; e < 2; e++) {
      _v3.copy(EXHAUSTS[e]).applyQuaternion(car.quaternion).add(car.position);
      this._accFlame[e] += 230 * lod * dt;
      let n = this._accFlame[e] | 0;
      if (n > 0) {
        this._accFlame[e] -= n;
        if (n > 8) n = 8;
        for (let j = 0; j < n; j++) {
          _v1.copy(_v3);
          _v1.x += (Math.random() - 0.5) * 0.08;
          _v1.y += (Math.random() - 0.5) * 0.08;
          _v1.z += (Math.random() - 0.5) * 0.08;
          _v2.copy(car.velocity).addScaledVector(_v4, 13 + Math.random() * 8);
          _v2.x += (Math.random() - 0.5) * 1.2;
          _v2.y += (Math.random() - 0.5) * 1.2;
          _v2.z += (Math.random() - 0.5) * 1.2;
          // blue-white core cooling to orange
          this.glow.emit(t, 0.09 + Math.random() * 0.13,
            _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
            -1, 2.5, 0.3, 0.05,
            1.3, 1.5, 2.4, 2.3, 0.75, 0.12,
            0.85, Math.random() * 6.28, 9,
            TILE_DOT, MODE_BILLBOARD, 0);
        }
      }
    }

    // faint heat streaks trailing the car
    this._accHeat += 46 * lod * dt;
    let h = this._accHeat | 0;
    if (h > 0) {
      this._accHeat -= h;
      if (h > 3) h = 3;
      for (let j = 0; j < h; j++) {
        _v1.copy(car.position).addScaledVector(_v4, 2.4 + Math.random() * 1.5);
        _v1.x += (Math.random() - 0.5) * 1;
        _v1.y += (Math.random() - 0.5) * 0.6;
        _v1.z += (Math.random() - 0.5) * 1;
        _v2.copy(car.velocity).multiplyScalar(0.55).addScaledVector(_v4, 16);
        this.glow.emit(t, 0.28 + Math.random() * 0.15,
          _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
          0, 1.2, 0.16, 0.05,
          1.1, 0.85, 0.55, 0.6, 0.4, 0.25,
          0.16, 0, 0, TILE_DOT, MODE_STRETCH, 7);
      }
    }

    // occasional backfire pop
    this._backfireT -= dt;
    if (this._backfireT <= 0) {
      this._backfireT = 0.5 + Math.random() * 1.2;
      const e = Math.random() < 0.5 ? 0 : 1;
      _v1.copy(EXHAUSTS[e]).applyQuaternion(car.quaternion).add(car.position);
      _v2.copy(car.velocity).multiplyScalar(0.9);
      this.glow.emit(t, 0.11,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        0, 0, 0.5, 1.7,
        2.2, 1.6, 2.8, 1.9, 0.6, 0.1,
        0.95, Math.random() * 6.28, 0,
        TILE_DOT, MODE_BILLBOARD, 0);
      for (let j = 0; j < 6; j++) {
        _v3.copy(car.velocity).multiplyScalar(0.5).addScaledVector(_v4, 8 + Math.random() * 8);
        _v3.x += (Math.random() - 0.5) * 4;
        _v3.y += Math.random() * 3;
        _v3.z += (Math.random() - 0.5) * 4;
        this.glow.emit(t, 0.2 + Math.random() * 0.3,
          _v1.x, _v1.y, _v1.z, _v3.x, _v3.y, _v3.z,
          9, 1.2, 0.05, 0.02,
          2.6, 1.9, 0.8, 1.7, 0.5, 0.08,
          0.9, 0, 0, TILE_DOT, MODE_STRETCH, 4);
      }
      this.events.emit('audio:sfx', { name: 'backfire', volume: 0.4 });
    }
  }

  // ------------------------------------------------------------------ speed wisps

  _updateWisps(car, dt, t) {
    const kmh = car.speedKmh || 0;
    if (kmh < 180) { this._accWisp = 0; return; }
    const cam = this.camera;
    if (!cam) return;
    const f = Math.min(1, (kmh - 180) / 70);
    this._accWisp += (24 + 30 * f + (car.boosting ? 16 : 0)) * this._lod * dt;
    let n = this._accWisp | 0;
    if (n === 0) return;
    this._accWisp -= n;
    if (n > 4) n = 4;

    _v4.copy(car.velocity).normalize();
    _v5.crossVectors(_v4, _up);
    if (_v5.lengthSq() < 1e-4) _v5.set(1, 0, 0);
    _v5.normalize();
    _v3.crossVectors(_v5, _v4).normalize();

    for (let j = 0; j < n; j++) {
      const a = Math.random() * 6.28318;
      const r = 3 + Math.random() * 7;
      _v1.copy(cam.position)
        .addScaledVector(_v4, 16 + Math.random() * 28)
        .addScaledVector(_v5, Math.cos(a) * r)
        .addScaledVector(_v3, Math.sin(a) * r);
      _v2.copy(_v4).multiplyScalar(-(3 + Math.random() * 3));
      this.glow.emit(t, 0.3 + Math.random() * 0.2,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        0, 0, 0.08 + Math.random() * 0.05, 0.05,
        0.7, 0.78, 0.92, 0.45, 0.5, 0.65,
        0.15 + 0.1 * f, 0, 0, TILE_DOT, MODE_STRETCH, 45 + Math.random() * 30);
    }
  }

  // ------------------------------------------------------------------ tunnel ambience

  _updateTunnelSparks(car, st, dt, t) {
    const p = st.progress || 0;
    if (p < 0.55 || p > 0.64) return;
    this._tunnelT -= dt;
    if (this._tunnelT > 0) return;
    this._tunnelT = 0.5 + Math.random() * 1.1;
    _v4.set(0, 0, -1).applyQuaternion(car.quaternion);
    _v1.copy(car.position).addScaledVector(_v4, 18 + Math.random() * 22);
    _v1.x += (Math.random() - 0.5) * 6;
    _v1.y += 4.2 + Math.random() * 1.5;
    _v1.z += (Math.random() - 0.5) * 6;
    const n = ((8 + Math.random() * 8) * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      _v2.set((Math.random() - 0.5) * 3, -(1 + Math.random() * 2), (Math.random() - 0.5) * 3);
      this.glow.emit(t + Math.random() * 0.15, 0.5 + Math.random() * 0.6,
        _v1.x + (Math.random() - 0.5) * 0.3, _v1.y, _v1.z + (Math.random() - 0.5) * 0.3,
        _v2.x, _v2.y, _v2.z,
        9.5, 0.7, 0.04 + Math.random() * 0.03, 0.015,
        2.6, 1.9, 0.8, 1.6, 0.55, 0.1,
        0.9, 0, 0, TILE_DOT, MODE_STRETCH, 5);
    }
  }

  // ------------------------------------------------------------------ collisions

  _sparks(point, normal, speed) {
    const t = this._simTime;
    const car = this.state ? this.state.car : null;
    let n = (Math.min(36, 8 + speed * 1.1) * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      _v1.copy(point);
      _v1.x += (Math.random() - 0.5) * 0.3;
      _v1.y += (Math.random() - 0.5) * 0.3;
      _v1.z += (Math.random() - 0.5) * 0.3;
      _v2.set((Math.random() - 0.5) * 5, Math.random() * 3.5, (Math.random() - 0.5) * 5);
      if (normal) _v2.addScaledVector(normal, 1.5 + Math.random() * 3.5);
      if (car && car.velocity) _v2.addScaledVector(car.velocity, 0.4);
      this.glow.emit(t, 0.25 + Math.random() * 0.5,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        10.5, 1.6, 0.05 + Math.random() * 0.05, 0.02,
        2.8, 2.2, 1.1, 1.9, 0.55, 0.08,
        1, 0, 0, TILE_DOT, MODE_STRETCH, 4.5 + Math.random() * 3);
    }
    // scrape puff
    for (let j = 0; j < 3; j++) {
      _v2.set((Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 2);
      this.smoke.emit(t, 0.6 + Math.random() * 0.5,
        point.x, point.y, point.z, _v2.x, _v2.y, _v2.z,
        -0.3, 1.6, 0.3, 1.4,
        0.55, 0.55, 0.58, 0.72, 0.72, 0.75,
        0.4, Math.random() * 6.28, (Math.random() - 0.5) * 3,
        TILE_BLOB, MODE_BILLBOARD, 0.4);
    }
  }

  // ------------------------------------------------------------------ explosions

  _explosion(pos, radius, power) {
    const t = this._simTime;
    const lod = this._lod;
    const r = Math.max(3, radius);

    // core flash
    this.glow.emit(t, 0.18,
      pos.x, pos.y + r * 0.25, pos.z, 0, 0, 0,
      0, 0, r * 1.2, r * 2.6,
      4, 3.2, 2.2, 2, 0.6, 0.2,
      0.9, Math.random() * 6.28, 0, TILE_DOT, MODE_BILLBOARD, 0);

    // expanding ground shockwave ring
    this.glow.emit(t, 0.7,
      pos.x, pos.y + 0.4, pos.z, 0, 0, 0,
      0, 0, r * 0.8, r * 7,
      3, 2.4, 1.6, 1.2, 0.5, 0.2,
      0.75, Math.random() * 6.28, 0.4, TILE_RING, MODE_FLAT, 0);

    // fireball billow — hot core cooling to deep orange
    let n = (26 * power * lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2);
      _v2.y = Math.abs(_v2.y) * 0.9 + 0.25;
      _v1.copy(pos).addScaledVector(_v2, Math.random() * r * 0.3);
      _v2.multiplyScalar(3.5 + Math.random() * 9);
      this.glow.emit(t + Math.random() * 0.1, 0.7 + Math.random() * 0.6,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        -2.5, 1.6, r * 0.28, r * (0.85 + Math.random() * 0.5),
        2.5, 1.8, 0.9, 1.35, 0.24, 0.03,
        0.9, Math.random() * 6.28, (Math.random() - 0.5) * 3,
        TILE_BLOB, MODE_BILLBOARD, 0.6);
    }

    // rising smoke column (delayed spawn so it emerges from the fire)
    n = (30 * power * lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2);
      _v1.copy(pos).addScaledVector(_v2, Math.random() * r * 0.35);
      _v1.y += r * 0.3;
      _v2.set(_v2.x * 2.5, 3.5 + Math.random() * 5.5, _v2.z * 2.5);
      this.smoke.emit(t + 0.15 + Math.random() * 0.5, 2.2 + Math.random() * 2.2,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        -1.2, 0.9, r * 0.35, r * (1.4 + Math.random() * 0.6),
        0.14, 0.12, 0.11, 0.36, 0.33, 0.31,
        0.85, Math.random() * 6.28, (Math.random() - 0.5) * 1.6,
        TILE_BLOB, MODE_BILLBOARD, 1.6);
    }

    // glowing debris chunks arcing out
    n = (20 * power * lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2);
      _v2.y = Math.abs(_v2.y) * 1.3 + 0.3;
      _v2.multiplyScalar(8 + Math.random() * 18 * power);
      this.glow.emit(t, 1.2 + Math.random() * 1.3,
        pos.x, pos.y + 0.5, pos.z, _v2.x, _v2.y, _v2.z,
        12, 0.25, 0.22 + Math.random() * 0.3, 0.12,
        2.2, 1.1, 0.4, 0.5, 0.12, 0.03,
        1, Math.random() * 6.28, (Math.random() - 0.5) * 24,
        TILE_CHUNK, MODE_BILLBOARD, 0);
    }

    // streaking embers
    n = (34 * power * lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2).multiplyScalar(4 + Math.random() * 11);
      _v2.y = Math.abs(_v2.y) + 2;
      this.glow.emit(t, 0.9 + Math.random() * 0.9,
        pos.x, pos.y + 0.5, pos.z, _v2.x, _v2.y, _v2.z,
        4, 1.1, 0.09, 0.02,
        2.5, 1.5, 0.5, 1.2, 0.3, 0.05,
        0.9, 0, 0, TILE_DOT, MODE_STRETCH, 3);
    }

    // low dust ring skirting outward
    n = (10 * lod) | 0;
    for (let j = 0; j < n; j++) {
      const a = Math.random() * 6.28318;
      _v2.set(Math.cos(a) * (6 + Math.random() * 8), 0.8, Math.sin(a) * (6 + Math.random() * 8));
      this.smoke.emit(t + 0.05, 1.1 + Math.random() * 0.8,
        pos.x, pos.y + 0.4, pos.z, _v2.x, _v2.y, _v2.z,
        0.5, 1.8, r * 0.3, r * 0.9,
        0.5, 0.42, 0.34, 0.66, 0.6, 0.53,
        0.6, Math.random() * 6.28, (Math.random() - 0.5) * 2,
        TILE_BLOB, MODE_BILLBOARD, 0.5);
    }

    // distance-scaled camera shake
    const car = this.state ? this.state.car : null;
    if (car && car.position) {
      const dist = _v1.copy(pos).sub(car.position).length();
      const intensity = Math.min(1, (r * 6) / (12 + dist)) * 0.85;
      if (intensity > 0.05) {
        this.events.emit('camera:shake', { intensity, duration: 0.55 });
      }
    }
  }

  // ------------------------------------------------------------------ props

  _propBreak(p) {
    if (!p || !p.position) return;
    const type = p.type || 'crate';
    const pos = p.position;
    if (type === 'barrel') {
      this._explosion(pos, 6, 0.75);
      return;
    }
    const t = this._simTime;
    const col = PROP_COLORS[type] || PROP_COLORS.crate;
    const car = this.state ? this.state.car : null;

    let n = (16 * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2);
      _v2.y = Math.abs(_v2.y) * 1.2 + 0.4;
      _v2.multiplyScalar(3.5 + Math.random() * 7);
      if (car && car.velocity) _v2.addScaledVector(car.velocity, 0.25);
      this.smoke.emit(t, 0.9 + Math.random() * 0.9,
        pos.x, pos.y + 0.4, pos.z, _v2.x, _v2.y, _v2.z,
        11, 0.5, 0.1 + Math.random() * 0.16, 0.06,
        col[0], col[1], col[2], col[3], col[4], col[5],
        1, Math.random() * 6.28, (Math.random() - 0.5) * 28,
        TILE_CHUNK, MODE_BILLBOARD, 0);
    }
    // impact puff
    for (let j = 0; j < 5; j++) {
      _v2.set((Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3);
      this.smoke.emit(t, 0.6 + Math.random() * 0.4,
        pos.x, pos.y + 0.3, pos.z, _v2.x, _v2.y, _v2.z,
        0.5, 1.8, 0.35, 1.5,
        col[0] * 0.9 + 0.1, col[1] * 0.9 + 0.1, col[2] * 0.9 + 0.1,
        col[3], col[4], col[5],
        0.45, Math.random() * 6.28, (Math.random() - 0.5) * 3,
        TILE_BLOB, MODE_BILLBOARD, 0.4);
    }
    // metal signs throw sparks
    if (type === 'sign' && car && car.velocity) {
      for (let j = 0; j < 8; j++) {
        _v2.copy(car.velocity).multiplyScalar(0.45);
        _v2.x += (Math.random() - 0.5) * 6;
        _v2.y += 1 + Math.random() * 4;
        _v2.z += (Math.random() - 0.5) * 6;
        this.glow.emit(t, 0.25 + Math.random() * 0.4,
          pos.x, pos.y + 0.6, pos.z, _v2.x, _v2.y, _v2.z,
          10, 1.4, 0.05, 0.02,
          2.8, 2.2, 1.1, 1.9, 0.55, 0.08,
          1, 0, 0, TILE_DOT, MODE_STRETCH, 5);
      }
    }
  }

  // ------------------------------------------------------------------ set pieces

  _rockslide(pos) {
    const t = this._simTime;
    const lod = this._lod;

    // towering dust wall, staggered over ~1.2 s
    let n = (50 * lod) | 0;
    for (let j = 0; j < n; j++) {
      const a = Math.random() * 6.28318;
      const rr = Math.random() * 24;
      _v1.set(pos.x + Math.cos(a) * rr, pos.y + Math.random() * 3, pos.z + Math.sin(a) * rr);
      _v2.set(Math.cos(a) * (1.5 + Math.random() * 4), 1.5 + Math.random() * 4.5, Math.sin(a) * (1.5 + Math.random() * 4));
      this.smoke.emit(t + Math.random() * 1.2, 2.6 + Math.random() * 2.2,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        -0.6, 1, 3.5 + Math.random() * 2.5, 13 + Math.random() * 9,
        0.42, 0.34, 0.27, 0.6, 0.54, 0.47,
        0.75, Math.random() * 6.28, (Math.random() - 0.5) * 1.4,
        TILE_BLOB, MODE_BILLBOARD, 1.2);
    }
    // flying rock chips
    n = (22 * lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2);
      _v2.y = Math.abs(_v2.y) + 0.5;
      _v2.multiplyScalar(6 + Math.random() * 11);
      this.smoke.emit(t + Math.random() * 0.8, 1.4 + Math.random() * 1.1,
        pos.x + (Math.random() - 0.5) * 18, pos.y + 2 + Math.random() * 5, pos.z + (Math.random() - 0.5) * 18,
        _v2.x, _v2.y, _v2.z,
        14, 0.3, 0.15 + Math.random() * 0.25, 0.1,
        0.32, 0.28, 0.24, 0.2, 0.17, 0.14,
        1, Math.random() * 6.28, (Math.random() - 0.5) * 20,
        TILE_CHUNK, MODE_BILLBOARD, 0);
    }

    const car = this.state ? this.state.car : null;
    if (car && car.position) {
      const dist = _v1.copy(pos).sub(car.position).length();
      const intensity = Math.min(1, 60 / (14 + dist)) * 0.7;
      if (intensity > 0.05) this.events.emit('camera:shake', { intensity, duration: 1.1 });
    }
  }

  _collapseDust(pos) {
    // bridge segment drop — grey dust burst + a few sparks
    const t = this._simTime;
    let n = (16 * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      _v2.set((Math.random() - 0.5) * 6, 1 + Math.random() * 3.5, (Math.random() - 0.5) * 6);
      this.smoke.emit(t + Math.random() * 0.3, 1.4 + Math.random() * 1.2,
        pos.x + (Math.random() - 0.5) * 5, pos.y + Math.random() * 2, pos.z + (Math.random() - 0.5) * 5,
        _v2.x, _v2.y, _v2.z,
        0.4, 1.2, 1.2, 6 + Math.random() * 4,
        0.45, 0.42, 0.4, 0.62, 0.6, 0.58,
        0.6, Math.random() * 6.28, (Math.random() - 0.5) * 1.6,
        TILE_BLOB, MODE_BILLBOARD, 0.8);
    }
  }

  // ------------------------------------------------------------------ landing

  _landingDust(p) {
    const car = this.state ? this.state.car : null;
    if (!car || !car.position) return;
    const impact = Math.max(3, (p && p.impactSpeed) || 8);
    const surf = car.surface || 'dirt';
    const col = DUST_COLORS[surf] || DUST_COLORS.dirt;
    const t = this._simTime;
    let n = (Math.min(30, 6 + impact * 1.2) * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      const a = Math.random() * 6.28318;
      const ca = Math.cos(a), sa = Math.sin(a);
      _v1.set(car.position.x + ca * 1.3, car.position.y - 0.5, car.position.z + sa * 1.3);
      const sp = 3 + impact * 0.25 + Math.random() * 2;
      _v2.set(ca * sp, 0.5 + Math.random() * 1.2, sa * sp);
      this.smoke.emit(t, 0.6 + Math.random() * 0.7,
        _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z,
        1.5, 2.4, 0.5, 2.2 + impact * 0.05,
        col[0], col[1], col[2], col[3], col[4], col[5],
        0.6, Math.random() * 6.28, (Math.random() - 0.5) * 2.5,
        TILE_BLOB, MODE_BILLBOARD, 0.4);
    }
  }

  // ------------------------------------------------------------------ finish celebration

  _finishCelebration() {
    const car = this.state ? this.state.car : null;
    if (!car || !car.position) return;
    const t = this._simTime;
    const lod = this._lod;
    const cx = car.position.x, cy = car.position.y, cz = car.position.z;

    // confetti storm raining in over 2.4 s
    let n = (300 * lod) | 0;
    for (let j = 0; j < n; j++) {
      const col = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      const a = Math.random() * 6.28318;
      const rr = 2 + Math.random() * 13;
      this.smoke.emit(t + Math.random() * 2.4, 4 + Math.random() * 2.5,
        cx + Math.cos(a) * rr, cy + 7 + Math.random() * 8, cz + Math.sin(a) * rr,
        (Math.random() - 0.5) * 2.5, -0.4 - Math.random(), (Math.random() - 0.5) * 2.5,
        1.3, 1.6, 0.14 + Math.random() * 0.08, 0.12,
        col[0], col[1], col[2], col[0] * 0.8, col[1] * 0.8, col[2] * 0.8,
        1, Math.random() * 6.28, (Math.random() - 0.5) * 18,
        TILE_CHUNK, MODE_BILLBOARD, 1.5);
    }

    // schedule fireworks bursts around the finish gate
    this._fwN = 0;
    const count = 9;
    for (let k = 0; k < count && k < 12; k++) {
      const o = this._fwN * 5;
      this._fw[o] = t + 0.4 + k * 0.55 + Math.random() * 0.3;
      this._fw[o + 1] = cx + (Math.random() - 0.5) * 85;
      this._fw[o + 2] = cy + 16 + Math.random() * 22;
      this._fw[o + 3] = cz + (Math.random() - 0.5) * 85;
      this._fw[o + 4] = (Math.random() * FW_COLORS.length) | 0;
      this._fwN++;
    }
  }

  _updateFireworks(t) {
    let i = 0;
    while (i < this._fwN) {
      const o = i * 5;
      if (this._fw[o] <= t) {
        this._fireworkBurst(this._fw[o + 1], this._fw[o + 2], this._fw[o + 3], this._fw[o + 4] | 0);
        const last = (this._fwN - 1) * 5;
        for (let k = 0; k < 5; k++) this._fw[o + k] = this._fw[last + k];
        this._fwN--;
      } else {
        i++;
      }
    }
  }

  _fireworkBurst(x, y, z, ci) {
    const t = this._simTime;
    const col = FW_COLORS[ci % FW_COLORS.length];

    // bloom flash
    this.glow.emit(t, 0.22,
      x, y, z, 0, 0, 0,
      0, 0, 3, 9,
      col[0] * 1.6, col[1] * 1.6, col[2] * 1.6, col[0] * 0.5, col[1] * 0.5, col[2] * 0.5,
      0.9, Math.random() * 6.28, 0, TILE_DOT, MODE_BILLBOARD, 0);

    // radial sparkler shell
    let n = (90 * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2).multiplyScalar(10 + Math.random() * 10);
      this.glow.emit(t, 1 + Math.random() * 0.9,
        x, y, z, _v2.x, _v2.y, _v2.z,
        3, 0.8, 0.2, 0.04,
        col[0] * 1.6, col[1] * 1.6, col[2] * 1.6, col[0] * 0.22, col[1] * 0.22, col[2] * 0.22,
        1, 0, 0, TILE_DOT, MODE_STRETCH, 3);
    }
    // lingering fall-away twinkles
    n = (26 * this._lod) | 0;
    for (let j = 0; j < n; j++) {
      randSphere(_v2).multiplyScalar(6 + Math.random() * 7);
      this.glow.emit(t + 0.4, 1.6 + Math.random() * 0.8,
        x, y, z, _v2.x, _v2.y, _v2.z,
        5, 1.2, 0.14, 0.02,
        1.6, 1.5, 1.2, col[0] * 0.4, col[1] * 0.4, col[2] * 0.4,
        0.9, 0, 0, TILE_DOT, MODE_BILLBOARD, 0);
    }
  }
}
