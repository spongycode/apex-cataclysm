// SkyDome — procedural gradient + sun + cloud sky, single ShaderMaterial shared by the
// visible dome and a small bake dome (PMREM environment). All look driven by uniforms
// so RenderingSystem can slave everything to state.weather with zero rebuilds.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Color script (authored sRGB hex → linear via THREE.Color color management).
// Three key moments: golden-hour desert start → bruised storm → blazing sunset.
// ---------------------------------------------------------------------------
const GOLD = {
  zenith: new THREE.Color(0x2c66c4),
  mid: new THREE.Color(0x86b4ea),
  horizon: new THREE.Color(0xffd9a6),
  sun: new THREE.Color(0xfff2cf),
  halo: new THREE.Color(0xffbe6e),
};
const SUNSET = {
  zenith: new THREE.Color(0x241040),
  mid: new THREE.Color(0xc23e7f),
  horizon: new THREE.Color(0xff6a1e),
  sun: new THREE.Color(0xffa04d),
  halo: new THREE.Color(0xff3d7d),
};
const STORM = {
  zenith: new THREE.Color(0x1c242f),
  mid: new THREE.Color(0x39434e),
  horizon: new THREE.Color(0x5a6470),
  sun: new THREE.Color(0xaeb6c2),
  halo: new THREE.Color(0x76808c),
};

/**
 * Blend the three palettes into `out` ({zenith, mid, horizon, sun, halo} of THREE.Color).
 * Zero allocations. Storm wins over sunset (a storm at dusk still reads bruised-grey,
 * with a sliver of sunset warmth kept at the horizon).
 */
export function computeSkyPalette(sunset, storm, out) {
  const s = sunset < 0 ? 0 : sunset > 1 ? 1 : sunset;
  const st = (storm < 0 ? 0 : storm > 1 ? 1 : storm) * 0.92;
  out.zenith.copy(GOLD.zenith).lerp(SUNSET.zenith, s).lerp(STORM.zenith, st);
  out.mid.copy(GOLD.mid).lerp(SUNSET.mid, s).lerp(STORM.mid, st);
  out.horizon.copy(GOLD.horizon).lerp(SUNSET.horizon, s).lerp(STORM.horizon, st * 0.85);
  out.sun.copy(GOLD.sun).lerp(SUNSET.sun, s).lerp(STORM.sun, st);
  out.halo.copy(GOLD.halo).lerp(SUNSET.halo, s).lerp(STORM.halo, st);
  return out;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uHaloColor;
uniform float uSunset;
uniform float uStorm;
uniform float uTime;
uniform float uLightning;
uniform vec2 uWind;

float vhash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vhash(i);
  float b = vhash(i + vec2(1.0, 0.0));
  float c = vhash(i + vec2(0.0, 1.0));
  float d = vhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.31, 9.17);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float th = max(h, 0.0);

  // Horizon → zenith gradient with a mid band for painterly depth.
  vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.26, th));
  sky = mix(sky, uZenith, smoothstep(0.14, 0.72, th));
  vec3 below = uHorizon * mix(0.45, 1.0, smoothstep(-0.35, 0.0, h));
  vec3 col = mix(below, sky, smoothstep(-0.02, 0.02, h));

  // Warm haze band hugging the horizon (dust / humidity).
  float haze = exp(-abs(h) * 8.0);
  col += mix(uHorizon, uSunColor, 0.5) * haze * (0.30 + 0.25 * uSunset) * (1.0 - 0.75 * uStorm);

  // Directional glow wedge around the sun azimuth — huge at full sunset.
  float sd = dot(dir, uSunDir);
  float glowband = pow(max(sd, 0.0), 5.0) * exp(-abs(h - 0.06) * 7.0);
  col += uHaloColor * glowband * (0.55 + 1.25 * uSunset) * (1.0 - 0.9 * uStorm);

  // Clouds: churn ramps with storm; two fbm layers advected by wind.
  vec2 cuv = dir.xz / (0.30 + abs(h) * 1.35);
  vec2 drift = uWind * uTime * 0.006 + vec2(uTime * 0.010, uTime * 0.004);
  float n = fbm(cuv * 1.7 + drift);
  float churn = fbm(cuv * 3.4 - drift * 1.7 + n * 1.4);
  float cloudMask = smoothstep(0.42, 0.78, mix(n, churn, 0.5 + 0.3 * uStorm))
                  * smoothstep(-0.03, 0.22, h);
  vec3 stormCloud = mix(uZenith * 0.42, uMid * 0.30, churn);
  col = mix(col, stormCloud, cloudMask * uStorm);

  // High streaky wisps catching sunset color when clear.
  float wisp = smoothstep(0.55, 0.95, fbm(cuv * vec2(2.6, 7.5) + drift * 2.0));
  col += uHaloColor * wisp * exp(-abs(h - 0.13) * 10.0) * 0.30
       * (0.25 + 0.75 * uSunset) * (1.0 - uStorm);

  // Sun: HDR disc feeds the bloom pass; halo + wide glow feed reflections.
  float sunVis = 1.0 - 0.93 * uStorm;
  float disc = smoothstep(0.99930, 0.99965, sd);
  col += uSunColor * disc * 26.0 * sunVis * (1.0 - 0.85 * cloudMask * uStorm);
  col += uHaloColor * pow(max(sd, 0.0), 28.0) * 2.4 * sunVis;
  col += uSunColor * pow(max(sd, 0.0), 160.0) * 6.0 * sunVis;

  // Lightning: sky-wide lift, strongest inside the cloud deck.
  col += vec3(0.75, 0.85, 1.15) * uLightning * (0.35 + 0.9 * cloudMask);

  // Dither to hide gradient banding.
  col += (vhash(dir.xz * 913.7 + dir.yy) - 0.5) * 0.006;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export class SkyDome {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'ApexSky',
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() },
        uZenith: { value: GOLD.zenith.clone() },
        uMid: { value: GOLD.mid.clone() },
        uHorizon: { value: GOLD.horizon.clone() },
        uSunColor: { value: GOLD.sun.clone() },
        uHaloColor: { value: GOLD.halo.clone() },
        uSunset: { value: 0 },
        uStorm: { value: 0 },
        uTime: { value: 0 },
        uLightning: { value: 0 },
        uWind: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    // Visible dome — recentred on the camera every frame so the horizon never breaks.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(3200, 48, 30), this.material);
    this.mesh.name = 'skyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = true;

    // Small dome sharing the SAME material, in its own scene, for PMREM bakes.
    this.bakeMesh = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 20), this.material);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(this.bakeMesh);
  }
}
