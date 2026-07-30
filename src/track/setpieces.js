// setpieces.js — progress-triggered cinematic state machines:
//   • ROCKSLIDE  (t≈0.32): boulders roll across the road as real moving colliders
//   • TUNNEL COLLAPSE (0.55–0.64): support portals crash down BEHIND the car
//   • COLLAPSING BRIDGE (0.80–0.93): 24 deck segments explode & drop chasing the player,
//     clamped so the collapse front can never overtake them (never unfair)
//   • FLAMING ARCH (t≈0.965): flame flicker + light
// All colliders that move are registered dynamic:true and have updateMatrixWorld() called
// every frame while active. Events emitted exactly per SPEC.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _axis = new THREE.Vector3();
const _evPos = new THREE.Vector3(); // staging vector; payloads get a clone (events are rare, safety beats reuse)

let seed = 777;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

// ---------------------------------------------------------------------------
// ROCKSLIDE
// ---------------------------------------------------------------------------

export class Rockslide {
  constructor(ctx, data, sampler) {
    this.ctx = ctx;
    this.data = data;
    this.sampler = sampler;
    this.group = new THREE.Group();
    this.boulders = [];
    this.armed = true;
    this.active = false;
    this.timer = 0;
    this.triggerT = data.markerT.rockslide + 0.006;
  }

  build() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x74402a, roughness: 0.95, flatShading: true });
    const N = 7;
    for (let i = 0; i < N; i++) {
      const r = 1.5 + rnd() * 1.3;
      const geo = new THREE.IcosahedronGeometry(r, 1);
      const pp = geo.attributes.position;
      for (let v = 0; v < pp.count; v++) {
        const f = 0.85 + rnd() * 0.3;
        pp.setXYZ(v, pp.getX(v) * f, pp.getY(v) * f, pp.getZ(v) * f);
      }
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      // spread the ambush along the pass, staggered start delays
      const t = this.triggerT + 0.004 + (i / N) * 0.035;
      this.group.add(mesh);
      this.boulders.push({
        mesh, r, t, delay: i * 0.55 + rnd() * 0.4,
        state: 0, // 0 idle, 1 rolling, 2 done
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        spin: new THREE.Quaternion(), spinAxis: new THREE.Vector3(), spinRate: 0,
        life: 0,
      });
      this.ctx.world.addCollider(mesh, { surface: 'rock', dynamic: true });
    }
    return this.group;
  }

  trigger() {
    if (this.active) return;
    this.active = true;
    this.timer = 0;
    const s = this.sampler.sample(this.triggerT + 0.01);
    _evPos.copy(s.position);
    this.ctx.events.emit('setpiece:rockslide', { position: _evPos.clone() });
    this.ctx.events.emit('ui:message', { text: 'ROCKSLIDE!', sub: 'DODGE THE BOULDERS', style: 'warn' });
    this.ctx.events.emit('camera:shake', { intensity: 0.55, duration: 1.6 });
  }

  update(dt, playerT) {
    if (this.armed && playerT > this.triggerT - 0.012) {
      this.armed = false;
      this.trigger();
    }
    if (!this.active) return;
    this.timer += dt;
    for (const b of this.boulders) {
      if (b.state === 0) {
        if (this.timer >= b.delay) {
          // spawn on the high wall side, aimed across the road
          const rec = this.sampler.sample(b.t);
          const side = rnd() < 0.5 ? -1 : 1;
          b.pos.copy(rec.position)
            .addScaledVector(rec.right, side * (rec.width * 0.5 + 16))
            .addScaledVector(rec.up, 13 + rnd() * 5);
          b.vel.copy(rec.right).multiplyScalar(-side * (11 + rnd() * 6));
          b.vel.y = 1.5;
          // slight downstream drift so they rake the road
          b.vel.addScaledVector(rec.tangent, 3 + rnd() * 4);
          b.spinAxis.copy(rec.tangent).normalize();
          b.spinRate = (b.vel.length() / b.r) * (side > 0 ? 1 : -1);
          b.mesh.position.copy(b.pos);
          b.mesh.visible = true;
          b.state = 1;
          b.life = 0;
          _evPos.copy(b.pos);
          this.ctx.events.emit('setpiece:rockslide', { position: _evPos.clone() });
        }
        continue;
      }
      if (b.state !== 1) continue;
      b.life += dt;
      // gravity + ground clamp against the road plane at its t
      b.vel.y -= 22 * dt; // heavier-than-life reads better
      b.pos.addScaledVector(b.vel, dt);
      const gT = this.sampler.progressAt(b.pos.x, b.pos.y, b.pos.z, b.t);
      const rec = this.sampler.sample(gT);
      const relX = (b.pos.x - rec.position.x) * rec.up.x
        + (b.pos.y - rec.position.y) * rec.up.y
        + (b.pos.z - rec.position.z) * rec.up.z;
      const latD = (b.pos.x - rec.position.x) * rec.right.x
        + (b.pos.y - rec.position.y) * rec.right.y
        + (b.pos.z - rec.position.z) * rec.right.z;
      if (relX < b.r && Math.abs(latD) < rec.width * 0.5 + 20) {
        // roll on the deck
        b.pos.addScaledVector(rec.up, b.r - relX);
        if (b.vel.y < 0) b.vel.y *= -0.15;
        b.vel.multiplyScalar(1 - 0.12 * dt);
      }
      _q.setFromAxisAngle(b.spinAxis, b.spinRate * dt);
      b.mesh.quaternion.premultiply(_q);
      b.mesh.position.copy(b.pos);
      b.mesh.updateMatrixWorld();
      if (b.life > 9 || Math.abs(latD) > rec.width * 0.5 + 26) {
        b.state = 2;
        b.mesh.visible = false;
        b.mesh.position.y -= 500; // park the collider far away
        b.mesh.updateMatrixWorld();
      }
    }
    if (this.timer > 16) this.active = false;
  }

  reset() {
    this.armed = true;
    this.active = false;
    this.timer = 0;
    for (const b of this.boulders) {
      b.state = 0;
      b.mesh.visible = false;
      b.mesh.position.set(0, -500, 0);
      b.mesh.updateMatrixWorld();
    }
  }
}

