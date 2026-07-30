// APEX: CATACLYSM CANYON — minimal dark-synthwave bed.
// 2-bar arpeggio + slow pad + heartbeat bass over a 4-chord cycle (Am F C Em),
// scheduled with a small lookahead. Kept quiet by design: the engine is the hero.

const BPM = 92;
const STEP = 60 / BPM / 2;       // 8th notes
const STEPS_PER_BAR = 8;
const LOOKAHEAD = 0.35;          // seconds of scheduling headroom
const MIN = 0.0001;

// [arpRootHz, thirdSemitones] — Am, Fmaj, Cmaj, Em
const CHORDS = [
  [110.0, 3],
  [87.31, 4],
  [130.81, 4],
  [82.41, 3],
];

const semi = (root, n) => root * Math.pow(2, n / 12);

export class MusicBed {
  constructor(ac, out) {
    this.ac = ac;
    this.bus = ac.createGain();       // voices sum here
    this.duckGain = ac.createGain();  // sidechain-style duck under big sfx
    this.master = ac.createGain();    // overall level, smoothed per frame
    this.master.gain.value = 0;
    const gel = ac.createBiquadFilter(); // keeps the bed soft & behind the mix
    gel.type = 'lowpass';
    gel.frequency.value = 3400;
    gel.Q.value = 0.5;
    this.bus.connect(gel);
    gel.connect(this.duckGain);
    this.duckGain.connect(this.master);
    this.master.connect(out);

    this._started = false;
    this._level = 0;
    this._step = 0;
    this._nextT = 0;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._step = 0;
    this._nextT = this.ac.currentTime + 0.2;
  }

  setLevel(v) { this._level = v; }

  /** Duck to `amount` (linear gain), recover after `hold` seconds. */
  duck(amount = 0.5, hold = 1.5) {
    const g = this.duckGain.gain;
    const t = this.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(amount, t, 0.04);
    g.setTargetAtTime(1, t + hold, 0.7);
  }

  update(dt) {
    const g = this.master.gain;
    g.value += (this._level - g.value) * Math.min(1, 2.2 * dt);
    if (!this._started) return;
    if (this._level <= 0.001 && g.value < 0.003) {
      // Inaudible: idle the scheduler, keep the transport "now".
      this._nextT = this.ac.currentTime + 0.2;
      return;
    }
    while (this._nextT < this.ac.currentTime + LOOKAHEAD) {
      this._schedule(this._step, this._nextT);
      this._step++;
      this._nextT += STEP;
    }
  }

  _schedule(step, t) {
    const inBar = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR) % CHORDS.length;
    const [root, third] = CHORDS[bar];

    // --- Arp: dark, ping-ponged 8ths (pattern spans 2 bars via chord motion) ---
    const off = [0, 7, 12, 12 + third, 12, 19, 12 + third, 24][inBar];
    this._arpNote(semi(root, off), t, inBar % 2 ? 0.35 : -0.35);

    // --- Bass: beats 1 & 3 ---
    if (inBar === 0 || inBar === 4) this._bass(root * 0.5, t);

    // --- Pad: one chord per bar ---
    if (inBar === 0) this._pad(root, third, t);
  }

  _voice(t, dur) {
    const ac = this.ac;
    const g = ac.createGain();
    g.connect(this.bus);
    const timer = ac.createConstantSource();
    timer.offset.value = 0;
    timer.connect(g);
    timer.start(t);
    timer.stop(t + dur);
    timer.onended = () => { try { g.disconnect(); } catch (_) {} };
    return g;
  }

  _arpNote(freq, t, pan) {
    const ac = this.ac;
    const bus = this._voice(t, 0.5);
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    p.connect(bus);
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3.5;
    lp.frequency.setValueAtTime(2100, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.3);
    const g = ac.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.006);
    g.gain.exponentialRampToValueAtTime(MIN, t + 0.32);
    o.connect(lp).connect(g).connect(p);
    o.start(t);
    o.stop(t + 0.4);
  }

  _bass(freq, t) {
    const ac = this.ac;
    const bus = this._voice(t, 0.8);
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const h = ac.createOscillator(); // gentle 2nd harmonic for definition
    h.type = 'triangle';
    h.frequency.value = freq * 2;
    const g = ac.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.015);
    g.gain.exponentialRampToValueAtTime(MIN, t + 0.6);
    const hg = ac.createGain();
    hg.gain.value = 0.25;
    o.connect(g);
    h.connect(hg).connect(g);
    g.connect(bus);
    o.start(t); o.stop(t + 0.7);
    h.start(t); h.stop(t + 0.7);
  }

  _pad(root, third, t) {
    const ac = this.ac;
    const barLen = STEP * STEPS_PER_BAR;
    const bus = this._voice(t, barLen + 1.6);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 560;
    lp.Q.value = 0.7;
    const g = ac.createGain();
    g.gain.setValueAtTime(MIN, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.9);
    g.gain.setValueAtTime(0.05, t + barLen - 0.3);
    g.gain.exponentialRampToValueAtTime(MIN, t + barLen + 1.2);
    lp.connect(g).connect(bus);
    const tones = [root, semi(root, third), semi(root, 7)];
    for (let i = 0; i < tones.length; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = tones[i];
      o.detune.value = (i % 2 ? 7 : -7);
      o.connect(lp);
      o.start(t);
      o.stop(t + barLen + 1.4);
    }
  }
}
