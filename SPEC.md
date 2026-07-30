# APEX: CATACLYSM CANYON — Architecture Spec

AAA showcase racing demo in Three.js. One unforgettable point-to-point sprint (~2.5 min), 4 cars,
scripted cataclysm set pieces, dynamic weather, golden-hour desert → storm forest → sunset finish.

**This file is the contract. Every module MUST conform exactly to the APIs below.**
Units are meters / seconds / radians. +Y up. Car ~4.6 m long. Top speed ~75 m/s (270 km/h with boost).
Track is ~8 km. Target: 60 fps on an Apple-Silicon MacBook, in Chrome.

## Runtime & imports

- ES modules served statically, import map maps `three`, `three/addons/`, `three-mesh-bvh`.
- three v0.170. Use `three/addons/` for EffectComposer, passes, etc. NO other dependencies, NO
  network fetches at runtime (no CDN textures/fonts/HDRIs). Everything procedural: geometry,
  canvas/DataTextures, WebAudio synthesis.
- `package.json` has `"type": "module"` — validate your files with `node --check <file>`.

## Module lifecycle

Every system is a class: `constructor(ctx)` (cheap, no scene work) → `async init()` (build
everything) → `update(dt, time)` per render frame. Physics/AI additionally get
`fixedUpdate(fdt)` at **120 Hz** from main.js. `dt` is already scaled by `state.timeScale`
(slow-mo); `time` is unscaled elapsed seconds.

`ctx` (created in main.js, passed to every constructor):

```js
ctx = {
  renderer,   // THREE.WebGLRenderer
  scene,      // THREE.Scene
  camera,     // THREE.PerspectiveCamera (transform OWNED by CameraSystem)
  events,     // EventBus: on(name, fn), off(name, fn), emit(name, payload)
  state,      // shared mutable game state (below)
  input,      // InputManager (below)
  world,      // CollisionWorld (below)
  track,      // set by main after TrackSystem.init(); null during constructors
}
```

Init order in main.js (sequential awaits): Rendering → Track (sets ctx.track) → Physics →
CarVisuals → AI → VFX → Weather → Camera → Audio → UI.

Per-frame order: input → fixed-step { physics.fixedUpdate, ai.fixedUpdate } → track → weather →
vfx → carVisuals → ai → camera → audio → ui → rendering.render(dt).

## Shared state (`src/core/state.js` — already written, read it)

```js
state = {
  phase: 'loading'|'menu'|'countdown'|'racing'|'finished',
  countdown: 3,            // seconds remaining, main.js owns
  raceTime: 0,             // seconds since GO, main.js owns
  progress: 0,             // player 0..1 along spline; TrackSystem writes each frame
  checkpoint: 0,           // checkpoints passed; TrackSystem writes
  checkpointTotal: 12,
  racePosition: 4,         // 1..4; AISystem computes (it knows all cars' progress)
  wrongWay: false,         // TrackSystem writes
  timeScale: 1,            // main.js applies to dt; set via events 'time:slowmo'
  stats: { topSpeedKmh: 0, driftScore: 0, airTime: 0, propsBroken: 0 }, // physics/track write
  car: { /* written by VehiclePhysics every fixed step — see Physics section */ },
  weather: {               // WeatherSystem writes; Rendering/VFX/Audio read
    rain: 0, wetness: 0, fog: 0.35,   // all 0..1 (fog is artistic density scalar)
    lightning: 0,          // flash intensity envelope 0..1 (decays fast)
    sunset: 0,             // 0 = golden noon start, 1 = full sunset finish
    windX: 0, windZ: 0,    // m/s, affects particles/trees
  },
  settings: { quality: 'high'|'medium'|'low', mute: false, cameraMode: 0 },
}
```

## Events (exact names; payloads are plain objects)

