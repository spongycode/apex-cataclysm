// APEX: CATACLYSM CANYON — one-shot SFX synthesis library.
// Every effect is pure WebAudio synthesis: oscillators + filtered noise, no samples.
// Every function signature: fn(ac, out, bufs, opts) where bufs = { white, brown } AudioBuffers.
// All voices self-clean: a silent ConstantSource timer disconnects the voice bus when done.

const MIN = 0.0001;

/** Voice bus that auto-disconnects `dur` seconds after `when`. */
export function voiceBus(ac, out, when, dur) {
  const g = ac.createGain();
  g.connect(out);
  const timer = ac.createConstantSource();
  timer.offset.value = 0; // silent
  timer.connect(g);
  timer.start(when);
  timer.stop(when + dur);
  timer.onended = () => {
    try { g.disconnect(); } catch (_) { /* already gone */ }
  };
  return g;
}

export function osc(ac, type, freq) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

export function noiseSrc(ac, buf, rate = 1) {
  const s = ac.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.loopEnd = buf.duration;
  s.playbackRate.value = rate;
  return s;
}

export function filt(ac, type, freq, Q = 1) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

/** Attack to peak then exponential decay. */
function env(gain, t, a, peak, d, end = MIN) {
  gain.gain.setValueAtTime(MIN, t);
  gain.gain.linearRampToValueAtTime(Math.max(MIN, peak), t + a);
  gain.gain.exponentialRampToValueAtTime(Math.max(MIN, end), t + a + d);
}

// ---------------------------------------------------------------- collisions

export function collision(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const amp = Math.min(1, Math.max(0.12, (o.speed ?? 12) / 42)) * (o.vol ?? 1);
  const bus = voiceBus(ac, out, t, 0.9);

  // Sub thump — body of the impact.
  const sub = osc(ac, 'sine', 78);
  sub.frequency.exponentialRampToValueAtTime(36, t + 0.22);
  const sg = ac.createGain();
  env(sg, t, 0.005, 0.75 * amp, 0.26);
  sub.connect(sg).connect(bus);
  sub.start(t); sub.stop(t + 0.35);

  // Crunch — noise burst, lowpass sweeps shut.
  const n = noiseSrc(ac, bufs.white, 0.9);
  const lp = filt(ac, 'lowpass', 2400, 0.8);
  lp.frequency.exponentialRampToValueAtTime(220, t + 0.3);
  const ng = ac.createGain();
  env(ng, t, 0.004, 0.8 * amp, 0.3);
  n.connect(lp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.4);

  // Metallic ring for harder hits.
  if ((o.speed ?? 0) > 16) {
    for (let i = 0; i < 2; i++) {
      const f = [812, 1274][i] * (0.94 + Math.random() * 0.12);
      const ring = osc(ac, 'triangle', f);
      const rg = ac.createGain();
      env(rg, t + 0.01, 0.006, 0.1 * amp, 0.45);
      ring.connect(rg).connect(bus);
      ring.start(t); ring.stop(t + 0.6);
    }
  }
}

// ---------------------------------------------------------------- prop breaks

export function propWood(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.7);
  // Sharp crack.
  const n = noiseSrc(ac, bufs.white, 1.2);
  const bp = filt(ac, 'bandpass', 950, 1.1);
  const ng = ac.createGain();
  env(ng, t, 0.002, 0.5 * vol, 0.13);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.2);
  // Low knock.
  const k = osc(ac, 'sine', 150);
  k.frequency.exponentialRampToValueAtTime(85, t + 0.12);
  const kg = ac.createGain();
  env(kg, t, 0.003, 0.4 * vol, 0.16);
  k.connect(kg).connect(bus);
  k.start(t); k.stop(t + 0.25);
  // Splinter tails.
  for (let i = 0; i < 3; i++) {
    const dt2 = 0.04 + Math.random() * 0.12;
    const s = noiseSrc(ac, bufs.white, 1.6);
    const sf = filt(ac, 'bandpass', 1600 + Math.random() * 1400, 3);
    const sg = ac.createGain();
    env(sg, t + dt2, 0.002, 0.12 * vol, 0.07);
    s.connect(sf).connect(sg).connect(bus);
    s.start(t + dt2); s.stop(t + dt2 + 0.12);
  }
}

