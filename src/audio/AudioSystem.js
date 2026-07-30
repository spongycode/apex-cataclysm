// APEX: CATACLYSM CANYON — AudioSystem (SPEC section 6).
// 100% WebAudio synthesis. The AudioContext is created/resumed in unlock() (first
// user gesture, called by main.js); before that every method no-ops safely.
//
// Mix architecture:
//   engine (saws+pulse -> waveshaper -> formants, + sub, + AM lope)  ─┐
//   turbo whine / boost rocket / beds (wind, roar, skid, gravel, rain)├─> mix -> comp -> limiter -> mute -> out
//   one-shot SFX bus / music bed                                     ─┘
//   engine also feeds a convolver send (mine-tunnel reverb, progress 0.55–0.64)

import { MusicBed } from './music.js';
import * as SFX from './sfx.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// audio:sfx name -> internal voice. Generous aliases so other systems can be loose.
const SFX_ALIAS = {
  collision: 'collision', crash: 'collision', impact: 'collision', hit: 'collision', scrape: 'collision',
  prop_sign: 'prop_metal', prop_barrel: 'prop_metal', prop_metal: 'prop_metal', metal: 'prop_metal',
  prop_cone: 'prop_plastic', prop_plastic: 'prop_plastic', plastic: 'prop_plastic',
  prop_crate: 'prop_wood', prop_fence: 'prop_wood', prop_wood: 'prop_wood', wood: 'prop_wood',
  prop: 'prop_wood', break: 'prop_wood', debris: 'prop_wood',
  whoosh: 'whoosh', jump: 'whoosh', air: 'whoosh', wind: 'whoosh',
  thud: 'thud', land: 'thud', landing: 'thud',
  checkpoint: 'checkpoint', chime: 'checkpoint', split: 'checkpoint', pickup: 'checkpoint',
  beep: 'beep', countdown: 'beep', tick: 'beep',
  go: 'go', start: 'go', blast: 'go',
  explosion: 'explosion', boom: 'explosion', explode: 'explosion',
  rockslide: 'rockslide', rumble: 'rockslide', avalanche: 'rockslide',
  collapse: 'collapse', crumble: 'collapse',
  thunder: 'thunder',
  fanfare: 'fanfare', finish: 'fanfare', win: 'fanfare', victory: 'fanfare',
  zing: 'zing', drift: 'zing', score: 'zing',
  splash: 'splash', water: 'splash',
  boost_ignite: 'boost_ignite', boost: 'boost_ignite', nitro: 'boost_ignite',
  spark: 'spark', sparks: 'spark',
  click: 'click', ui: 'click', blip: 'click',
};

