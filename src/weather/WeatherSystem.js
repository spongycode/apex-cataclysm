// WeatherSystem — authored weather timeline keyed to state.progress (NOT wall time),
// plus a GPU rain volume that follows the camera.
//
// Color script: golden clear (0–0.35) → storm builds (0.35–0.5) → full rain +
// lightning through forest/tunnel/loop (0.5–0.75, strikes every 4–9 s emitting
// weather:lightning + a delayed audio:sfx thunder) → breaking up (0.75–0.85) →
// clear blazing sunset (0.85–1, sunset→1).
//
// Writes every state.weather field each frame: rain, wetness, fog, lightning,
// sunset, windX, windZ. All values move with rates — never snap (except on
// race:restart, where an instant re-sync is correct).
//
// Rain: instanced streaked quads simulated entirely in the vertex shader inside a
// world-wrapped box ahead of the camera, wind-sheared, recycled by mod(). Hidden
// while inside the mine tunnel (progress 0.55–0.64).

import * as THREE from 'three';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const RAIN_COUNT = 5000;

// piecewise-linear curves as flat [p0,v0, p1,v1, ...] arrays
const RAIN_K = [0, 0, 0.35, 0, 0.42, 0.3, 0.5, 0.8, 0.55, 1, 0.72, 1, 0.78, 0.4, 0.84, 0.05, 0.88, 0, 1, 0];
const FOG_K = [0, 0.3, 0.35, 0.33, 0.45, 0.55, 0.52, 0.68, 0.62, 0.75, 0.72, 0.62, 0.8, 0.45, 0.88, 0.34, 1, 0.3];
const SUN_K = [0, 0, 0.35, 0.06, 0.55, 0.12, 0.7, 0.22, 0.8, 0.42, 0.85, 0.62, 0.93, 0.92, 1, 1];
const WIND_K = [0, 1.6, 0.35, 2.2, 0.45, 6.5, 0.55, 9.5, 0.7, 8, 0.78, 4.5, 0.86, 2.4, 1, 1.8];

function evalCurve(k, p) {
  if (p <= k[0]) return k[1];
  for (let i = 2; i < k.length; i += 2) {
    if (p <= k[i]) {
      const p0 = k[i - 2], v0 = k[i - 1];
      return v0 + (k[i + 1] - v0) * ((p - p0) / (k[i] - p0));
    }
  }
  return k[k.length - 1];
}

function moveTo(v, target, maxStep) {
  const d = target - v;
  if (d > maxStep) return v + maxStep;
  if (d < -maxStep) return v - maxStep;
  return target;
}

const RAIN_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform vec2 uWindOff;
uniform vec2 uWind;
uniform float uOpacity;
uniform float uDensity;
attribute vec4 aSeed;
varying vec2 vUv;
varying float vA;
const vec3 BOX = vec3(64.0, 36.0, 64.0);