export function propMetal(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 1.2);
  // Inharmonic clang partials.
  const partials = [317, 742, 1178, 1683];
  for (let i = 0; i < partials.length; i++) {
    const f = partials[i] * (0.96 + Math.random() * 0.08);
    const p = osc(ac, i < 2 ? 'triangle' : 'sine', f);
    const pg = ac.createGain();
    env(pg, t, 0.002, (0.22 - i * 0.04) * vol, 0.5 + i * 0.15);
    p.connect(pg).connect(bus);
    p.start(t); p.stop(t + 1.1);
  }
  // Noise attack transient.
  const n = noiseSrc(ac, bufs.white, 1);
  const hp = filt(ac, 'highpass', 900, 0.7);
  const ng = ac.createGain();
  env(ng, t, 0.001, 0.35 * vol, 0.06);
  n.connect(hp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.1);
}

export function propPlastic(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.35);
  const n = noiseSrc(ac, bufs.white, 1.3);
  const bp = filt(ac, 'bandpass', 620, 1.6);
  const ng = ac.createGain();
  env(ng, t, 0.002, 0.34 * vol, 0.08);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.14);
  const k = osc(ac, 'triangle', 340);
  k.frequency.exponentialRampToValueAtTime(180, t + 0.07);
  const kg = ac.createGain();
  env(kg, t, 0.002, 0.2 * vol, 0.09);
  k.connect(kg).connect(bus);
  k.start(t); k.stop(t + 0.15);
}

// ---------------------------------------------------------------- movement

export function whoosh(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.8);
  const n = noiseSrc(ac, bufs.white, 0.8);
  const bp = filt(ac, 'bandpass', 260, 1.1);
  bp.frequency.setValueAtTime(260, t);
  bp.frequency.exponentialRampToValueAtTime(1500, t + 0.28);
  bp.frequency.exponentialRampToValueAtTime(420, t + 0.62);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(MIN, t);
  ng.gain.linearRampToValueAtTime(0.4 * vol, t + 0.22);
  ng.gain.exponentialRampToValueAtTime(MIN, t + 0.66);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.7);
}

export function thud(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const amp = Math.min(1, Math.max(0.15, (o.impact ?? 6) / 16)) * (o.vol ?? 1);
  const bus = voiceBus(ac, out, t, 0.6);
  const sub = osc(ac, 'sine', 105);
  sub.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  const sg = ac.createGain();
  env(sg, t, 0.004, 0.85 * amp, 0.24);
  sub.connect(sg).connect(bus);
  sub.start(t); sub.stop(t + 0.3);
  const n = noiseSrc(ac, bufs.brown, 1);
  const lp = filt(ac, 'lowpass', 500, 0.7);
  const ng = ac.createGain();
  env(ng, t, 0.003, 0.4 * amp, 0.14);
  n.connect(lp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.25);
}

export function splash(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.9);
  const n = noiseSrc(ac, bufs.white, 1.1);
  const bp = filt(ac, 'bandpass', 1200, 0.8);
  bp.frequency.exponentialRampToValueAtTime(3400, t + 0.12);
  bp.frequency.exponentialRampToValueAtTime(900, t + 0.6);
  const ng = ac.createGain();
  env(ng, t, 0.01, 0.4 * vol, 0.7);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.8);
}

// ---------------------------------------------------------------- race UI