export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.ac = null;
    this.music = null;
    this.bufs = null;
    this.e = null; // engine node bag

    // Smoothed control signals (JS-side, zero-alloc).
    this._rpmSm = 0;
    this._loadSm = 0;
    this._boostSm = 0;
    this._turbo = 0;
    this._prevThrottle = 0;
    this._crackle = 0;
    this._lastGear = 1;
    this._shiftDip = 0;
    this._skidSm = 0;
    this._windSm = 0;
    this._roarSm = 0;
    this._tunnelSm = 0;
    this._resumeTimer = 0;
    this._lastSfxAt = Object.create(null);
    this._errCount = 0;
  }

  async init() {
    // No AudioContext yet (autoplay policy) — just wire events. Every handler
    // funnels through _sfx/_thunder which no-op until unlock().
    const ev = this.ctx.events;
    ev.on('audio:sfx', (p) => { if (p && p.name) this._sfx(String(p.name), p); });
    ev.on('car:collision', (p) => this._sfx('collision', { speed: p && p.speed != null ? p.speed : 12, position: p && p.point }));
    ev.on('prop:break', (p) => this._sfx('prop_' + ((p && p.type) || 'crate'), { position: p && p.position }));
    ev.on('car:jump', (p) => {
      const s = (p && p.speed) || 0;
      if (s > 15) this._sfx('whoosh', { volume: clamp((s - 12) / 45, 0.35, 1) });
    });
    ev.on('car:landed', (p) => {
      const imp = (p && p.impactSpeed) || 0;
      if (imp > 3) this._sfx('thud', { impact: imp });
    });
    ev.on('race:checkpoint', () => this._sfx('checkpoint', {}));
    ev.on('race:countdown', (p) => this._sfx(p && p.n === 0 ? 'go' : 'beep', {}));
    ev.on('race:finish', () => { this._sfx('fanfare', {}); this._duck(0.35, 3.5); });
    ev.on('drift:end', (p) => {
      const s = (p && p.score) || 0;
      if (s > 300) this._sfx('zing', { score: s });
    });
    ev.on('boost:start', () => this._sfx('boost_ignite', { volume: 0.8 }));
    ev.on('setpiece:explosion', (p) => {
      this._sfx('explosion', { position: p && p.position, radius: (p && p.radius) || 12 });
      this._duck(0.45, 2.0);
    });
    ev.on('setpiece:collapse', (p) => this._sfx('collapse', { position: p && p.position }));
    ev.on('setpiece:rockslide', (p) => {
      this._sfx('rockslide', { position: p && p.position });
      this._duck(0.6, 1.5);
    });
    ev.on('weather:lightning', (p) => this._thunder((p && p.intensity) != null ? p.intensity : 0.7));
  }

  /** Called by main.js on the first Enter press (user gesture). Idempotent. */
  unlock() {
    if (this.ready) {
      if (this.ac && this.ac.state === 'suspended') this.ac.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC({ latencyHint: 'interactive' });
      if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
      this._build();
      this.music.start();
      this.ready = true;
    } catch (err) {
      // Audio is a luxury: the game must keep running silent.
      console.warn('[AudioSystem] unlock failed', err);
      this.ready = false;
      this.ac = null;
    }
  }

  // ------------------------------------------------------------------ build

  _build() {
    const ac = this.ac;

    // --- Noise sources (shared buffers) ---
    const white = ac.createBuffer(2, ac.sampleRate * 2, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = white.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const brown = ac.createBuffer(2, ac.sampleRate * 2, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = brown.getChannelData(ch);
      let v = 0, peak = 0;
      for (let i = 0; i < d.length; i++) {
        v = (v + (Math.random() * 2 - 1) * 0.02) / 1.02;
        d[i] = v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const norm = peak > 0 ? 1 / peak : 1;
      for (let i = 0; i < d.length; i++) d[i] *= norm * 0.9;
    }
    this.bufs = { white, brown };

    // --- Master chain: mix -> comp -> limiter -> mute -> out ---
    this.mix = ac.createGain();
    this.mix.gain.value = 1;
    this.comp = ac.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.limiter = ac.createDynamicsCompressor(); // brickwall-ish safety
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.09;
    this.muteGain = ac.createGain();
    this.muteGain.gain.value = this.ctx.state.settings.mute ? 0 : 1;
    this.outGain = ac.createGain();
    this.outGain.gain.value = 0.85; // headroom
    this.mix.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.muteGain);
    this.muteGain.connect(this.outGain);
    this.outGain.connect(ac.destination);

    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.mix);

    // --- Engine: the hero -------------------------------------------------
    const e = (this.e = {});
    e.out = ac.createGain();
    e.out.gain.value = 0;
    e.out.connect(this.mix);

    // Tone stack: 2 detuned saws + pulse -> drive -> waveshaper.
    e.sawA = SFX.osc(ac, 'sawtooth', 60);
    e.sawB = SFX.osc(ac, 'sawtooth', 60.6);
    e.pulse = SFX.osc(ac, 'square', 120);
    e.sub = SFX.osc(ac, 'sine', 30);
    const gA = ac.createGain(); gA.gain.value = 0.3;
    const gB = ac.createGain(); gB.gain.value = 0.3;
    const gP = ac.createGain(); gP.gain.value = 0.15;
    e.drive = ac.createGain();
    e.drive.gain.value = 0.6;
    e.shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(2.8 * x) * (1 + 0.12 * Math.sin(6 * x)); // asymmetric growl
    }
    e.shaper.curve = curve;
    e.shaper.oversample = '2x';
    e.sawA.connect(gA).connect(e.drive);
    e.sawB.connect(gB).connect(e.drive);
    e.pulse.connect(gP).connect(e.drive);
    e.drive.connect(e.shaper);

    // Two resonant formants + a fixed low "body" path out of the shaper.
    e.formant1 = SFX.filt(ac, 'bandpass', 300, 1.5);
    e.formant2 = SFX.filt(ac, 'bandpass', 900, 2.4);
    e.body = SFX.filt(ac, 'lowpass', 250, 0.7);
    const f1g = ac.createGain(); f1g.gain.value = 0.85;
    const f2g = ac.createGain(); f2g.gain.value = 0.5;
    const bodyG = ac.createGain(); bodyG.gain.value = 0.55;
    e.shaper.connect(e.formant1).connect(f1g).connect(e.out);
    e.shaper.connect(e.formant2).connect(f2g).connect(e.out);
    e.shaper.connect(e.body).connect(bodyG).connect(e.out);

    // Clean sub sine straight to output (throat, not mud).
    e.subGain = ac.createGain();
    e.subGain.gain.value = 0.3;
    e.sub.connect(e.subGain).connect(e.out);

    // Cylinder-firing amplitude lope (strong at idle, fades at high rpm).
    e.lfo = SFX.osc(ac, 'sine', 30);
    e.lfoDepth = ac.createGain();
    e.lfoDepth.gain.value = 0.12;
    e.lfo.connect(e.lfoDepth).connect(e.out.gain);

    e.sawA.start(); e.sawB.start(); e.pulse.start(); e.sub.start(); e.lfo.start();

    // Turbo whine: airy high sine pair.
    e.turbo = SFX.osc(ac, 'sine', 1200);
    e.turboH = SFX.osc(ac, 'sine', 2412);
    e.turboGain = ac.createGain();
    e.turboGain.gain.value = 0;
    const tHG = ac.createGain(); tHG.gain.value = 0.35;
    e.turbo.connect(e.turboGain);
    e.turboH.connect(tHG).connect(e.turboGain);
    e.turboGain.connect(this.mix);
    e.turbo.start(); e.turboH.start();

    // Boost rocket layer: roaring filtered noise.
    e.rocketSrc = SFX.noiseSrc(ac, white, 1);
    e.rocketLP = SFX.filt(ac, 'lowpass', 780, 0.8);
    e.rocketGain = ac.createGain();
    e.rocketGain.gain.value = 0;
    e.rocketSrc.connect(e.rocketLP).connect(e.rocketGain).connect(this.mix);
    e.rocketSrc.start();

    // Mine-tunnel reverb: engine send -> convolver (procedural IR) -> colored return.
    const irLen = Math.floor(ac.sampleRate * 1.7);
    const ir = ac.createBuffer(2, irLen, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const k = 1 - i / irLen;
        d[i] = (Math.random() * 2 - 1) * k * k * k;
      }
    }
    e.tunnelSend = ac.createGain();
    e.tunnelSend.gain.value = 0;
    e.conv = ac.createConvolver();
    e.conv.buffer = ir;
    const convColor = SFX.filt(ac, 'lowpass', 2000, 0.7);
    const convGain = ac.createGain();
    convGain.gain.value = 0.8;
    e.out.connect(e.tunnelSend);
    e.tunnelSend.connect(e.conv);
    e.conv.connect(convColor).connect(convGain).connect(this.mix);

    // --- Beds -------------------------------------------------------------
    const b = (this.b = {});

    // Wind: two decorrelated noise channels, hard-ish panned for width.
    b.windGain = ac.createGain();
    b.windGain.gain.value = 0;
    b.windGain.connect(this.mix);
    b.windLP = [];
    const windPan = [-0.65, 0.65];
    const windRate = [0.93, 1.07];
    for (let i = 0; i < 2; i++) {
      const src = SFX.noiseSrc(ac, white, windRate[i]);
      const lp = SFX.filt(ac, 'lowpass', 400, 0.6);
      const pan = ac.createStereoPanner();
      pan.pan.value = windPan[i];
      src.connect(lp).connect(pan).connect(b.windGain);
      src.start();
      b.windLP.push(lp);
    }

    // Tire roar: one retunable noise voice.
    b.roarSrc = SFX.noiseSrc(ac, brown, 1);
    b.roarFilt = SFX.filt(ac, 'bandpass', 420, 0.8);
    b.roarGain = ac.createGain();
    b.roarGain.gain.value = 0;
    b.roarSrc.connect(b.roarFilt).connect(b.roarGain).connect(this.mix);
    b.roarSrc.start();

    // Skid squeal: resonant noise + wavering tone (asphalt only).
    b.skidGain = ac.createGain();
    b.skidGain.gain.value = 0;
    b.skidGain.connect(this.mix);
    b.skidNoise = SFX.noiseSrc(ac, white, 1);
    b.skidBP = SFX.filt(ac, 'bandpass', 950, 7);
    const skNG = ac.createGain(); skNG.gain.value = 0.6;
    b.skidNoise.connect(b.skidBP).connect(skNG).connect(b.skidGain);
    b.skidNoise.start();
    b.skidTone = SFX.osc(ac, 'triangle', 620);
    const skTG = ac.createGain(); skTG.gain.value = 0.4;
    b.skidTone.connect(skTG).connect(b.skidGain);
    b.skidTone.start();

    // Gravel patter (dirt/sand): bright noise, gain jittered per frame.
    b.gravelSrc = SFX.noiseSrc(ac, white, 1.7);
    b.gravelBP = SFX.filt(ac, 'bandpass', 2600, 1.1);
    b.gravelGain = ac.createGain();
    b.gravelGain.gain.value = 0;
    b.gravelSrc.connect(b.gravelBP).connect(b.gravelGain).connect(this.mix);
    b.gravelSrc.start();

    // Rain bed: hissy top + soft low wash.
    b.rainSrc = SFX.noiseSrc(ac, white, 1.4);
    b.rainBP = SFX.filt(ac, 'bandpass', 5200, 0.5);
    b.rainGain = ac.createGain();
    b.rainGain.gain.value = 0;
    b.rainSrc.connect(b.rainBP).connect(b.rainGain).connect(this.mix);
    b.rainSrc.start();
    b.rainLowSrc = SFX.noiseSrc(ac, brown, 1.1);
    b.rainLowLP = SFX.filt(ac, 'lowpass', 300, 0.6);
    b.rainLowGain = ac.createGain();
    b.rainLowGain.gain.value = 0;
    b.rainLowSrc.connect(b.rainLowLP).connect(b.rainLowGain).connect(this.mix);
    b.rainLowSrc.start();

    // --- Music bed ---
    this.music = new MusicBed(ac, this.mix);
  }

  // ------------------------------------------------------------------ update

  update(dt, time) {
    if (!this.ready || !this.ac) return;
    try {
      this._updateInner(dt, time);
    } catch (err) {
      // Never let audio kill a frame. Log at most 3 times, then go quiet.
      if (this._errCount < 3) {
        this._errCount++;
        console.warn('[AudioSystem] update error', err);
      }
    }
  }

  _updateInner(dt, time) {
    const ac = this.ac;
    const st = this.ctx.state;
    const car = st.car;
    if (!car) return;

    // Occasionally retry resume if the context is stuck suspended.
    this._resumeTimer -= dt;
    if (ac.state === 'suspended' && this._resumeTimer <= 0) {
      this._resumeTimer = 1;
      ac.resume().catch(() => {});
    }

    // Mute (M key) — quick smooth fade, no clicks.
    const muteTgt = st.settings.mute ? 0 : 1;
    this.muteGain.gain.value += (muteTgt - this.muteGain.gain.value) * Math.min(1, 14 * dt);

    // ---------- control signals ----------
    const rpm = clamp01(car.rpm || 0);
    const thr = clamp01(car.throttle || 0);
    this._rpmSm += (rpm - this._rpmSm) * Math.min(1, 20 * dt);
    this._loadSm += (thr - this._loadSm) * Math.min(1, 7 * dt);
    const boostTgt = car.boosting ? 1 : 0;
    this._boostSm += (boostTgt - this._boostSm) * Math.min(1, 6 * dt);
    if (car.gear !== this._lastGear) {
      this._shiftDip = 1;
      this._lastGear = car.gear;
    }
    this._shiftDip = Math.max(0, this._shiftDip - dt * 7);
    const speed = Math.max(0, (car.speedKmh || 0) / 3.6);

    // ---------- engine ----------
    const e = this.e;
    // Fundamental stays 60–400 Hz: throaty, never mosquito.
    const f = (60 + 325 * Math.pow(this._rpmSm, 1.18)) * (1 + 0.045 * this._boostSm);
    e.sawA.frequency.value = f;
    e.sawB.frequency.value = f * 1.011;
    e.sawB.detune.value = 6 + (car.gear || 1) * 2; // gear flavors the beat frequency
    e.pulse.frequency.value = f * 2.005;
    e.sub.frequency.value = f * 0.5;
    e.lfo.frequency.value = Math.max(9, f * 0.5); // firing-rate lope
    e.lfoDepth.gain.value = 0.15 * (1 - 0.78 * this._rpmSm);
    e.drive.gain.value = 0.5 + 1.05 * this._loadSm + 0.35 * this._boostSm;
    e.formant1.frequency.value = 200 + 620 * this._rpmSm + 190 * this._loadSm;
    e.formant2.frequency.value = 760 + 2050 * this._rpmSm + 680 * this._loadSm;
    e.subGain.gain.value = 0.24 + 0.14 * this._loadSm;
    const dip = 1 - 0.55 * clamp01(this._shiftDip); // audible shift dips
    e.out.gain.value = (0.17 + 0.33 * this._loadSm + 0.1 * this._rpmSm + 0.1 * this._boostSm) * dip;

    // Turbo: spools with rpm·throttle, whines, blows off on lift.
    const spool = rpm * thr;
    this._turbo += (spool - this._turbo) * Math.min(1, (spool > this._turbo ? 2.4 : 5.5) * dt);
    e.turbo.frequency.value = 1150 + 5200 * this._turbo + 1400 * this._rpmSm;
    e.turboH.frequency.value = e.turbo.frequency.value * 2.01;
    e.turboGain.gain.value = 0.045 * this._turbo * (0.4 + 0.6 * this._rpmSm);

    // Lift-off: blow-off pshh + exhaust crackle window.
    if (this._prevThrottle > 0.55 && thr < 0.15) {
      if (this._turbo > 0.4) {
        SFX.blowoff(ac, this.sfxBus, this.bufs, { vol: 0.5 + 0.6 * this._turbo });
        this._turbo *= 0.25;
      }
      if (rpm > 0.5) this._crackle = 0.9;
    }
    this._prevThrottle = thr;
    if (this._crackle > 0) {
      this._crackle -= dt;
      if (Math.random() < dt * (9 + 15 * this._rpmSm) * clamp01(this._crackle * 1.6)) {
        SFX.cracklePop(ac, this.sfxBus, this.bufs, { vol: 0.9 });
      }
    }

    // Boost rocket layer.
    e.rocketGain.gain.value = 0.3 * this._boostSm;
    e.rocketLP.frequency.value = 700 + 600 * this._boostSm;

    // Tunnel reverb send — wet only through progress 0.55–0.64, smoothed.
    const p = st.progress || 0;
    const tunnelTgt = smoothstep(0.548, 0.565, p) * (1 - smoothstep(0.63, 0.648, p));
    this._tunnelSm += (tunnelTgt - this._tunnelSm) * Math.min(1, 3 * dt);
    e.tunnelSend.gain.value = 0.9 * this._tunnelSm;

    // ---------- beds ----------
    const b = this.b;
    const spd01 = clamp01(speed / 75);

    // Wind ∝ speed.
    const windTgt = Math.pow(spd01, 1.6) * 0.42 * (1 + 0.3 * this._boostSm);
    this._windSm += (windTgt - this._windSm) * Math.min(1, 5 * dt);
    b.windGain.gain.value = this._windSm;
    const wf = 350 + speed * 34;
    b.windLP[0].frequency.value = wf;
    b.windLP[1].frequency.value = wf * 1.18;

    // Tire roar by surface (grounded only).
    const surf = car.surface || 'asphalt';
    const grounded = !!car.grounded;
    let roarFreq = 480, roarQ = 0.8, roarLvl = 0.1;
    if (surf === 'dirt') { roarFreq = 270; roarQ = 0.7; roarLvl = 0.2; }
    else if (surf === 'sand') { roarFreq = 220; roarQ = 0.7; roarLvl = 0.22; }
    else if (surf === 'wood') { roarFreq = 240; roarQ = 1.2; roarLvl = 0.17; }
    else if (surf === 'metal') { roarFreq = 760; roarQ = 1.4; roarLvl = 0.14; }
    else if (surf === 'water') { roarFreq = 1500; roarQ = 0.5; roarLvl = 0.34; }
    else if (surf === 'rock') { roarFreq = 330; roarQ = 0.8; roarLvl = 0.16; }
    const roarTgt = grounded ? clamp01(speed / 55) * roarLvl : 0;
    this._roarSm += (roarTgt - this._roarSm) * Math.min(1, 8 * dt);
    b.roarGain.gain.value = this._roarSm;
    b.roarFilt.frequency.value = roarFreq * (0.85 + 0.45 * spd01);
    b.roarFilt.Q.value = roarQ;

    // Max wheel slip (defensive: wheels may be absent for a frame).
    let maxSlip = 0;
    const wheels = car.wheels;
    if (wheels && wheels.length) {
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (w && w.contact && w.slip > maxSlip) maxSlip = w.slip;
      }
    }

    // Skid squeal: asphalt only, needs speed.
    const skidTgt = (surf === 'asphalt' && grounded && speed > 7)
      ? clamp01((maxSlip - 0.4) * 2.2) * 0.34
      : 0;
    this._skidSm += (skidTgt - this._skidSm) * Math.min(1, (skidTgt > this._skidSm ? 18 : 9) * dt);
    b.skidGain.gain.value = this._skidSm;
    if (this._skidSm > 0.005) {
      const wob = Math.sin(time * 31) * 40 + Math.sin(time * 7.3) * 25;
      b.skidTone.frequency.value = 540 + maxSlip * 260 + wob;
      b.skidBP.frequency.value = 900 + maxSlip * 500 + wob * 2;
    }

    // Gravel patter on loose surfaces — per-frame gain jitter = crunch.
    if ((surf === 'dirt' || surf === 'sand') && grounded && speed > 3) {
      const base = clamp01(speed / 45) * 0.16;
      b.gravelGain.gain.value = base * (0.3 + Math.random() * 0.9);
    } else {
      b.gravelGain.gain.value += (0 - b.gravelGain.gain.value) * Math.min(1, 10 * dt);
    }

    // Rain bed ∝ weather.rain.
    const rain = st.weather ? clamp01(st.weather.rain || 0) : 0;
    const inTunnel = this._tunnelSm > 0.5; // sheltered: rain fades inside
    const rainAmt = rain * (inTunnel ? 0.25 : 1);
    b.rainGain.gain.value += (rainAmt * 0.13 - b.rainGain.gain.value) * Math.min(1, 2 * dt);
    b.rainLowGain.gain.value += (rainAmt * 0.09 - b.rainLowGain.gain.value) * Math.min(1, 2 * dt);

    // ---------- music ----------
    const phase = st.phase;
    let musicLvl = 0;
    if (phase === 'menu') musicLvl = 0.5;
    else if (phase === 'countdown' || phase === 'racing') musicLvl = 0.3;
    this.music.setLevel(musicLvl);
    this.music.update(dt);
  }

  // ------------------------------------------------------------------ one-shots

  _duck(amount, hold) {
    if (this.ready && this.music) this.music.duck(amount, hold);
  }

  _thunder(intensity) {
    if (!this.ready) return;
    // Distance feel: strong strikes are close (short delay, loud).
    const inten = clamp01(intensity);
    const delay = 0.4 + (1 - inten) * 0.8;
    SFX.thunder(this.ac, this.sfxBus, this.bufs, {
      intensity: inten,
      at: this.ac.currentTime + delay,
    });
  }

  _sfx(name, p) {
    if (!this.ready) return;
    const key = SFX_ALIAS[name] || SFX_ALIAS[name.toLowerCase()] || null;
    if (!key) return;

    // Rate-limit identical voices (prop chains, multi-collision frames).
    const now = this.ac.currentTime;
    const last = this._lastSfxAt[key] || -1;
    if (now - last < 0.045) return;
    this._lastSfxAt[key] = now;

    // Distance attenuation when a world position is provided.
    let vol = p && p.volume != null ? p.volume : 1;
    const carPos = this.ctx.state.car && this.ctx.state.car.position;
    if (p && p.position && carPos && typeof p.position.x === 'number') {
      const dx = carPos.x - p.position.x;
      const dy = carPos.y - p.position.y;
      const dz = carPos.z - p.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      vol *= clamp(1 - d / 220, 0.15, 1);
    }

    const ac = this.ac, out = this.sfxBus, bufs = this.bufs;
    switch (key) {
      case 'collision': SFX.collision(ac, out, bufs, { speed: p && p.speed, vol }); break;
      case 'prop_wood': SFX.propWood(ac, out, bufs, { vol }); break;
      case 'prop_metal': SFX.propMetal(ac, out, bufs, { vol }); break;
      case 'prop_plastic': SFX.propPlastic(ac, out, bufs, { vol }); break;
      case 'whoosh': SFX.whoosh(ac, out, bufs, { vol }); break;
      case 'thud': SFX.thud(ac, out, bufs, { impact: p && p.impact, vol }); break;
      case 'checkpoint': SFX.checkpoint(ac, out, bufs, { vol }); break;
      case 'beep': SFX.beep(ac, out, bufs, { vol }); break;
      case 'go': SFX.goBlast(ac, out, bufs, { vol }); break;
      case 'explosion': SFX.explosion(ac, out, bufs, { radius: p && p.radius, vol }); break;
      case 'rockslide': SFX.rockslide(ac, out, bufs, { vol }); break;
      case 'collapse': SFX.rockslide(ac, out, bufs, { vol: vol * 0.7, dur: 1.3 }); break;
      case 'thunder': SFX.thunder(ac, out, bufs, { intensity: (p && p.intensity) || 0.7, vol }); break;
      case 'fanfare': SFX.fanfare(ac, out, bufs, { vol }); break;
      case 'zing': SFX.zing(ac, out, bufs, { score: p && p.score, vol }); break;
      case 'splash': SFX.splash(ac, out, bufs, { vol }); break;
      case 'boost_ignite': SFX.boostIgnite(ac, out, bufs, { vol }); break;
      case 'spark': SFX.spark(ac, out, bufs, { vol }); break;
      case 'click': SFX.click(ac, out, bufs, { vol }); break;
    }
  }
}