// ---------------------------------------------------------------------------
// TUNNEL COLLAPSE — supports drop behind the car (visual + shake + dust events)
// ---------------------------------------------------------------------------

export class TunnelCollapse {
  constructor(ctx, tunnel) {
    this.ctx = ctx;
    this.tunnel = tunnel; // { supports, supportInfo } from scenery
    this.announced = false;
  }

  update(dt, playerT) {
    const info = this.tunnel.supportInfo;
    let dirty = false;
    for (let i = 0; i < info.length; i++) {
      const s = info[i];
      if (!s.fallen) {
        if (playerT > s.t + 0.0035) { // car is safely past → drop it
          s.fallen = true;
          s.fallT = 0;
          if (!this.announced) {
            this.announced = true;
            this.ctx.events.emit('ui:message', { text: 'THE MINE IS COMING DOWN', sub: 'DO NOT STOP', style: 'warn' });
          }
          _evPos.copy(s.basePos);
          this.ctx.events.emit('setpiece:rockslide', { position: _evPos.clone() }); // dust + rumble reaction
          this.ctx.events.emit('camera:shake', { intensity: 0.3, duration: 0.5 });
        }
        continue;
      }
      if (s.fallT > 1.6) continue;
      s.fallT += dt;
      const k = Math.min(1, s.fallT / 1.4);
      const ease = k * k;
      // tilt backward around the base + sink
      _axis.copy(s.right);
      _q.setFromAxisAngle(_axis, ease * (0.9 + (i % 3) * 0.25));
      _q.premultiply(s.baseQuat);
      _p.copy(s.basePos).addScaledVector(s.up, -ease * 2.2);
      _m4.compose(_p, _q, _s.set(1, 1, 1));
      this.tunnel.supports.setMatrixAt(i, _m4);
      dirty = true;
    }
    if (dirty) this.tunnel.supports.instanceMatrix.needsUpdate = true;
  }

