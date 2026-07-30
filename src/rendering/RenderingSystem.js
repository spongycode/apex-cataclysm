// RenderingSystem — owns the LOOK. Renderer config, procedural sky + PMREM environment,
// sun/hemisphere/fog slaved to state.weather, HDR bloom + one cinematic grade pass + FXAA,
// texel-snapped car-following shadows, adaptive quality with hysteresis, resize.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { SkyDome, computeSkyPalette } from './SkyDome.js';
import { CinematicShader } from './CinematicShader.js';

// Quality tiers (pixelRatio is additionally capped by devicePixelRatio).
const TIERS = [
  { name: 'high', pr: 2.0, bloomScale: 1.0, shadow: 2048 },
  { name: 'medium', pr: 1.5, bloomScale: 0.5, shadow: 2048 },
  { name: 'low', pr: 1.25, bloomScale: 0.5, shadow: 1024 },
];

const SHADOW_HALF = 65; // ~130 m ortho shadow frustum
const SUN_DIST = 200;

// Module-level scratch — zero per-frame allocation.
const _sunDir = new THREE.Vector3();
const _sunRight = new THREE.Vector3();
const _sunUp = new THREE.Vector3();
const _snapTarget = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fogCol = new THREE.Color();

export class RenderingSystem {
  constructor(ctx) {
    this.ctx = ctx;

    // Cheap state only — all scene work happens in init().
    this._tier = 0;
    this._lastTierChange = -10;
    this._goodTime = 0;
    this._perfBuf = new Float32Array(60);
    this._perfIdx = 0;
    this._perfSum = 0;
    this._perfCount = 0;
    this._perfLast = -1;

    this._storm = 0; // smoothed rain → storm factor
    this._blur = 0;
    this._boostAmt = 0;
    this._chromaPulse = 0;

    this._pal = {
      zenith: new THREE.Color(),
      mid: new THREE.Color(),
      horizon: new THREE.Color(),
      sun: new THREE.Color(),
      halo: new THREE.Color(),
    };
    this._bakeSnap = { sunset: -1, storm: -1, fog: -1, time: -1e9 };
    this._envRT = null;
    this._onResize = null;
  }

  async init() {
    const { renderer, scene, camera, events } = this.ctx;

    // --- Renderer core ---
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // --- Sky ---
    this.sky = new SkyDome();
    scene.add(this.sky.mesh);

    // --- Sun + fill + fog ---
    this.sun = new THREE.DirectionalLight(0xfff2cf, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(TIERS[0].shadow, TIERS[0].shadow);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_HALF;
    sc.right = SHADOW_HALF;
    sc.top = SHADOW_HALF;
    sc.bottom = -SHADOW_HALF;
    sc.near = 5;
    sc.far = 460;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00022;
    this.sun.shadow.normalBias = 0.55;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x86b4ea, 0x8a5c3a, 0.5);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xffd9a6, 0.001);

    // --- PMREM environment baked from the sky ---
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileCubemapShader();
    this._bakeEnvironment(0);
    scene.environmentIntensity = 0.9;