| event | payload | emitted by |
|---|---|---|
| `race:countdown` | `{n}` (3,2,1,0; 0 = GO) | main |
| `race:start` | `{}` | main |
| `race:checkpoint` | `{index, total}` | track |
| `race:finish` | `{time, stats}` | track (player crosses finish) |
| `car:jump` | `{speed}` | physics (leaves ground fast off ramp lip) |
| `car:landed` | `{impactSpeed, airTime}` | physics |
| `car:collision` | `{point:Vector3, normal:Vector3, speed}` | physics (wall hits > 5 m/s) |
| `car:respawn` | `{}` | main (R key / kill-plane) |
| `drift:start` / `drift:end` | `{}` / `{score, duration}` | physics |
| `boost:start` / `boost:end` | `{}` | physics |
| `prop:break` | `{position:Vector3, type:'sign'\|'barrel'\|'cone'\|'crate'\|'fence'}` | track |
| `setpiece:rockslide` | `{position:Vector3}` | track |
| `setpiece:collapse` | `{position:Vector3, index}` | track (bridge segment drops) |
| `setpiece:explosion` | `{position:Vector3, radius}` | track |
| `weather:lightning` | `{intensity}` (0..1) | weather |
| `ui:message` | `{text, sub?, style:'info'\|'epic'\|'warn'}` | anyone (big center callouts: "MASSIVE AIR!") |
| `camera:shake` | `{intensity, duration}` (intensity ~0..1) | anyone |
| `time:slowmo` | `{scale, duration}` | anyone (main tweens timeScale down & back) |
| `audio:sfx` | `{name, volume?, position?:Vector3}` | anyone (one-shots; AudioSystem maps names) |
| `load:progress` | `{label, ratio}` | main |

## CollisionWorld (`src/core/world.js` — already written, read it)

```js
world.addCollider(mesh, { surface: 'asphalt', dynamic: false }) // builds BVH once; meshes may move if dynamic:true
world.removeCollider(mesh)
world.raycast(origin, dir, far) // → { point, normal, distance, surface, mesh } | null  (world space, normalized dir)
```
Every drivable/hittable surface must be registered. `mesh.userData.surface` set from options:
`'asphalt'|'dirt'|'sand'|'wood'|'metal'|'water'|'rock'`.

## InputManager (`src/core/input.js` — already written, read it)

`input.actions` = `{ throttle:0..1, brake:0..1, steer:-1..1 (left=-1), handbrake:bool, boost:bool }`
plus edge-triggered `input.pressed('start'|'respawn'|'camera'|'mute')`. Keyboard (WASD/arrows,
Space handbrake, Shift boost, Enter start, R respawn, C camera, M mute) + gamepad.

---

# SUBSYSTEM CONTRACTS (one builder owns each; do not touch files outside your section)

## 1. TrackSystem — `src/track/TrackSystem.js` (+ helpers in `src/track/`)

The star of the show. Builds the entire world: track ribbon, terrain, all zones, props,
set pieces, checkpoints. Registers colliders. Exposes:

```js
class TrackSystem {
  spline            // THREE.CatmullRomCurve3 centerline (goes THROUGH the loop vertically)
  checkpoints       // [{position:Vector3, t:0..1}] — 12, last one = finish gate
  sample(t)         // → { position:V3, tangent:V3, up:V3 (road normal incl. banking), right:V3, width:m, surface:str }
                    //   from ~3000 precomputed rotation-minimizing frames + authored banking; interpolated
  progressAt(pos)   // Vector3 → nearest t (cached grid lookup, fast)
  getSpawn(slot)    // 0..3 → {position:Vector3, quaternion:Quaternion}; slot 3 = player (back of grid)
  update(dt, time)  // set pieces, moving obstacles, breakable checks, writes state.progress/checkpoint/wrongWay
}
```

Zone sequence (by t): 0.00 desert-mesa start grid & banked sweepers (golden hour, red rock,
breakable billboards/cones) → 0.14 canyon drift gauntlet (banked hairpins on cliff shelf) →
0.26 THE BIG JUMP (huge ramp over canyon gap, ~60 m flight; kicker angled so flat-out speed lands
on the lower plateau) → 0.32 rockslide pass (trigger: boulders roll across road, real moving
colliders) → 0.42 forest run (fog, instanced pines, dirt surface, breakable fences; rain builds
here) → 0.55 mine tunnel (string lights, sparks, supports collapse *behind* the car) → 0.64 THE
LOOP (giant stunt loop, industrial scaffold look) → 0.72 water crossing (shallow ford, surface
'water') → 0.80 THE COLLAPSING BRIDGE (long gorge bridge; explosions drop segments *behind* the
player chasing them — never unfairly ahead) → 0.93 sunset finish straight, small kicker jump
through a flaming arch, finish gate.

Requirements:
- Ribbon geometry from frames (position ± right·width/2), banking authored per zone (up to ~30°
  on sweepers, full 360° roll through loop handled by RMF continuity). UVs along length for
  center-line/edge stripes (shader or canvas texture). Distinct PBR road materials per surface.
- Invisible guard-rail colliders along deadly edges EXCEPT jump gaps. Kill-plane handled by main
  (respawn if car.position.y < sample(progress).position.y - 60).
