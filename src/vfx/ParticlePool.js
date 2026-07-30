// ParticlePool — one reusable GPU particle engine.
// Instanced quads, all simulation in the vertex shader from a single uTime uniform.
// CPU only writes interleaved attribute data on spawn (ring buffer, zero steady-state
// allocation). Supports billboard / ground-flat / velocity-stretched quads, drag,
// gravity (± for buoyancy), curl wander, size-over-life, 2-stop color ramp, rotation,
// and a 2x2 texture atlas (blob / dot / ring / chunk).

import * as THREE from 'three';

export const MODE_BILLBOARD = 0;
export const MODE_FLAT = 1; // ground-aligned (XZ plane) — shockwaves, splash rings
export const MODE_STRETCH = 2; // stretched along current velocity — sparks, rain-like streaks

export const TILE_BLOB = 0; // soft noisy puff (smoke/dust)
export const TILE_DOT = 1; // hot glow dot (sparks/fire/droplets)
export const TILE_RING = 2; // annulus (shockwave/splash)
export const TILE_CHUNK = 3; // solid shard (debris/confetti)

const STRIDE = 24; // floats per particle

const VERT = /* glsl */ `
uniform float uTime;
attribute vec2 aLife;   // spawnTime, life
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec2 aPhys;   // gravity (+down), drag (1/s)
attribute vec2 aSize;   // size0, size1
attribute vec3 aCol0;
attribute vec3 aCol1;
attribute vec4 aMisc;   // alpha, rot0, rotSpeed, tile + mode*4
attribute vec2 aExtra;  // curl-or-stretch, seed
varying vec2 vUv;
varying vec4 vColor;

void main() {
  float age = uTime - aLife.x;
  float life = aLife.y;
  float u = age / max(life, 1e-3);
  if (life <= 2e-3 || u <= 0.0 || u >= 1.0) {
    vColor = vec4(0.0);
    vUv = vec2(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clipped
    return;
  }

  float mode = floor(aMisc.w * 0.25);
  float tile = aMisc.w - mode * 4.0;

  // drag-integrated ballistic motion
  float k = max(aPhys.y, 1e-4);
  vec3 pos = aPos + aVel * ((1.0 - exp(-k * age)) / k);
  pos.y -= 0.5 * aPhys.x * age * age;

  float seed = aExtra.y * 6.28318;
  if (mode < 0.5 && aExtra.x > 0.0) {
    float c = aExtra.x * u;
    pos += c * vec3(
      sin(seed + age * 1.9),
      0.4 * sin(seed * 1.7 + age * 2.6),
      cos(seed + age * 1.9)
    );
  }

  float size = mix(aSize.x, aSize.y, u);
  float env = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.55, 1.0, u));
  vColor = vec4(mix(aCol0, aCol1, u), aMisc.x * env);

  float ang = aMisc.y + aMisc.z * age;
  float ca = cos(ang), sa = sin(ang);
  vec2 corner = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca);

  if (mode < 0.5) {
    // camera-facing billboard
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    pos += (camRight * corner.x + camUp * corner.y) * size;
  } else if (mode < 1.5) {
    // flat on the ground plane
    pos += vec3(corner.x, 0.0, corner.y) * size;
  } else {
    // stretched along instantaneous velocity
    vec3 velNow = aVel * exp(-k * age);
    velNow.y -= aPhys.x * age;
    float vl = length(velNow);
    vec3 dir = vl > 1e-4 ? velNow / vl : vec3(0.0, 1.0, 0.0);
    vec3 toCam = normalize(cameraPosition - pos);
    vec3 side = cross(dir, toCam);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    pos += dir * (position.y * size * aExtra.x) + side * (position.x * size);
  }

  vUv = (uv + vec2(tile - 2.0 * floor(tile * 0.5), floor(tile * 0.5))) * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticlePool {
  constructor({ capacity, blending, map, renderOrder = 20 }) {
    this.capacity = capacity;
    this._head = 0;
    this._frameStart = 0;
    this._written = 0;
    this._data = new Float32Array(capacity * STRIDE); // life=0 → all dead

    const ib = new THREE.InstancedInterleavedBuffer(this._data, STRIDE);
    ib.setUsage(THREE.DynamicDrawUsage);
    this._ib = ib;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setAttribute('aLife', new THREE.InterleavedBufferAttribute(ib, 2, 0));
    geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(ib, 3, 2));
    geo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(ib, 3, 5));
    geo.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(ib, 2, 8));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(ib, 2, 10));
    geo.setAttribute('aCol0', new THREE.InterleavedBufferAttribute(ib, 3, 12));
    geo.setAttribute('aCol1', new THREE.InterleavedBufferAttribute(ib, 3, 15));
    geo.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(ib, 4, 18));
    geo.setAttribute('aExtra', new THREE.InterleavedBufferAttribute(ib, 2, 22));
    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMap: { value: map } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Spawn one particle. spawnTime may be in the future (delayed spawn).
   * gravity is +down (negative = buoyant rise). mode: 0 billboard, 1 flat, 2 stretch.
   * extra: curl amplitude (mode 0) or stretch factor (mode 2).
   */
  emit(spawnTime, life, px, py, pz, vx, vy, vz, gravity, drag, s0, s1,
       r0, g0, b0, r1, g1, b1, alpha, rot0, rotSpeed, tile, mode, extra) {
    const i = this._head;
    const d = this._data;
    let o = i * STRIDE;
    d[o++] = spawnTime; d[o++] = life;
    d[o++] = px; d[o++] = py; d[o++] = pz;
    d[o++] = vx; d[o++] = vy; d[o++] = vz;
    d[o++] = gravity; d[o++] = drag;
    d[o++] = s0; d[o++] = s1;
    d[o++] = r0; d[o++] = g0; d[o++] = b0;
    d[o++] = r1; d[o++] = g1; d[o++] = b1;
    d[o++] = alpha; d[o++] = rot0; d[o++] = rotSpeed;
    d[o++] = tile + mode * 4;
    d[o++] = extra;
    d[o] = Math.random();
    this._head = i + 1 === this.capacity ? 0 : i + 1;
    if (this._written < this.capacity) this._written++;
  }

  setTime(t) {
    this.material.uniforms.uTime.value = t;
  }

  /** Upload only the ranges written since last flush. Call once per frame. */
  flush() {
    const w = this._written;
    if (w === 0) return;
    const ib = this._ib;
    if (w >= this.capacity || ib.updateRanges.length > 32) {
      ib.clearUpdateRanges();
      ib.addUpdateRange(0, this.capacity * STRIDE);
    } else {
      const s = this._frameStart;
      if (s + w <= this.capacity) {
        ib.addUpdateRange(s * STRIDE, w * STRIDE);
      } else {
        ib.addUpdateRange(s * STRIDE, (this.capacity - s) * STRIDE);
        ib.addUpdateRange(0, (s + w - this.capacity) * STRIDE);
      }
    }
    ib.needsUpdate = true;
    this._frameStart = this._head;
    this._written = 0;
  }

  /** Kill every live particle (used on race restart). One-time cost, not a hot path. */
  killAll() {
    const d = this._data;
    for (let i = 0; i < this.capacity; i++) d[i * STRIDE + 1] = 0;
    this._ib.clearUpdateRanges();
    this._ib.addUpdateRange(0, d.length);
    this._ib.needsUpdate = true;
    this._frameStart = this._head;
    this._written = 0;
  }
}
