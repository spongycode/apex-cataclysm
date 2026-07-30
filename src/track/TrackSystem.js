// TrackSystem — SPEC section 1. Builds the entire world of APEX: CATACLYSM CANYON:
// ~8 km centerline spline (with the 360° loop IN it), 3072 rotation-minimizing frames with
// authored banking, road ribbon + terrain + rails + tunnel + bridge + scenery, thousands of
// instanced props, and the progress-triggered set pieces. Registers every drivable/hittable
// surface as a collider. Writes state.progress / state.checkpoint / state.wrongWay.
//
// Public contract (SPEC):
//   spline            THREE.CatmullRomCurve3 centerline
//   checkpoints       [{position:Vector3, t}] ×12, last = finish gate
//   sample(t)         → {position, tangent, up, right, width, surface}   (pooled record —
//                       copy the vectors out if you must hold them across calls)
//   progressAt(pos)   Vector3 → nearest t (spatial-hash grid + local segment refinement)
//   getSpawn(slot)    0..3 → {position, quaternion}  (4-wide staggered grid at t≈0.004)
//   update(dt, time)
import * as THREE from 'three';
import { buildTrackData, TrackSampler } from './spline.js';
import { buildMaterials } from './materials.js';
import { computeGaps, buildRoad, buildChevrons, buildRails, buildTerrain, buildWater } from './geometry.js';
import { buildVegetation, buildTunnel, buildLoopScaffold, buildGates, buildFlamingArch, buildBillboards } from './scenery.js';
import { Breakables } from './props.js';
import { Rockslide, TunnelCollapse, CollapsingBridge, FlamingArch } from './setpieces.js';

const _v = new THREE.Vector3();