- Terrain: sculpted canyon/mesa/gorge ground + cliff walls (displaced planes, vertex-colored or
  triplanar-ish material), low-poly but art-directed silhouettes. Instanced rocks, cacti, pines
  (`InstancedMesh`, thousands). A few near-road boulders get real colliders.
- Breakables: InstancedMesh per type; spatial-hash proximity vs car; on hit hide instance, emit
  `prop:break`, bump `state.stats.propsBroken`. Do NOT slow the car.
- Set pieces run off `state.progress` triggers + timers; move their collider meshes (dynamic:true),
  emit the setpiece events (VFX/Audio react). Bridge collapse: segment meshes tilt+drop with
  physics-ish tween, colliders move with them.
- Scale/perf: merge static zone geometry where possible, use instancing aggressively, total draw
  calls for track+env < 150. Frustum culling on (default); give huge merged meshes correct bounds.

## 2. VehiclePhysics — `src/physics/VehiclePhysics.js` (+ helpers in `src/physics/`)

Custom arcade-sim raycast vehicle. THE most important feel component.

```js
class VehiclePhysics {
  fixedUpdate(fdt)                 // reads ctx.input.actions; steps 120 Hz
  respawn(position, quaternion)    // zero velocity, place car
  // writes state.car every step:
}
state.car = {
  position:V3, quaternion:Quaternion, velocity:V3,     // chassis (center at ~0.6 m above ground)
  speedKmh, rpm:0..1, gear:1..6,
  steer:-1..1 (visual wheel angle norm), throttle, brake,
  grounded:bool, airborne:bool, airTime:s,
  drifting:bool, driftAngle:rad (signed body slip),
  boost:0..1 (tank), boosting:bool,
  surface:str,                                          // dominant wheel contact surface
  wheels: [FL,FR,RL,RR] each { worldPos:V3, radius:0.34, spinAngle:rad, steerAngle:rad,
                               compression:0..1, contact:bool, slip:0..1, normal:V3 },
  localAccel:V3,                                        // chassis-space accel for weight-transfer readers
}
```

Requirements:
- 4-wheel raycast suspension (spring + damper, ~0.35 m travel) cast along −chassisUp via
  `ctx.world.raycast`. Weight transfer must be EMERGENT (braking dives, throttle squats, corners
  roll) — CarVisuals and Camera read it.
- Tire model: simplified slip-curve (grip peaks then falls off), separate long/lat, surface grip
  multipliers (asphalt 1.0, wood .95, metal .9, dirt .75, sand .6, water .5 + drag). Handbrake
  cuts rear grip to initiate drifts; sustained countersteer drift must feel Forza-Horizon
  controllable, building `stats.driftScore` (points/s scaled by angle·speed).
- Loop-capable: suspension force along contact normal; when grounded on steep/inverted surfaces at
  speed, blend gravity toward −surfaceNormal ("adhesion") so a fast car sticks through the 360°
  loop but a slow one falls off. Downforce ∝ v².
- Boost: nitrous tank, refills from drifting + air time; Shift = strong accel + emits boost events.
- Airborne: slight pitch/yaw authority from inputs (arcade), auto-level tendency; emit `car:jump`
  on ramp launches (>15 m/s, upward), `car:landed` with impact data.
- Chassis-vs-wall: ring of ~8 horizontal short rays at bumper height + velocity ray; push-out +
  velocity slide/reflect, emit `car:collision` (>5 m/s). NEVER tunnel through walls at top speed
  (substep or clamp displacement per step).
- Assists tuned in: speed-sensitive steering, mild stability aid OFF-throttle, so keyboard play
  feels tight, never twitchy. Gearbox: 6 speeds, auto, rpm 0..1 for audio with shift dips.

## 3. CarVisuals — `src/car/CarVisuals.js` + `src/car/carFactory.js`

`carFactory.js` exports `buildCarMesh({ paint: 0xhex, accent: 0xhex })` →
`{ group, wheels:[4 meshes FL,FR,RL,RR], brakeLightMat, headlights:[2 SpotLights], boostFlames:[2 meshes], paintMat }`.
Procedural supercar (think Lambo-silhouette from primitives + LatheGeometry/ExtrudeGeometry +
beveled boxes): sleek low body with clearcoat PBR paint (`MeshPhysicalMaterial`, clearcoat 1,
metallic flakes via tiny canvas normal/roughness noise), dark glass canopy (transmission or
low-rough black), wheel wells, detailed rims + fat tires (torus + cylinder detail), rear
diffuser + wing, glowing brake-light strip, emissive underglow accent, twin exhausts.
Must look great at 2 m AND read well at 50 m. ~<40k tris.