void main() {
  vUv = uv;
  float g = fract(aSeed.x * 57.31 + aSeed.z * 11.71);
  if (g > uDensity) {
    vA = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float speed = mix(19.0, 28.0, aSeed.w);
  float wk = 0.7 + 0.6 * fract(aSeed.y * 13.37);
  // world-anchored wrap: drops stay put while the box follows the camera
  vec3 base = aSeed.xyz * BOX + vec3(uWindOff.x * wk, -speed * uTime, uWindOff.y * wk);
  vec3 lo = uCenter - BOX * 0.5;
  vec3 p = mod(base - lo, BOX) + lo;

  vec3 vel = vec3(uWind.x * wk, -speed, uWind.y * wk);
  vec3 dir = normalize(vel);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 side = cross(dir, toCam / max(dist, 1e-3));
  float sl = max(length(side), 1e-3);
  side /= sl;

  float len = mix(0.55, 1.25, aSeed.w);
  vec3 wp = p + dir * (position.y * len) + side * (position.x * 0.035);
  vA = uOpacity * (0.2 + 0.32 * aSeed.w)
     * smoothstep(1.2, 4.5, dist)
     * (1.0 - smoothstep(22.0, 31.0, dist));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const RAIN_FRAG = /* glsl */ `
uniform float uFlash;
varying vec2 vUv;
varying float vA;

void main() {
  float ax = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float ay = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = vA * ax * ax * (0.3 + 0.7 * ay * ay);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.6, 0.68, 0.8) * (1.0 + uFlash * 2.2), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WeatherSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.events = ctx.events;
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    this._simTime = 0;
    this._windMag = 1.6;
    this._windOffX = 0;
    this._windOffZ = 0;
    this._rainVis = 0;

    this._nextStrike = 6;
    this._flashT = 99;
    this._flashPeak = 0;
    this._thunderAt = -1;
    this._thunderVol = 0;
  }

  async init() {
    // ---- GPU rain volume ----
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const seeds = new Float32Array(RAIN_COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = RAIN_COUNT;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._rainUniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uWindOff: { value: new THREE.Vector2() },
      uWind: { value: new THREE.Vector2() },
      uOpacity: { value: 0 },
      uDensity: { value: 0 },
      uFlash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this._rainUniforms,
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.rainMesh = new THREE.Mesh(geo, mat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 30;
    this.rainMesh.matrixAutoUpdate = false;
    this.rainMesh.visible = false;
    this.scene.add(this.rainMesh);

    this.events.on('race:restart', () => this._snap());
    this._snap();
  }

  /** Instant re-sync of weather to the current progress (restart only). */
  _snap() {
    const st = this.state;
    if (!st || !st.weather) return;
    const p = st.progress || 0;
    const w = st.weather;
    w.rain = evalCurve(RAIN_K, p);
    w.wetness = w.rain;
    w.fog = evalCurve(FOG_K, p);
    w.sunset = evalCurve(SUN_K, p);
    w.lightning = 0;
    this._windMag = evalCurve(WIND_K, p);
    w.windX = this._windMag * 0.7;
    w.windZ = this._windMag * 0.4;
    this._rainVis = w.rain;
    this._nextStrike = 5 + Math.random() * 4;
    this._flashT = 99;
    this._flashPeak = 0;
    this._thunderAt = -1;
  }

  update(dt, time) {
    const st = this.state;
    if (!st || !st.weather) return;
    this._simTime += Math.max(0, dt);
    const w = st.weather;
    const p = st.progress || 0;

    // ---- authored timeline, rate-limited so nothing ever snaps ----
    w.rain = moveTo(w.rain, evalCurve(RAIN_K, p), 0.4 * dt);
    w.fog = moveTo(w.fog, evalCurve(FOG_K, p), 0.35 * dt);
    w.sunset = moveTo(w.sunset, evalCurve(SUN_K, p), 0.25 * dt);

    // wetness soaks fast, dries slow
    if (w.rain > w.wetness) w.wetness = Math.min(w.rain, w.wetness + 0.5 * dt);
    else w.wetness = Math.max(w.rain, w.wetness - 0.05 * dt);

    // ---- wind: storm-scaled magnitude with slow gusting ----
    this._windMag = moveTo(this._windMag, evalCurve(WIND_K, p), 4 * dt);
    const gust = 0.62 + 0.38 * Math.sin(time * 0.9 + Math.sin(time * 0.37) * 1.7);
    const ang = 0.7 + 0.3 * Math.sin(time * 0.05);
    const mag = this._windMag * gust;
    w.windX = Math.cos(ang) * mag;
    w.windZ = Math.sin(ang) * mag * 0.8;

    // ---- lightning strikes (storm only) ----
    if (w.rain > 0.35) {
      this._nextStrike -= dt;
      if (this._nextStrike <= 0) {
        const strength = Math.min(1, (w.rain - 0.3) / 0.5);
        this._nextStrike = w.rain > 0.7 ? 4 + Math.random() * 5 : 7 + Math.random() * 5;
        this._flashT = 0;
        this._flashPeak = (0.45 + Math.random() * 0.55) * strength;
        this.events.emit('weather:lightning', { intensity: this._flashPeak });
        this._thunderAt = time + 0.5 + Math.random() * 2.2;
        this._thunderVol = 0.4 + 0.6 * this._flashPeak;
      }
    }
    this._flashT += dt;
    const ft = this._flashT;
    // fast main flash + secondary return-stroke pop ~140 ms later
    w.lightning = Math.min(1, this._flashPeak * (Math.exp(-9 * ft) + 0.65 * Math.exp(-Math.abs(ft - 0.14) * 22)));
    if (w.lightning < 0.001) w.lightning = 0;

    if (this._thunderAt >= 0 && time >= this._thunderAt) {
      this._thunderAt = -1;
      this.events.emit('audio:sfx', { name: 'thunder', volume: this._thunderVol });
    }

    // ---- rain visual (hidden inside the mine tunnel) ----
    const inTunnel = p > 0.55 && p < 0.64;
    const visTarget = inTunnel ? 0 : w.rain;
    this._rainVis = moveTo(this._rainVis, visTarget, (inTunnel || visTarget < this._rainVis ? 2.5 : 0.5) * dt);

    const u = this._rainUniforms;
    u.uTime.value = this._simTime;
    u.uFlash.value = w.lightning;
    u.uWind.value.set(w.windX, w.windZ);
    this._windOffX += w.windX * 1.4 * dt;
    this._windOffZ += w.windZ * 1.4 * dt;
    u.uWindOff.value.set(this._windOffX, this._windOffZ);

    const cam = this.camera;
    if (cam) {
      cam.getWorldDirection(_v1);
      _v2.copy(cam.position).addScaledVector(_v1, 12);
      _v2.y += 5;
      const car = st.car;
      if (car && car.velocity) _v2.addScaledVector(car.velocity, 0.25);
      u.uCenter.value.copy(_v2);
    }

    const qMul = st.settings && st.settings.quality !== 'high' ? 0.55 : 1;
    u.uOpacity.value = this._rainVis * 0.95;
    u.uDensity.value = (0.25 + 0.75 * this._rainVis) * qMul;
    this.rainMesh.visible = this._rainVis > 0.02;
  }
}