export function checkpoint(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.9);
  const notes = [1318.5, 1760.0]; // E6 -> A6, bright and clean
  for (let i = 0; i < 2; i++) {
    const t0 = t + i * 0.09;
    const a = osc(ac, 'sine', notes[i]);
    const b = osc(ac, 'sine', notes[i] * 2);
    const ag = ac.createGain();
    const bg = ac.createGain();
    env(ag, t0, 0.004, 0.16 * vol, 0.4);
    env(bg, t0, 0.004, 0.05 * vol, 0.25);
    a.connect(ag).connect(bus);
    b.connect(bg).connect(bus);
    a.start(t0); a.stop(t0 + 0.55);
    b.start(t0); b.stop(t0 + 0.4);
  }
}

export function beep(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.3);
  const a = osc(ac, 'square', 880);
  const lp = filt(ac, 'lowpass', 2600, 0.7);
  const ag = ac.createGain();
  env(ag, t, 0.004, 0.18 * vol, 0.13);
  a.connect(lp).connect(ag).connect(bus);
  a.start(t); a.stop(t + 0.2);
}

export function goBlast(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 1.2);
  // Fat detuned stack, slight downward settle.
  const freqs = [220, 277.2, 330, 440];
  for (let i = 0; i < freqs.length; i++) {
    const a = osc(ac, 'sawtooth', freqs[i] * 1.02);
    a.frequency.exponentialRampToValueAtTime(freqs[i], t + 0.1);
    const lp = filt(ac, 'lowpass', 3200, 0.8);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.7);
    const ag = ac.createGain();
    env(ag, t, 0.006, 0.14 * vol, 0.75);
    a.connect(lp).connect(ag).connect(bus);
    a.start(t); a.stop(t + 0.9);
  }
  // Air blast.
  const n = noiseSrc(ac, bufs.white, 1);
  const bp = filt(ac, 'bandpass', 1400, 0.7);
  const ng = ac.createGain();
  env(ng, t, 0.004, 0.22 * vol, 0.3);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.4);
}

// ---------------------------------------------------------------- set pieces

export function explosion(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = Math.min(1.2, (o.vol ?? 1) * (0.7 + (o.radius ?? 12) / 40));
  const bus = voiceBus(ac, out, t, 3.4);

  // Sub drop — the gut punch.
  const sub = osc(ac, 'sine', 62);
  sub.frequency.exponentialRampToValueAtTime(24, t + 1.1);
  const sg = ac.createGain();
  env(sg, t, 0.006, 0.95 * vol, 1.3);
  sub.connect(sg).connect(bus);
  sub.start(t); sub.stop(t + 1.5);

  // Blast body — brown noise, lowpass slams shut.
  const n = noiseSrc(ac, bufs.brown, 1);
  const lp = filt(ac, 'lowpass', 2800, 0.6);
  lp.frequency.exponentialRampToValueAtTime(110, t + 1.9);
  const ng = ac.createGain();
  env(ng, t, 0.005, 0.9 * vol, 2.0);
  n.connect(lp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 2.2);

  // Debris crackle tail.
  const c = noiseSrc(ac, bufs.white, 0.7);
  const cb = filt(ac, 'bandpass', 1500, 1.4);
  const cg = ac.createGain();
  env(cg, t + 0.08, 0.05, 0.16 * vol, 2.4);
  c.connect(cb).connect(cg).connect(bus);
  c.start(t + 0.08); c.stop(t + 2.8);
}

export function rockslide(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const dur = o.dur ?? 2.4;
  const bus = voiceBus(ac, out, t, dur + 0.6);
  const n = noiseSrc(ac, bufs.brown, 0.85);
  const lp = filt(ac, 'lowpass', 190, 0.8);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(MIN, t);
  ng.gain.linearRampToValueAtTime(0.55 * vol, t + 0.35);
  ng.gain.setValueAtTime(0.55 * vol, t + dur * 0.55);
  ng.gain.exponentialRampToValueAtTime(MIN, t + dur);
  // Tumbling wobble on the rumble.
  const lfo = osc(ac, 'sine', 6.3);
  const lfoG = ac.createGain();
  lfoG.gain.value = 0.2 * vol;
  lfo.connect(lfoG).connect(ng.gain);
  n.connect(lp).connect(ng).connect(bus);
  n.start(t); n.stop(t + dur + 0.1);
  lfo.start(t); lfo.stop(t + dur + 0.1);
  // Individual boulder knocks.
  for (let i = 0; i < 7; i++) {
    const t0 = t + 0.15 + Math.random() * (dur * 0.7);
    const k = osc(ac, 'sine', 90 + Math.random() * 70);
    k.frequency.exponentialRampToValueAtTime(45, t0 + 0.15);
    const kg = ac.createGain();
    env(kg, t0, 0.004, 0.2 * vol, 0.2);
    k.connect(kg).connect(bus);
    k.start(t0); k.stop(t0 + 0.3);
  }
}

