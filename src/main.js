import * as THREE from 'three';
import { EventBus } from './core/events.js';
import { createState } from './core/state.js';
import { InputManager } from './core/input.js';
import { CollisionWorld } from './core/world.js';
import { RenderingSystem } from './rendering/RenderingSystem.js';
import { TrackSystem } from './track/TrackSystem.js';
import { VehiclePhysics } from './physics/VehiclePhysics.js';
import { CarVisuals } from './car/CarVisuals.js';
import { AISystem } from './ai/AISystem.js';
import { VFXSystem } from './vfx/VFXSystem.js';
import { WeatherSystem } from './weather/WeatherSystem.js';
import { CameraSystem } from './camera/CameraSystem.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { UISystem } from './ui/UISystem.js';

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 1 / 20;

class Game {
  constructor() {
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // post-process AA in RenderingSystem
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 4000);

    this.events = new EventBus();
    this.state = createState();
    this.input = new InputManager();
    this.world = new CollisionWorld();

    this.ctx = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      events: this.events,
      state: this.state,
      input: this.input,
      world: this.world,
      track: null,
    };

    window.__APEX_STATE__ = this.state; // QA/debug hook
    window.__APEX_GAME__ = this;
    this.perf = {}; // rolling per-system ms, QA-readable via __APEX_GAME__.perf

    this._accumulator = 0;
    this._lastTime = performance.now();
    this._elapsed = 0;
    this._slowmo = null; // {scale, until, recover}
    this._finishHandled = false;
  }

  async init() {
    const loadFill = document.getElementById('load-fill');
    const loadLabel = document.getElementById('load-label');
    const steps = [
      ['RENDER CORE', async () => { this.rendering = new RenderingSystem(this.ctx); await this.rendering.init(); }],
      ['CARVING THE CANYON', async () => { this.track = new TrackSystem(this.ctx); await this.track.init(); this.ctx.track = this.track; }],
      ['VEHICLE DYNAMICS', async () => { this.physics = new VehiclePhysics(this.ctx); await this.physics.init(); }],
      ['PAINT & CHROME', async () => { this.carVisuals = new CarVisuals(this.ctx); await this.carVisuals.init(); }],
      ['RIVAL DRIVERS', async () => { this.ai = new AISystem(this.ctx); await this.ai.init(); }],
      ['PYROTECHNICS', async () => { this.vfx = new VFXSystem(this.ctx); await this.vfx.init(); }],
      ['STORM FRONT', async () => { this.weather = new WeatherSystem(this.ctx); await this.weather.init(); }],
      ['CAMERA RIGS', async () => { this.cameraSys = new CameraSystem(this.ctx); await this.cameraSys.init(); }],
      ['SOUND STAGE', async () => { this.audio = new AudioSystem(this.ctx); await this.audio.init(); }],
      ['RACE CONTROL', async () => { this.ui = new UISystem(this.ctx); await this.ui.init(); }],
    ];
    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      loadLabel.textContent = label;
      this.events.emit('load:progress', { label, ratio: i / steps.length });
      await new Promise((r) => requestAnimationFrame(r)); // let the loading bar paint
      await fn();
      loadFill.style.width = `${(((i + 1) / steps.length) * 100).toFixed(0)}%`;
    }

    this._wireEvents();
    this._placeCarsOnGrid();
    this.state.phase = 'menu';
    document.getElementById('loading').classList.add('done');

    this._lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _wireEvents() {
    this.events.on('time:slowmo', ({ scale, duration }) => {
      this._slowmo = { scale: Math.max(0.05, scale), until: this._elapsed + duration };
    });
    this.events.on('race:finish', () => {
      if (this._finishHandled) return;
      this._finishHandled = true;
      this.state.phase = 'finished';
      this.events.emit('time:slowmo', { scale: 0.35, duration: 2.2 });
    });
    addEventListener('visibilitychange', () => {
      if (document.hidden) this._lastTime = performance.now();
    });
  }

  _placeCarsOnGrid() {
    const spawn = this.track.getSpawn(3); // player at back of grid
    this.physics.respawn(spawn.position, spawn.quaternion);
  }

  _startCountdown() {
    this.state.phase = 'countdown';
    this.state.countdown = 3;
    this._countdownLast = 4;
  }

  _restart() {
    this.state.raceTime = 0;
    this.state.progress = 0;
    this.state.checkpoint = 0;
    this.state.racePosition = 4;
    this.state.wrongWay = false;
    this.state.timeScale = 1;
    this.state.stats.topSpeedKmh = 0;
    this.state.stats.driftScore = 0;
    this.state.stats.airTime = 0;
    this.state.stats.propsBroken = 0;
    this._slowmo = null;
    this._finishHandled = false;
    this._placeCarsOnGrid();
    this.events.emit('race:restart', {});
    this._startCountdown();
  }

  _frame() {
    const now = performance.now();
    let rawDt = Math.min(MAX_FRAME_DT, (now - this._lastTime) / 1000);
    this._lastTime = now;
    this._elapsed += rawDt;

    // Slow-mo envelope: ease back to 1 after expiry.
    const st = this.state;
    if (this._slowmo) {
      if (this._elapsed < this._slowmo.until) {
        st.timeScale += (this._slowmo.scale - st.timeScale) * Math.min(1, 10 * rawDt);
      } else {
        st.timeScale += (1 - st.timeScale) * Math.min(1, 3 * rawDt);
        if (st.timeScale > 0.995) { st.timeScale = 1; this._slowmo = null; }
      }
    }
    const dt = rawDt * st.timeScale;

    this.input.update(rawDt);

    // --- Phase logic ---
    if (st.phase === 'menu' && this.input.pressed('start')) {
      this.audio.unlock?.();
      this._startCountdown();
    } else if (st.phase === 'countdown') {
      st.countdown -= rawDt;
      const n = Math.max(0, Math.ceil(st.countdown));
      if (n !== this._countdownLast) {
        this._countdownLast = n;
        this.events.emit('race:countdown', { n });
        if (n === 0) {
          st.phase = 'racing';
          this.events.emit('race:start', {});
        }
      }
    } else if (st.phase === 'racing') {
      st.raceTime += dt;
      if (this.input.pressed('respawn')) this._respawnToCheckpoint();
    } else if (st.phase === 'finished') {
      if (this.input.pressed('respawn') || this.input.pressed('start')) this._restart();
    }
    if (this.input.pressed('camera')) {
      st.settings.cameraMode = (st.settings.cameraMode + 1) % 3;
    }
    if (this.input.pressed('mute')) {
      st.settings.mute = !st.settings.mute;
    }

    // --- Fixed-step simulation ---
    const simActive = st.phase === 'racing' || st.phase === 'finished' || st.phase === 'countdown';
    if (simActive) {
      this._accumulator = Math.min(this._accumulator + dt, FIXED_DT * 10);
      this._timed('fixedStep', () => {
        while (this._accumulator >= FIXED_DT) {
          this.physics.fixedUpdate(FIXED_DT);
          this.ai.fixedUpdate(FIXED_DT);
          this._accumulator -= FIXED_DT;
        }
      });
    }

    // Kill plane: fell off the world → respawn.
    if (st.phase === 'racing') {
      const roadY = this.track.sample(st.progress).position.y;
      if (st.car.position.y < roadY - 60) this._respawnToCheckpoint();
      if (st.car.speedKmh > st.stats.topSpeedKmh) st.stats.topSpeedKmh = st.car.speedKmh;
    }

    // --- Per-frame systems ---
    this._timed('track', () => this.track.update(dt, this._elapsed));
    this._timed('weather', () => this.weather.update(dt, this._elapsed));
    this._timed('vfx', () => this.vfx.update(dt, this._elapsed));
    this._timed('carVisuals', () => this.carVisuals.update(dt, this._elapsed));
    this._timed('ai', () => this.ai.update(dt, this._elapsed));
    this._timed('camera', () => this.cameraSys.update(dt, this._elapsed));
    this._timed('audio', () => this.audio.update(dt, this._elapsed));
    this._timed('ui', () => this.ui.update(dt, this._elapsed));
    this._timed('render', () => this.rendering.render(dt, this._elapsed));
    this.perf.frame = (this.perf.frame ?? rawDt * 1000) * 0.95 + rawDt * 1000 * 0.05;
  }

  _timed(name, fn) {
    const a = performance.now();
    fn();
    const d = performance.now() - a;
    this.perf[name] = (this.perf[name] ?? d) * 0.95 + d * 0.05;
  }

  _respawnToCheckpoint() {
    const cp = this.track.checkpoints[Math.max(0, this.state.checkpoint - 1)];
    const t = cp ? cp.t : 0;
    const s = this.track.sample(Math.max(0.001, t));
    const pos = s.position.clone().addScaledVector(s.up, 1.2);
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(s.right, s.up, s.tangent.clone().negate())
    );
    this.physics.respawn(pos, quat);
    this.events.emit('car:respawn', {});
  }
}

const game = new Game();
game.init().catch((err) => {
  console.error('[APEX] fatal init error', err);
  const el = document.getElementById('fatal');
  el.style.display = 'flex';
  el.textContent = `FATAL: ${err.message}\n\n${err.stack}`;
});