`CarVisuals` (player car): builds via factory, each frame syncs group to `state.car`
position/quaternion, wheels to `wheels[i]` (worldPos → local suspension travel, spinAngle,
steerAngle), brake-light emissive on brake/handbrake, headlights auto-on when
`state.weather.rain>0.3` or in tunnel (`state.car.surface==='metal'` hint or light probe by
progress range 0.55–0.64), boost flames visible when `boosting` (flicker scale), subtle body
strain: NONE extra beyond physics quaternion (physics already rolls). Contact shadow: darkened
radial-gradient plane under car when grounded.

## 4. RenderingSystem — `src/rendering/RenderingSystem.js` (+ helpers in `src/rendering/`)

Owns visual quality. `render(dt)` called last each frame; handles window resize.

- Renderer: ACESFilmic, exposure tuned, `outputColorSpace = SRGBColorSpace`, shadows
  `PCFSoftShadowMap`, pixelRatio min(devicePixelRatio, 2) scaled by quality.
- Sky: procedural gradient+sun sky dome shader driven by `state.weather.sunset` (golden hour →
  bruised storm → blazing sunset), sun disc + haze; PMREM-baked environment from the sky
  (re-bake only on big weather change, ~every 2 s max) for PBR reflections.
- Sun: DirectionalLight w/ 2048 shadow map, frustum (~120 m) snapped & following the player car;
  color/elevation follow sunset+storm. Hemisphere ambient. Fog: `FogExp2` driven by
  `state.weather.fog` & zone tint.
- Post (EffectComposer): UnrealBloom (tight threshold), speed-driven radial motion blur +
  chromatic aberration + subtle vignette in ONE custom fullscreen pass (uniforms: speed01,
  boosting, lightning flash tint, rain wetness slight desat/contrast curve), SMAA or FXAA.
- Lightning: reads `state.weather.lightning`, punches sky + a brief directional intensity spike.
- Adaptive quality: rolling frame-time average; drop pixelRatio → bloom res → shadow size across
  'high'/'medium'/'low', write `state.settings.quality`. Never oscillate (hysteresis).

## 5. VFX — `src/vfx/VFXSystem.js` + Weather — `src/weather/WeatherSystem.js`

VFX: pooled GPU particles (custom ShaderMaterial + instanced/points buffers; NO per-particle
Sprites). Systems: tire smoke & dirt/sand plumes per slipping wheel (color by surface), rain
splash ring + bow-wave spray at water ford, boost exhaust flames + heat streaks, speed-line wisps
past camera at >180 km/h, sparks (wall scrapes, tunnel), explosion (fireball billow + smoke column
+ glowing debris chunks + expanding shockwave ring) on `setpiece:explosion`/`prop:break`(barrel),
prop debris bursts on `prop:break`, rockslide dust on `setpiece:rockslide`, landing dust puff on
`car:landed`, confetti/fireworks on `race:finish`. Everything event-driven + reads `state.car`
wheels/slip each frame. Budget: <60k live particles, zero allocation per frame in steady state.

Weather: authored timeline keyed to `state.progress` (NOT wall time): golden clear (0–0.35) →
storm builds (0.35–0.5) → full rain+lightning through forest/tunnel/loop (0.5–0.75, lightning
strikes with `weather:lightning` + thunder sfx events) → breaks (0.75–0.85) → clear blazing sunset
(0.85–1, sunset→1). Writes `state.weather`. Owns GPU rain (streaked quads falling in camera-front
volume, wind-sheared; hidden in tunnel via progress range).

## 6. AudioSystem — `src/audio/AudioSystem.js`

100% WebAudio synthesis, created/resumed on first user gesture (main emits start). Master
compressor + mute (M).
- Engine: layered oscillators (saw/pulse + sub) through waveshaper distortion + resonant filter,
  pitch/timbre from `state.car.rpm` & gear (shift dips audible), load from throttle; turbo whine
  ∝ rpm·throttle + blow-off chirp on lift; boost = rocket rumble layer.
- Surface & motion: wind noise ∝ speed (filtered noise), tire roar by surface, skid squeal from
  wheel slip (asphalt only), gravel patter on dirt.
- One-shots via `audio:sfx` + events: collision crunches (velocity-scaled), prop breaks, jump
  whoosh, hard-landing thud, checkpoint chime, countdown beeps + GO blast, explosion boom w/
  sub-drop, thunder rumble (delay after `weather:lightning`), rockslide rumble, finish fanfare.