  reset() {
    this.announced = false;
    const info = this.tunnel.supportInfo;
    for (let i = 0; i < info.length; i++) {
      const s = info[i];
      s.fallen = false; s.fallT = 0;
      _m4.compose(s.basePos, s.baseQuat, _s.set(1, 1, 1));
      this.tunnel.supports.setMatrixAt(i, _m4);
    }
    this.tunnel.supports.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// COLLAPSING BRIDGE
// ---------------------------------------------------------------------------

export class CollapsingBridge {
  constructor(ctx, data, sampler) {
    this.ctx = ctx;
    this.data = data;
    this.sampler = sampler;
    this.group = new THREE.Group();
    this.segments = [];
    this.state = 0; // 0 armed, 1 collapsing, 2 spent
    this.frontT = 0;
    this.t0 = data.markerT.bridgeDeck;
    this.t1 = data.markerT.bridgeDeckEnd;
    this.triggerT = data.markerT.bridge + 0.5 * (this.t0 - data.markerT.bridge);
    this._explodeAcc = 0;
  }

  build() {
    const N_SEG = 24;
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6e5638, roughness: 0.85, vertexColors: false });
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x53271a, roughness: 0.45, metalness: 0.75 });
    for (let i = 0; i < N_SEG; i++) {
      const ta = this.t0 + (i / N_SEG) * (this.t1 - this.t0);
      const tb = this.t0 + ((i + 1) / N_SEG) * (this.t1 - this.t0);
      const tm = (ta + tb) / 2;
      const rec = this.sampler.sample(tm);
      const segLen = (tb - ta) * this.data.totalLen;
      const w = rec.width;

      const parts = [];
      const deck = new THREE.BoxGeometry(w, 0.7, segLen * 1.02);
      deck.translate(0, -0.36, 0);
      parts.push(deck);
      // side walls double as guard rails (move with the segment = no stale rail colliders)
      for (const sx of [-1, 1]) {
        const wall = new THREE.BoxGeometry(0.45, 1.9, segLen * 1.02);
        wall.translate(sx * (w * 0.5 + 0.28), 0.6, 0);
        parts.push(wall);
      }
      // under-truss X braces (visual drama when they fall)
      for (const sx of [-1, 1]) {
        const b1 = new THREE.BoxGeometry(0.3, 3.2, 0.3);
        b1.rotateX(0.7);
        b1.translate(sx * w * 0.4, -2.1, 0);
        parts.push(b1);
      }
      const geo = mergeGeometries(parts, false);
      const mesh = new THREE.Mesh(geo, i % 2 ? deckMat : trussMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      _q.setFromRotationMatrix(_m4.makeBasis(rec.right, rec.up, _axis.crossVectors(rec.right, rec.up)));
      mesh.position.copy(rec.position);
      mesh.quaternion.copy(_q);
      mesh.updateMatrixWorld();
      this.group.add(mesh);
      this.ctx.world.addCollider(mesh, { surface: 'wood', dynamic: true });

      this.segments.push({
        mesh, tMid: tm, index: i,
        basePos: rec.position.clone(), baseQuat: _q.clone(),
        right: rec.right.clone(),
        falling: false, fallT: 0, tiltDir: rnd() < 0.5 ? -1 : 1, gone: false,
      });
    }
    return this.group;
  }

  update(dt, playerT, playerSpeed) {
    if (this.state === 0) {
      if (playerT > this.triggerT) {
        this.state = 1;
        this.frontT = this.t0 - 0.004;
        this.ctx.events.emit('ui:message', { text: 'BRIDGE COLLAPSING — FLOOR IT!', style: 'warn' });
        this.ctx.events.emit('camera:shake', { intensity: 0.5, duration: 1.2 });
        const s = this.sampler.sample(this.t0);
        _evPos.copy(s.position);
        this.ctx.events.emit('setpiece:explosion', { position: _evPos.clone(), radius: 16 });
      }
      return;
    }
    if (this.state === 1) {
      // Collapse front chases at slightly-faster-than-cruise pace but is HARD-CLAMPED
      // to stay ≥ ~40 m behind the player. Tension without unfairness.
      const chaseRate = Math.max(38, playerSpeed * 1.12) / this.data.totalLen;
      this.frontT += chaseRate * dt;
      const safeGap = 40 / this.data.totalLen;
      if (playerT < this.t1 + 0.01) this.frontT = Math.min(this.frontT, playerT - safeGap);
      for (const seg of this.segments) {
        if (!seg.falling && this.frontT > seg.tMid) {
          seg.falling = true;
          seg.fallT = 0;
          _evPos.copy(seg.basePos);
          this.ctx.events.emit('setpiece:collapse', { position: _evPos.clone(), index: seg.index });
          if (seg.index % 3 === 0) {
            this.ctx.events.emit('setpiece:explosion', { position: _evPos.clone(), radius: 14 });
            this.ctx.events.emit('camera:shake', { intensity: 0.35, duration: 0.5 });
          }
        }
      }
      if (this.frontT > this.t1 + 0.01) this.state = 2;
    }
    // animate falling segments (physics-ish tween: accelerating drop + tilt + slight yaw)
    for (const seg of this.segments) {
      if (!seg.falling || seg.gone) continue;
      seg.fallT += dt;
      const k = seg.fallT;
      const drop = 12.1 * k * k; // pseudo-gravity (slightly floaty reads more cinematic)
      // pitch around the segment's right axis for a rolling shear-off
      _q.setFromAxisAngle(seg.right, Math.min(0.9, k * 0.55) * seg.tiltDir);
      _q.premultiply(seg.baseQuat);
      seg.mesh.quaternion.copy(_q);
      seg.mesh.position.copy(seg.basePos);
      seg.mesh.position.y -= drop;
      seg.mesh.updateMatrixWorld();
      if (drop > 34) {
        // deep enough that nobody can land on it — retire the collider cheaply
        seg.gone = true;
        seg.mesh.position.y = seg.basePos.y - 500;
        seg.mesh.visible = false;
        seg.mesh.updateMatrixWorld();
      }
    }
  }

  reset() {
    this.state = 0;
    this.frontT = 0;
    for (const seg of this.segments) {
      seg.falling = false; seg.fallT = 0; seg.gone = false;
      seg.mesh.visible = true;
      seg.mesh.position.copy(seg.basePos);
      seg.mesh.quaternion.copy(seg.baseQuat);
      seg.mesh.updateMatrixWorld();
    }
  }
}