    // --- Post chain: Render → Bloom (HDR) → Output (ACES+sRGB) → Cinematic → FXAA ---
    this.composer = new EffectComposer(renderer);
    this._renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this._renderPass);

    this._bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.4, 0.85
    );
    this.composer.addPass(this._bloom);

    this.composer.addPass(new OutputPass());

    this._cine = new ShaderPass(CinematicShader);
    this.composer.addPass(this._cine);

    this._fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this._fxaa);

    // --- Impact / boost chroma pulses ---
    events.on('car:collision', (e) => {
      const s = Math.min(1, ((e && e.speed) || 10) / 40);
      this._chromaPulse = Math.min(0.010, this._chromaPulse + 0.002 + 0.005 * s);
    });
    events.on('car:landed', (e) => {
      const s = Math.min(1, ((e && e.impactSpeed) || 5) / 25);
      this._chromaPulse = Math.min(0.008, this._chromaPulse + 0.0012 + 0.003 * s);
    });
    events.on('boost:start', () => {
      this._chromaPulse = Math.min(0.009, this._chromaPulse + 0.0035);
    });

    // --- Resize ---
    this._onResize = () => this._applySize();
    addEventListener('resize', this._onResize);
    this._applySize();

    console.info('[Rendering] init — ACES / PCFSoft / HDR bloom / cinematic pass / FXAA, quality:', TIERS[this._tier].name);
  }

  /** Lifecycle-contract alias; main.js calls render() directly. */
  update(dt, time) {
    this.render(dt, time);
  }

  render(dt, time = 0) {
    if (!this.composer) return;
    const st = this.ctx.state;
    const w = st && st.weather;
    const car = st && st.car;
    const cam = this.ctx.camera;

    // --- Real (unscaled) frame-time sample for adaptive quality ---
    const nowMs = performance.now();
    if (this._perfLast >= 0) {
      const ms = nowMs - this._perfLast;
      if (ms < 250) this._perfSample(ms, time);
    }
    this._perfLast = nowMs;

    if (!w || !car) {
      this.composer.render();
      return;
    }

    // --- Weather-driven look ---
    const rain = w.rain || 0;
    const sunset = w.sunset || 0;
    const stormTarget = Math.min(1, rain * 1.15);
    this._storm += (stormTarget - this._storm) * Math.min(1, 2.5 * dt);
    const storm = this._storm;

    computeSkyPalette(sunset, storm, this._pal);

    // Sun direction: rakes lower and swings as the race heads into the sunset.
    const el = THREE.MathUtils.lerp(0.58, 0.14, sunset) - 0.06 * storm;
    const az = -0.6 + sunset * 1.0;
    _sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

    // Sky uniforms (shared by dome + PMREM bake mesh).
    const su = this.sky.material.uniforms;
    su.uSunDir.value.copy(_sunDir);
    su.uZenith.value.copy(this._pal.zenith);
    su.uMid.value.copy(this._pal.mid);
    su.uHorizon.value.copy(this._pal.horizon);
    su.uSunColor.value.copy(this._pal.sun);
    su.uHaloColor.value.copy(this._pal.halo);
    su.uSunset.value = sunset;
    su.uStorm.value = storm;
    su.uTime.value = time;
    su.uLightning.value = w.lightning || 0;
    su.uWind.value.set(w.windX || 0, w.windZ || 0);
    this.sky.mesh.position.copy(cam.position);

    // Sun light: color from palette, dimmed under storm, spiked by lightning.
    this.sun.color.copy(this._pal.sun).lerp(this._pal.halo, 0.3 * sunset);
    this.sun.intensity =
      (2.6 - 0.4 * sunset) * (1 - 0.78 * storm) + (w.lightning || 0) * 2.2;
    this._updateShadowFrustum(car);

    // Hemisphere fill: cool sky bounce vs warm ground bounce; flatter under storm.
    this.hemi.color.copy(this._pal.mid);
    this.hemi.groundColor.copy(this._pal.horizon).multiplyScalar(0.45);
    this.hemi.intensity = 0.5 + 0.3 * storm - 0.12 * sunset;

    // Fog: color LOCKED to sky horizon; density from artistic fog scalar + storm.
    const fogN = THREE.MathUtils.clamp(w.fog || 0, 0, 1);
    const scene = this.ctx.scene;
    scene.fog.color.copy(_fogCol.copy(this._pal.horizon));
    scene.fog.density = 0.00028 + Math.pow(fogN, 1.5) * 0.0034 + storm * 0.0006;
    scene.environmentIntensity = 0.9 * (1 - 0.3 * storm);

    // PMREM re-bake on meaningful weather delta, throttled to >= 2 s.
    const bs = this._bakeSnap;
    if (time - bs.time >= 2) {
      const delta =
        Math.abs(sunset - bs.sunset) +
        Math.abs(storm - bs.storm) +
        Math.abs(fogN - bs.fog) * 0.5;
      if (delta > 0.04) this._bakeEnvironment(time);
    }

    // --- Cinematic pass uniforms ---
    const kmh = car.speedKmh || 0;
    const sp = THREE.MathUtils.clamp((kmh - 120) / 140, 0, 1);
    const boosting = !!car.boosting;
    let blurTarget = Math.pow(sp, 1.4) * 0.55 + (boosting ? 0.30 : 0);
    if (st.phase !== 'racing' && st.phase !== 'finished') blurTarget = 0;
    blurTarget = Math.min(blurTarget, 0.9);
    this._blur += (blurTarget - this._blur) * Math.min(1, 8 * dt);
    this._boostAmt += ((boosting ? 1 : 0) - this._boostAmt) * Math.min(1, 6 * dt);
    this._chromaPulse *= Math.exp(-5 * dt);

    const cu = this._cine.uniforms;
    cu.uTime.value = time;
    cu.uBlur.value = this._blur;
    cu.uChroma.value = 0.0009 * sp + 0.0016 * this._boostAmt + this._chromaPulse;
    cu.uBoost.value = this._boostAmt;
    cu.uLightning.value = w.lightning || 0;
    cu.uWet.value = Math.max(w.wetness || 0, rain * 0.85);

    this.composer.render();
  }

  // -------------------------------------------------------------------------

  /** Snap the ~130 m shadow ortho frustum to shadow-map texels, following the car. */
  _updateShadowFrustum(car) {
    const p = car.position;
    if (!p) return;
    _sunRight.crossVectors(_up, _sunDir).normalize();
    _sunUp.crossVectors(_sunDir, _sunRight); // orthonormal by construction
    const texel = (SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    let px = p.dot(_sunRight);
    let py = p.dot(_sunUp);
    const pz = p.dot(_sunDir);
    px = Math.floor(px / texel) * texel;
    py = Math.floor(py / texel) * texel;
    _snapTarget
      .copy(_sunRight).multiplyScalar(px)
      .addScaledVector(_sunUp, py)
      .addScaledVector(_sunDir, pz);
    this.sun.target.position.copy(_snapTarget);
    this.sun.position.copy(_snapTarget).addScaledVector(_sunDir, SUN_DIST);
    this.sun.target.updateMatrixWorld();
  }

  _bakeEnvironment(time) {
    const rt = this._pmrem.fromScene(this.sky.bakeScene, 0.25, 0.5, 300);
    this.ctx.scene.environment = rt.texture;
    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
    const w = this.ctx.state.weather;
    this._bakeSnap.sunset = (w && w.sunset) || 0;
    this._bakeSnap.storm = this._storm;
    this._bakeSnap.fog = (w && w.fog) || 0;
    this._bakeSnap.time = time;
  }

  // --- Adaptive quality: 60-frame rolling avg, drop >19 ms, raise after 5 s <12 ms ---
  _perfSample(ms, time) {
    // QA hook: lock a tier so screenshots are judged at known fidelity
    // (headless Chrome caps rAF at ~30 fps, which would fake a slow GPU).
    if (typeof window !== 'undefined' && window.__APEX_LOCK_QUALITY__) {
      const want = TIERS.findIndex((t) => t.name === window.__APEX_LOCK_QUALITY__);
      if (want >= 0 && want !== this._tier) this._setTier(want, time, 0);
      return;
    }
    this._perfSum += ms - this._perfBuf[this._perfIdx];
    this._perfBuf[this._perfIdx] = ms;
    this._perfIdx = (this._perfIdx + 1) % 60;
    if (this._perfCount < 60) {
      this._perfCount++;
      return;
    }
    const avg = this._perfSum / 60;
    const cooled = time - this._lastTierChange > 2.5;

    if (avg > 19 && this._tier < TIERS.length - 1 && cooled) {
      this._setTier(this._tier + 1, time, avg);
    } else if (avg < 12) {
      this._goodTime += ms / 1000;
      if (this._goodTime > 5 && this._tier > 0 && cooled) {
        this._setTier(this._tier - 1, time, avg);
      }
    } else {
      this._goodTime = 0;
    }
  }

  _setTier(i, time, avg) {
    this._tier = i;
    this._lastTierChange = time;
    this._goodTime = 0;
    this._perfSum = 0;
    this._perfBuf.fill(0);
    this._perfIdx = 0;
    this._perfCount = 0;
    const tier = TIERS[i];
    this.ctx.state.settings.quality = tier.name;

    // Shadow map resolution (recreated lazily by the renderer after dispose).
    if (this.sun.shadow.mapSize.x !== tier.shadow) {
      this.sun.shadow.mapSize.set(tier.shadow, tier.shadow);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this._applySize();
    console.info(`[Rendering] quality → ${tier.name} (avg ${avg.toFixed(1)} ms)`);
  }

  _applySize() {
    const { renderer, camera } = this.ctx;
    const w = innerWidth;
    const h = innerHeight;
    const tier = TIERS[this._tier];
    const pr = Math.min(devicePixelRatio || 1, tier.pr);

    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // Bloom resolution scaled below composer size on lower tiers.
    this._bloom.setSize(
      Math.max(2, Math.round(w * pr * tier.bloomScale)),
      Math.max(2, Math.round(h * pr * tier.bloomScale))
    );
    this._fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    this._cine.uniforms.uAspect.value = w / h;
  }
}