- Rain bed when `weather.rain>0`, tunnel reverb send for engine at progress 0.55–0.64.
- Optional tasteful synthwave bed (menu + racing, ducked under big sfx). Keep mix clean, nothing
  clipping, engine always the hero.

## 7. AISystem — `src/ai/AISystem.js`

3 rivals (distinct paints via `buildCarMesh`). Spline followers with personality: per-AI lateral
racing-line offset (smooth noise), curvature-aware speed (lookahead braking), full send off jumps
and through the loop (they follow `track.sample`, banking included), tiny mistakes (wide lines,
late brakes). Rubber-banding: trail leader logic keeps pack within ~6 s of player both ways —
race should feel winnable but tense, player realistically finishing 1st–2nd with decent driving.
Wheels spin, brake lights work (reuse factory outputs), simple dust/smoke by emitting nothing —
VFX only tracks player (perf). Computes `state.racePosition` from all cars' progress each frame.
Avoid: never collide-check vs player (ghost-adjacent: gentle repulsion offset if within 3 m so it
never feels like phasing). Update at fixedUpdate for motion, update() for visuals.

## 8. UISystem — `src/ui/UISystem.js` (DOM overlay in `#ui-root`, injects own `<style>`)

NFS-Unbound-meets-Forza art direction: bold condensed type (system stack:
`'Arial Narrow', 'Helvetica Neue', Impact`), hot accent gradient (magenta→orange), skewed
panels, grain. Screens:
- Title/menu (`phase==='menu'`): big logo "APEX // CATACLYSM CANYON", animated sheen, controls
  legend, "PRESS ENTER"; hides on countdown.
- Countdown: huge 3-2-1-GO stamps (scale+blur-in) on `race:countdown`.
- HUD (racing): speedo (SVG arc needle + big km/h digits), gear, rpm sweep, boost bar (gradient
  fill, pulses when full), race position "P1/4", timer, checkpoint splits flash, drift score
  popups that tally & bank (`drift:end`), stylish `ui:message` center callouts ("MASSIVE AIR!",
  "NICE DRIFT +2400", "BRIDGE COLLAPSING — FLOOR IT!"), wrong-way flasher, damage-free.
- Minimap: bottom-left SVG polyline of `track.sample` route, player + AI dots, checkpoint ticks.
- Finish (`race:finish`): results card — time, position, top speed, drift score, props broken,
  air time; "R to restart". Everything animates in (CSS transforms only, no layout thrash).
Update loop writes via cached element refs; zero DOM creation per frame (pool popups).

## 9. CameraSystem — `src/camera/CameraSystem.js`

Owns `ctx.camera`. Modes (C cycles): chase (default), close chase, hood.
- Chase: spring-damped follow (position + look target ahead of car along velocity), speed-based
  pullback + FOV 62→84, drift lateral swing showing car angle, banked-turn roll hint (≤6°),
  vertical soften on jumps (camera floats, car drops away slightly = sense of air), hard landing
  dip. Never clips terrain: raycast from target to camera, pull in on hit.
- Effects: `camera:shake` trauma system (perlin rotational shake, intensity²-decay), landing +
  collision auto-shake, boost adds micro-vibrate + extra FOV.
- Cinematics: menu = slow aerial dolly along spline showcasing set pieces (crossfade cuts every
  ~6 s via progress jumps); countdown = swoop from front of car to chase position; finish = slow
  orbit with slow-mo (`time:slowmo` on big jumps ONLY if in top-speed +boost, once per jump, and on finish).

---

## Global conventions

- **Car orientation: forward = local −Z, up = +Y, right = +X** (three.js lookAt convention).
  Applies to physics chassis, carFactory meshes, spawn quaternions, AI cars.
- Wheel order everywhere: `[FL, FR, RL, RR]`. Wheelbase ~2.7 m, track width ~1.62 m, wheel r 0.34.
- `track.sample(t).tangent` points in the direction of travel (increasing t).

## Build discipline (every builder)

- Own ONLY your files. Read SPEC.md, `src/core/*.js`, `src/main.js`, `index.html` first.
- No runtime network. No external assets. Procedural everything.
- Zero per-frame allocations in hot paths (reuse Vector3s/quats; `_tmp` statics).
- Dispose nothing mid-race; pool everything. No console spam (one-time init logs OK).
- `node --check` every file you write before finishing. Handle `init()` failure gracefully.
- Visual bar: would a screenshot pass for a AAA-adjacent showcase? Silhouettes, color script,
  contrast, readability at speed. When in doubt, art-direct harder.
