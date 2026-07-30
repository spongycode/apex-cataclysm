# APEX // CATACLYSM CANYON

🎮 **[Play Live Demo](https://claude-race.vercel.app/)**

An AAA arcade-racing showcase in the browser built with Three.js r170 and WebGL2. A 2.5-minute point-to-point canyon sprint (~8 km) featuring 4 rival cars, scripted disaster set-pieces, dynamic weather transitions, and 120 Hz vehicle physics.

**There are zero art assets.** Every texture, car mesh, canyon rock wall, environment, and audio sound effect is procedurally synthesized at load time from pure JavaScript. No GLTF models, no image textures, no HDRIs, no audio samples. The only runtime dependency is `three` (and `three-mesh-bvh`).

```bash
npm install
npm start          # http://127.0.0.1:5173
```

**Controls**: `WASD` / `Arrow Keys` to steer & drive, `Space` for handbrake / drift, `Shift` for nitro boost, `C` to toggle camera mode, `R` to respawn.

---

## Subsystems

| Subsystem | What it does |
|---|---|
| `physics` | **120 Hz fixed-step vehicle dynamics.** 4-wheel suspension raycasting with non-linear spring/damper curves, Pacejka slip-friction model, automatic countersteer assist for drift stability, power-oversteer, body roll/pitch, and air-yaw control over ramps. |
| `track` | **~8 km procedural canyon spline.** Generates canyon walls, asphalt surfaces, banked sweepers, mountain tunnels, bridge spans, breakable props (fences, barrels, signs), and scripted set-pieces (rockslides, exploding barrels, collapsing bridge sections). |
| `rendering` | **Cinematic shader pipeline.** Custom post-process pass featuring ACES tonemapping, dynamic velocity motion blur, high-speed radial chromatic aberration, vignetting, color grading LUTs, and golden-hour to sunset lighting transitions. |
| `car` | **Procedural car mesh generator.** Procedurally builds 4 distinct vehicle body styles (Supercar, Muscle, Track Day, Hypercar) with sub-divided panels, glass windows, brake calipers, glowing tail/headlights, and dynamic wheel steering pivots. |
| `ai` | **Rival driver behavior.** Rubberband progress tracking, spline curvature awareness, lateral avoidance between cars, overtaking logic, and dynamic drift counter-steering for 3 rival AI racers. |
| `weather` | **Dynamic atmospheric engine.** Seamless time-of-day progression from golden-hour desert noon to storm forest and sunset finish. Volumetric fog density, dynamic rain drops, lightning flash envelopes, and wind vector forces. |
| `vfx` | **GPU particle engine.** Multi-emitter pool for tire smoke during drifts, high-speed nitro exhaust flames, sparks from wall collisions, rockslide dust clouds, and screen wetness rain drops. |
| `audio` | **WebAudio procedural synthesizer.** Zero audio files. Synthesizes multi-oscillator engine RPM revs, turbo spooling, tire squeal noise filters, collision thuds, nitro hiss, and atmospheric wind/thunder. |
| `camera` | **Dynamic racing camera rig.** Chase mode, bumper cam, and cinematic orbit. Dynamic FOV speed-warp, G-force impulse offsets, landing impact shake, and drift angle tracking. |
| `ui` | **HUD & Race Control.** Styled canvas/CSS HUD with tachometer dial, digital speedometer, gear indicator, drift score counter, wrong-way warnings, position rank (1st-4th), and countdown callouts. |

---

## Tooling & QA Harness

The project includes an automated headless testing harness built with Puppeteer to ensure performance, visual quality, and physics stability:

| Tool | Purpose |
|---|---|
| `qa/shot.mjs` | Capture screenshot at specific track keypoints via headless Chromium. |
| `qa/probe-phys.mjs` | Automated physics sanity verification & vehicle state assertions. |
| `qa/probe-carviz.mjs` | Visual verification of vehicle mesh rendering and wheel alignments. |
| `qa/probe-trackcritic.mjs` | Visual evaluation of track geometry, canyon cliffs, and lighting across all segments. |
| `qa/probe-aicritic.mjs` | Verification of rival AI pathing, overtaking, and spacing along the spline. |
| `qa/probe-rvlight.mjs` | Verification of sky lighting transitions and dynamic weather parameters. |

---

## Performance & Optimization

Measured on Apple Silicon at 60 fps target:

* **120 Hz Fixed Physics Loop**: Decouples physics calculations from render frame rates to maintain deterministic car handling regardless of display refresh rate.
* **Spatial Partitioning**: Utilizes `three-mesh-bvh` for ultra-fast raycasting against canyon cliffs and track geometry.
* **Procedural Texture Caching**: Generates canvas DataTextures once during load phase to maintain 0 runtime network fetches and 0 mid-race shader compilations.

---

## Honest Assessment

The goal was to build a console-grade arcade racing experience purely from procedural code.

* **Strengths**: Vehicle drift feel, dynamic lighting transition from golden-hour desert to sunset canyon, procedural sound engine, and zero external asset footprint.
* **Limitations**: Procedural rock faces rely on triplanar noise functions which lack photorealistic scanned detail; car models are stylistically geometric rather than high-poly CAD models.