export function thunder(ac, out, bufs, o = {}) {
  const t = Math.max(ac.currentTime, o.at ?? ac.currentTime);
  const inten = o.intensity ?? 0.7;
  const vol = (0.3 + 0.55 * inten) * (o.vol ?? 1);
  const bus = voiceBus(ac, out, t, 3.6);
  // Crack (only for close strikes).
  if (inten > 0.55) {
    const cr = noiseSrc(ac, bufs.white, 1);
    const hp = filt(ac, 'highpass', 500, 0.7);
    const cg = ac.createGain();
    env(cg, t, 0.005, 0.2 * inten, 0.25);
    cr.connect(hp).connect(cg).connect(bus);
    cr.start(t); cr.stop(t + 0.4);
  }
  // Rolling rumble.
  const n = noiseSrc(ac, bufs.brown, 0.6);
  const lp = filt(ac, 'lowpass', 160, 1.1);
  lp.frequency.exponentialRampToValueAtTime(70, t + 2.6);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(MIN, t);
  ng.gain.linearRampToValueAtTime(0.8 * vol, t + 0.12 + (1 - inten) * 0.25);
  ng.gain.exponentialRampToValueAtTime(MIN, t + 3.0);
  const lfo = osc(ac, 'sine', 3.7);
  const lfoG = ac.createGain();
  lfoG.gain.value = 0.22 * vol;
  lfo.connect(lfoG).connect(ng.gain);
  n.connect(lp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 3.2);
  lfo.start(t); lfo.stop(t + 3.2);
  // Sub roll.
  const sub = osc(ac, 'sine', 43);
  const sg = ac.createGain();
  env(sg, t + 0.05, 0.15, 0.35 * vol, 2.2);
  sub.connect(sg).connect(bus);
  sub.start(t); sub.stop(t + 2.8);
}

// ---------------------------------------------------------------- fanfare / score

export function fanfare(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 5.0);
  // Three rising brass-ish stabs then a held chord.
  const stabs = [
    [220.0, 277.2, 329.6],           // A3 C#4 E4
    [246.9, 311.1, 370.0],           // B3 D#4 F#4
    [277.2, 349.2, 415.3, 554.4],    // C#4 F4 G#4 C#5 held
  ];
  for (let s = 0; s < stabs.length; s++) {
    const t0 = t + s * 0.24;
    const held = s === 2;
    const dur = held ? 1.9 : 0.22;
    for (const f of stabs[s]) {
      const a = osc(ac, 'sawtooth', f);
      const b = osc(ac, 'sawtooth', f * 1.006);
      const lp = filt(ac, 'lowpass', 2400, 0.8);
      if (held) lp.frequency.exponentialRampToValueAtTime(900, t0 + dur);
      const g = ac.createGain();
      env(g, t0, 0.015, (held ? 0.075 : 0.06) * vol, dur);
      a.connect(lp); b.connect(lp);
      lp.connect(g).connect(bus);
      a.start(t0); a.stop(t0 + dur + 0.2);
      b.start(t0); b.stop(t0 + dur + 0.2);
    }
  }
  // Crowd-ish swell: shaped mid noise, breathing.
  const n = noiseSrc(ac, bufs.white, 0.9);
  const bp = filt(ac, 'bandpass', 1100, 0.55);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(MIN, t + 0.2);
  ng.gain.linearRampToValueAtTime(0.16 * vol, t + 1.1);
  ng.gain.setValueAtTime(0.16 * vol, t + 2.4);
  ng.gain.exponentialRampToValueAtTime(MIN, t + 4.6);
  const lfo = osc(ac, 'sine', 2.1);
  const lfoG = ac.createGain();
  lfoG.gain.value = 0.045 * vol;
  lfo.connect(lfoG).connect(ng.gain);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t + 0.2); n.stop(t + 4.8);
  lfo.start(t + 0.2); lfo.stop(t + 4.8);
}