// ---------------------------------------------------------------------------
// FLAMING ARCH — flicker animation (geometry built in scenery.buildFlamingArch)
// ---------------------------------------------------------------------------

export class FlamingArch {
  constructor(ctx, arch) {
    this.ctx = ctx;
    this.arch = arch;
    this.announced = false;
  }

  update(dt, time, playerT) {
    const { flames, flameBase, light } = this.arch;
    for (let i = 0; i < flameBase.length; i++) {
      const fl = 1 + 0.45 * Math.sin(time * 17 + i * 2.3) * Math.sin(time * 9.7 + i);
      _p.copy(flameBase[i]);
      _q.setFromAxisAngle(_axis.set(0, 1, 0), Math.sin(time * 11 + i) * 0.2);
      _s.set(1.1, fl * 1.6, 1.1);
      _m4.compose(_p, _q, _s);
      flames.setMatrixAt(i, _m4);
    }
    flames.instanceMatrix.needsUpdate = true;
    light.intensity = 110 + Math.sin(time * 23) * 30 + Math.sin(time * 7.3) * 20;
    if (!this.announced && playerT > this.arch.archT - 0.012) {
      this.announced = true;
      this.ctx.events.emit('ui:message', { text: 'THROUGH THE FIRE!', style: 'epic' });
    }
  }

  reset() { this.announced = false; }
}
