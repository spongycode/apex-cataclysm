// ============================================================================
// APEX: CATACLYSM CANYON — vehicle tuning sheet
// Every number here is a FEEL decision. Units: m, s, rad, N, kg.
// Targets (SPEC): 0-100 km/h ~= 3.5 s | top ~230 km/h (270 boosted) |
//                 100-0 braking ~= 38 m | drifts sustainable at 30-45 deg.
// ============================================================================

// Per-surface grip multipliers (SPEC table; 'rock' not listed -> 0.85 chosen
// between metal .9 and dirt .75 since cliff shelves should feel a bit loose).
export const SURFACE_GRIP = {
  asphalt: 1.0,
  wood: 0.95,
  metal: 0.9,
  dirt: 0.75,
  sand: 0.6,
  water: 0.5,
  rock: 0.85,
};

export const T = {
  // -------------------------------------------------- chassis / rigid body
  MASS: 1350,                    // kg — light supercar; snappy but plantable
  INV_MASS: 1 / 1350,
  // Diagonal inertia (local: x=right/pitch, y=up/yaw, z=back/roll).
  // Roll is kept low so weight transfer READS instantly in corners.
  IX: 2400, IY: 2700, IZ: 650,
  HALF_L: 2.35,                  // collision half-length (car ~4.7 m w/ bumpers)
  HALF_W: 0.98,                  // collision half-width
  HALF_H: 0.60,                  // collision half-height (for vertical sweeps)
  GRAVITY: 9.81,
  VEL_CAP: 85,                   // hard sanity cap (m/s) — never exceed physics budget

  // -------------------------------------------------- suspension geometry
  WHEEL_R: 0.34,
  WHEELBASE: 2.7,
  TRACK_HALF: 0.81,              // half track width (1.62 m)
  HP_Y: -0.05,                   // hardpoint below COM -> rest ride ~0.62 m COM height
  TRAVEL: 0.35,                  // SPEC: ~0.35 m usable travel
  RAY_LEN: 0.35 + 0.34,          // travel + wheel radius
  RIDE_HEIGHT: 0.62,             // COM above ground at static rest (respawn settle)

  // -------------------------------------------------- springs & dampers
  // k chosen so static compression ~0.12 m (35% travel) -> 1.4 Hz heave:
  // sporty, visible squat/dive, never floaty.
  SPRING: 27000,                 // N/m per corner
  DAMP_C: 3300,                  // N per m/s compression (~0.55 critical) — soaks bumps
  DAMP_R: 4600,                  // N per m/s rebound (~0.75 critical) — kills float
  BUMP_K: 260000,                // bottom-out bump-stop stiffness (landing CRUNCH)
  MAX_LOAD: 22000,               // per-wheel load cap — high enough to catch big-jump
                                 //   landings (~7 g total), low enough to never launch
  FLOOR_COMP: 1.25,              // compression beyond this = chassis eject (hard floor)
  FLOOR_PUSH_CAP: 0.25,          // max positional ejection per step
  STATIC_LOAD: 1350 * 9.81 / 4,  // ~3311 N reference

  // Tire forces are applied this far above the contact point ("roll center"):
  // lever to COM ~0.28 m -> ~4-5 deg visible roll at 1.5 g, no arcade flipping.
  FORCE_LIFT: 0.34,

  // -------------------------------------------------- tires (Pacejka-lite)
  // F = sin(C * atan(B*slip)); peak ~13 deg then falls to ~0.7 — the falloff
  // IS the drift: past peak the rear washes gently instead of snapping.
  TIRE_B: 7.5,
  TIRE_C: 1.5,
  MU_LAT: 2.05,                  // arcade-high lateral grip (~2 g flat cornering)
  MU_LONG: 2.1,
  FRONT_LAT: 0.94,               // front slightly softer than rear ->
  REAR_LAT: 1.08,                //   mild understeer at limit = keyboard-safe
  HB_REAR_LAT: 0.32,             // handbrake guts rear lateral grip -> instant rotation
  DRIFT_REAR_LOOSE: 0.20,        // sustained drift keeps rear this much looser...
  DRIFT_THROTTLE_LOOSE: 0.21,    // ...plus this much more under power (power-over)
  LOWSPEED_BLEND: 4.0,           // below this speed lat force goes viscous (no jitter)

  // -------------------------------------------------- engine / drivetrain
  // Base force * gear ratio at the wheels. Gear 1: ~14 kN -> 0-100 ~3.4-3.6 s.
  // Gear 6 at ~4.1 kN balances drag at ~64 m/s = 230 km/h.
  ENGINE_FORCE: 4600,
  GEAR_RATIOS: [3.4, 2.6, 2.0, 1.58, 1.25, 1.0],
  RPM_SPEED: 68,                 // fwd speed (m/s) at rpm=1.0 in 6th
  RPM_IDLE: 0.14,
  SHIFT_TIME: 0.20,              // torque-cut window; rpm dip is audible
  SHIFT_UP_RPM: 0.96,
  SHIFT_DOWN_RPM: 0.42,
  DRIVE_FRONT: 0.36,             // AWD-ish split — clean keyboard launches,
  DRIVE_REAR: 0.64,              //   rear-biased so power still rotates the car
  REVERSE_FORCE: 4800,
  REVERSE_TOP: 11,

  // -------------------------------------------------- brakes
  // 13.1 kN total ~= 9.7 m/s^2 -> 100-0 in ~38 m (SPEC, harness-verified).
  BRAKE_FORCE: 13100,
  BRAKE_FRONT: 0.58,
  HB_BRAKE: 7000,                // extra rear brake while handbrake held

  // -------------------------------------------------- aero
  DRAG_Q: 0.87,                  // N per (m/s)^2 — sets top speed vs engine
  DRAG_LIN: 12,                  // rolling resistance N per m/s
  DOWNFORCE: 3.6,                // N per (m/s)^2 along -chassisUp when grounded
  DOWNFORCE_CAP: 16000,          //   ~1.2 g extra at 230 km/h -> planted + loop-capable
  WATER_DRAG: 55,                // N per m/s per submerged wheel (ford bog-down)

  // -------------------------------------------------- steering & assists
  STEER_MAX: 0.55,               // rad at standstill
  STEER_FADE: 24,                // speed (m/s) where authority halves-ish
  STEER_FADE_POW: 1.7,
  STEER_SLEW: 10,                // wheel angle chase rate (1/s)
  STEER_DRIFT_WIDEN: 0.9,        // +90% steering range while drifting (countersteer room)
  CS_GAIN: 0.48,                 // auto-countersteer: keyboard drifts hold themselves
  YAW_ASSIST: 1600,              // Nm per rad/s yaw-rate error vs commanded (gentle)
  YAW_ASSIST_CAP: 3500,
  LAT_ASSIST: 0.35,              // 1/s lateral-velocity bleed when NOT drifting

  // -------------------------------------------------- angular damping (1/s)
  DAMP_ROLL: 5.0,
  DAMP_PITCH: 3.5,
  DAMP_YAW: 0.8,
  DAMP_AIR: 1.6,

  // -------------------------------------------------- airborne authority
  AIR_PITCH: 2600,               // Nm from throttle/brake (throttle = nose up)
  AIR_YAW: 1800,                 // Nm from steer
  AIR_LEVEL: 2800,               // auto-level spring toward world-up
  JUMP_SPEED_MIN: 15,            // SPEC: car:jump only on fast ramp launches
  JUMP_VY_MIN: 2.5,
  LAND_MIN_AIR: 0.2,             // s of air before car:landed fires
  LAND_ABSORB: 0.35,             // fraction of normal impact velocity eaten (crunch, no bounce)

  // -------------------------------------------------- loop adhesion
  ADH_SPEED_LO: 12,              // below: full gravity (crawling car falls off loop)
  ADH_SPEED_HI: 24,              // above: full blend toward -surfaceNormal
  ADH_STEEP: 1.6,                // steepness ramp: (1 - n.y) * this
  ADH_EXTRA_G: 0.25,             // adhesion presses 25% harder than gravity

  // -------------------------------------------------- walls
  WALL_SKIN: 0.06,
  WALL_MARGIN: 0.35,             // ring ray overshoot
  WALL_REST: 0.22,               // restitution — thud, not trampoline
  WALL_PUSH_CAP: 0.30,           // max push-out per step (no pops)
  WALL_SPIN: 0.35,               // fraction of impulse converted to spin (glancing hits rotate)
  WALL_GROUND_DOT: 0.55,         // |normal . chassisUp| above this = floor, not wall
  BUMPER_Y: -0.18,               // ring ray height (local) ~0.44 m above ground
  COLLISION_EVENT_SPEED: 5,      // SPEC: car:collision only > 5 m/s
  COLLISION_COOLDOWN: 0.2,

  // -------------------------------------------------- boost (nitrous)
  BOOST_DRAIN: 0.25,             // /s while held (SPEC)
  BOOST_FORCE_MUL: 1.45,         // +45% engine force (SPEC)
  BOOST_THRUST: 1500,            // small direct shove so boost works off-throttle too
  BOOST_REFILL_DRIFT: 0.09,      // /s at full drift intensity (SPEC ~0.06 scaled)
  BOOST_REFILL_AIR: 0.08,        // /s while airborne
  BOOST_MIN_START: 0.1,          // hysteresis: don't sputter on an empty tank

  // -------------------------------------------------- drift detection & score
  DRIFT_ENTER: 0.24,             // rad body slip to start (~14 deg)
  DRIFT_ENTER_HB: 0.15,          // easier entry with handbrake
  DRIFT_EXIT: 0.13,
  DRIFT_MIN_SPEED: 7.5,
  DRIFT_GRACE: 0.4,              // s of slack before drift:end (chained transitions)
  DRIFT_PTS: 3.2,                // pts/s = kmh * (0.4 + deg/28) * this  (~500-700/s mid-drift)
};