export function zing(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const s = Math.min(1, (o.score ?? 500) / 4000);
  const vol = (0.5 + 0.5 * s) * (o.vol ?? 1);
  const bus = voiceBus(ac, out, t, 0.8);
  const f0 = 620;
  const f1 = 1500 + 1400 * s;
  const a = osc(ac, 'square', f0);
  a.frequency.exponentialRampToValueAtTime(f1, t + 0.22);
  const lp = filt(ac, 'lowpass', 3400, 1.2);
  const ag = ac.createGain();
  env(ag, t, 0.005, 0.12 * vol, 0.3);
  a.connect(lp).connect(ag).connect(bus);
  a.start(t); a.stop(t + 0.4);
  // Sparkle tail.
  const b = osc(ac, 'sine', f1 * 1.5);
  const bg = ac.createGain();
  env(bg, t + 0.18, 0.005, 0.08 * vol, 0.35);
  b.connect(bg).connect(bus);
  b.start(t + 0.18); b.stop(t + 0.6);
}

// ---------------------------------------------------------------- engine helpers

export function blowoff(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.5);
  const n = noiseSrc(ac, bufs.white, 1.4);
  const bp = filt(ac, 'bandpass', 4200, 1.6);
  bp.frequency.exponentialRampToValueAtTime(1100, t + 0.32);
  const ng = ac.createGain();
  env(ng, t, 0.008, 0.2 * vol, 0.33);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.42);
}

export function cracklePop(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = (0.5 + Math.random() * 0.5) * (o.vol ?? 1);
  const bus = voiceBus(ac, out, t, 0.15);
  const n = noiseSrc(ac, bufs.white, 0.8 + Math.random() * 0.9);
  const bp = filt(ac, 'bandpass', 900 + Math.random() * 1500, 1.8);
  const ng = ac.createGain();
  env(ng, t, 0.002, 0.2 * vol, 0.035 + Math.random() * 0.05);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.12);
}

export function boostIgnite(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.7);
  const n = noiseSrc(ac, bufs.white, 1);
  const bp = filt(ac, 'bandpass', 500, 0.9);
  bp.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
  const ng = ac.createGain();
  env(ng, t, 0.01, 0.22 * vol, 0.45);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.6);
  const sub = osc(ac, 'sine', 55);
  sub.frequency.exponentialRampToValueAtTime(90, t + 0.3);
  const sg = ac.createGain();
  env(sg, t, 0.01, 0.2 * vol, 0.35);
  sub.connect(sg).connect(bus);
  sub.start(t); sub.stop(t + 0.5);
}

export function spark(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.2);
  const n = noiseSrc(ac, bufs.white, 1.8);
  const hp = filt(ac, 'highpass', 3800, 1.2);
  const ng = ac.createGain();
  env(ng, t, 0.002, 0.09 * vol, 0.08);
  n.connect(hp).connect(ng).connect(bus);
  n.start(t); n.stop(t + 0.12);
}

export function click(ac, out, bufs, o = {}) {
  const t = ac.currentTime;
  const vol = o.vol ?? 1;
  const bus = voiceBus(ac, out, t, 0.15);
  const a = osc(ac, 'sine', 1900);
  const ag = ac.createGain();
  env(ag, t, 0.001, 0.09 * vol, 0.05);
  a.connect(ag).connect(bus);
  a.start(t); a.stop(t + 0.08);
}