export class TrackSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.spline = null;
    this.checkpoints = [];
    this._data = null;
    this._sampler = null;
    this._playerT = 0.004; // cached hint for progressAt
    this._wrongWayTimer = 0;
    this._jumpAnnounced = false;
    this._loopAnnounced = false;
    this._finished = false;
    this._spawns = [];
  }

  async init() {
    const ctx = this.ctx;
    const data = this._data = buildTrackData();
    const S = this._sampler = new TrackSampler(data);
    this.spline = data.curve;

    const materials = buildMaterials();
    const gaps = computeGaps(data);
    const root = this._root = new THREE.Group();
    root.name = 'track_root';

    // --- terrain first (scenery drops onto it) ---
    const { mesh: terrain } = buildTerrain(data, S, materials, gaps);
    terrain.geometry.computeBoundsTree(); // needed for scenery placement raycasts at init
    root.add(terrain);
    ctx.world.addCollider(terrain, { surface: 'sand', dynamic: false });

    // --- road ribbon (per-surface merged meshes; gaps skipped) ---
    for (const { mesh, surface } of buildRoad(data, S, materials, gaps)) {
      root.add(mesh);
      ctx.world.addCollider(mesh, { surface, dynamic: false });
    }
    const chevrons = buildChevrons(data, materials, gaps);
    if (chevrons) root.add(chevrons);

    // --- guard rails: invisible tall colliders + visible W-beam (NONE across jump gaps) ---
    const rails = buildRails(data, materials, gaps);
    root.add(rails.collider, rails.visible);
    ctx.world.addCollider(rails.collider, { surface: 'metal', dynamic: false });

    // --- water (visual) ---
    root.add(buildWater(data, S, materials));

    // --- scenery ---
    const veg = buildVegetation(data, S, terrain);
    root.add(veg.group);
    const tunnel = this._tunnel = buildTunnel(data, S);
    root.add(tunnel.tube, tunnel.bulbs, tunnel.wire, tunnel.supports);
    ctx.world.addCollider(tunnel.tube, { surface: 'rock', dynamic: false });
    root.add(buildLoopScaffold(data, S));
    root.add(buildBillboards(data, S, materials, terrain));

    // --- checkpoints (12; last = finish gate) ---
    const m = data.markerT;
    const cpTs = [
      0.055, m.canyon + 0.01, m.jump - 0.008,
      m.gapEnd + 0.006,            // landing plateau — respawn past the gap, never into it
      m.rockslide + 0.02, m.forest + 0.02, m.tunnel + 0.008,
      data.loopT1 + 0.012,         // loop exit straight
      (m.fordStart + m.fordEnd) / 2 + 0.008,
      m.bridge + 0.006,            // bridge approach (respawn BEFORE the trigger re-runs safely)
      m.bridgeDeckEnd + 0.012,
      m.finishGate,
    ];
    this.checkpoints = cpTs.map((t) => ({ t, position: S.sample(t).position.clone() }));
    const gates = buildGates(data, S, this.checkpoints);
    root.add(gates.group);
    this._gateGlowMat = gates.glowMat;
    this._finGlowMat = gates.finGlowMat;

    // --- flaming arch ---
    const arch = buildFlamingArch(data, S);
    root.add(arch.group);

    // --- breakables ---
    this._breakables = new Breakables(data, S, ctx.events, ctx.state);
    root.add(this._breakables.build());

    // --- set pieces ---
    this._rockslide = new Rockslide(ctx, data, S);
    root.add(this._rockslide.build());
    this._tunnelCollapse = new TunnelCollapse(ctx, tunnel);
    this._bridge = new CollapsingBridge(ctx, data, S);
    root.add(this._bridge.build());
    this._arch = new FlamingArch(ctx, arch);

    // --- spawn grid: 4-wide staggered at t≈0.004, slot 3 (player) at the back ---
    for (let slot = 0; slot < 4; slot++) {
      const lat = [-4.9, -1.65, 1.65, 4.9][slot];
      const back = 4 + slot * 3.0; // meters behind the line marker
      const t = 0.004 - back / data.totalLen + (slot % 2) * (1.4 / data.totalLen);
      const rec = S.sample(Math.max(0.0005, t));
      const position = rec.position.clone()
        .addScaledVector(rec.right, lat)
        .addScaledVector(rec.up, 0.8);
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(rec.right.clone(), rec.up.clone(), rec.tangent.clone().negate()),
      );
      this._spawns.push({ position, quaternion });
    }

    ctx.scene.add(root);

    // restart / respawn hooks
    ctx.events.on('race:restart', () => this._reset());
    ctx.events.on('car:respawn', () => {
      // re-seed the progress hint from the actual car position (cold global search)
      const c = ctx.state.car;
      this._playerT = this._sampler.progressAt(c.position.x, c.position.y, c.position.z, -1);
      this._wrongWayTimer = 0;
      ctx.state.wrongWay = false;
    });
  }

  // ------------------------------------------------------------------ API

  sample(t, out) { return this._sampler.sample(t, out); }

  progressAt(pos) { return this._sampler.progressAt(pos.x, pos.y, pos.z, -1); }

  getSpawn(slot) {
    const s = this._spawns[THREE.MathUtils.clamp(slot | 0, 0, 3)];
    return { position: s.position.clone(), quaternion: s.quaternion.clone() };
  }

  // ------------------------------------------------------------------ update

  update(dt, time) {
    const st = this.ctx.state;
    const car = st.car;
    if (!car || !car.position) return; // defensive: physics not alive yet

    // --- player progress (hint-cached local search; falls back to global if lost) ---
    const t = this._sampler.progressAt(car.position.x, car.position.y, car.position.z, this._playerT);
    this._playerT = t;
    st.progress = t;

    const racing = st.phase === 'racing';
    const speed = car.velocity ? car.velocity.length() : 0;

    // --- checkpoints + finish ---
    if (racing && st.checkpoint < this.checkpoints.length) {
      const next = this.checkpoints[st.checkpoint];
      if (t >= next.t && t < next.t + 0.03) {
        st.checkpoint++;
        this.ctx.events.emit('race:checkpoint', { index: st.checkpoint, total: st.checkpointTotal });
        if (st.checkpoint >= this.checkpoints.length && !this._finished) {
          this._finished = true;
          this.ctx.events.emit('race:finish', { time: st.raceTime, stats: st.stats });
        }
      }
    }

    // --- wrong way (sustained driving against the tangent) ---
    if (racing && car.velocity) {
      const rec = this._sampler.sample(t);
      const dot = car.velocity.x * rec.tangent.x + car.velocity.y * rec.tangent.y + car.velocity.z * rec.tangent.z;
      if (dot < -3 && speed > 5) this._wrongWayTimer += dt;
      else this._wrongWayTimer = Math.max(0, this._wrongWayTimer - dt * 2);
      st.wrongWay = this._wrongWayTimer > 0.8;
    } else {
      st.wrongWay = false;
    }

    // --- one-shot callouts ---
    const md = this._data.markerT;
    if (racing && !this._jumpAnnounced && t > md.jump + 0.004) {
      this._jumpAnnounced = true;
      this.ctx.events.emit('ui:message', { text: 'THE BIG JUMP', sub: 'SEND IT FLAT OUT', style: 'epic' });
    }
    if (racing && !this._loopAnnounced && t > md.loop + 0.002) {
      this._loopAnnounced = true;
      this.ctx.events.emit('ui:message', { text: 'THE LOOP', sub: 'DO NOT LIFT', style: 'epic' });
    }

    // --- breakables vs car ---
    if (racing) this._breakables.check(car.position, speed);

    // --- set pieces (always animate; triggers only progress-gated) ---
    if (racing || st.phase === 'finished') {
      this._rockslide.update(dt, t);
      this._tunnelCollapse.update(dt, t);
      this._bridge.update(dt, t, speed);
    }
    this._arch.update(dt, time, t);

    // --- ambient animation: gate glow pulse + tunnel bulb shimmer ---
    if (this._gateGlowMat) this._gateGlowMat.emissiveIntensity = 2.2 + Math.sin(time * 3.1) * 0.7;
    if (this._finGlowMat) this._finGlowMat.emissiveIntensity = 3.0 + Math.sin(time * 5.3) * 1.2;
    if (this._tunnel) this._tunnel.bulbMat.emissiveIntensity = 3.0 + Math.sin(time * 13.7) * 0.5 + Math.sin(time * 41) * 0.25;
  }

  // ------------------------------------------------------------------

  _reset() {
    this._playerT = 0.004;
    this._wrongWayTimer = 0;
    this._jumpAnnounced = false;
    this._loopAnnounced = false;
    this._finished = false;
    this._breakables.reset();
    this._rockslide.reset();
    this._tunnelCollapse.reset();
    this._bridge.reset();
    this._arch.reset();
  }
}
