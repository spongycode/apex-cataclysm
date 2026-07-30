// CinematicShader — the ONE custom fullscreen grade pass, run after tone mapping
// (LDR sRGB in, LDR sRGB out; FXAA follows). Combines:
//   - speed-driven radial motion blur (masked away from screen centre)
//   - chromatic aberration (steady at speed/boost + impact pulses)
//   - boost heat tint at frame edges
//   - wet-weather desaturate + contrast curve
//   - lightning white-flash lift
//   - vignette + subtle animated film grain
export const CinematicShader = {
  name: 'ApexCinematic',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uBlur: { value: 0 },      // 0..1 radial blur strength
    uChroma: { value: 0 },    // uv-space channel split
    uBoost: { value: 0 },     // 0..1 smoothed boosting
    uLightning: { value: 0 }, // 0..1 flash envelope
    uWet: { value: 0 },       // 0..1 rain/wetness grade
    uAspect: { value: 16 / 9 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uBlur;
    uniform float uChroma;
    uniform float uBoost;
    uniform float uLightning;
    uniform float uWet;
    uniform float uAspect;

    float ghash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centre = vec2(0.5, 0.46); // slightly below middle: road vanishing point
      vec2 ar = vec2(uAspect, 1.0);
      vec2 toC = (uv - centre) * ar;
      float r = length(toC);
      vec2 dir = r > 1e-5 ? toC / r : vec2(0.0);
      vec2 dirUv = dir / ar;

      // Radial mask: dead-calm at the vanishing point, full streak at edges.
      float mask = smoothstep(0.08, 0.60, r);
      float blurAmt = uBlur * mask * 0.05;
      float ca = uChroma * (0.35 + 0.65 * mask);

      // Base tap with chromatic split along the radial direction.
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dirUv * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dirUv * ca * 1.4).b;

      // Radial streak accumulation, weights gated so zero blur == pure base tap.
      float blurOn = smoothstep(0.0004, 0.0040, blurAmt);
      float wsum = 1.0;
      for (int i = 1; i <= 5; i++) {
        float f = float(i) / 5.0;
        float w = blurOn * (1.0 - 0.55 * f);
        col += texture2D(tDiffuse, uv - dirUv * blurAmt * f).rgb * w;
        wsum += w;
      }
      col /= wsum;

      // Boost: hot ember tint bleeding in from the edges.
      col += vec3(0.10, 0.035, 0.0) * uBoost * mask;

      // Wet weather: slight desaturate + contrast lift (cold cinematic curve).
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), 0.16 * uWet);
      col = (col - 0.5) * (1.0 + 0.12 * uWet) + 0.5;

      // Lightning: lift toward cool white.
      col += (vec3(0.85, 0.92, 1.10) - col) * clamp(uLightning, 0.0, 1.0) * 0.6;

      // Vignette.
      col *= 1.0 - 0.32 * smoothstep(0.35, 1.05, r);

      // Film grain, backed off in highlights.
      float g = ghash(uv * vec2(1387.0, 773.0) + fract(uTime * 61.7));
      col += (g - 0.5) * 0.028 * (1.0 - 0.5 * clamp(lum, 0.0, 1.0));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};
