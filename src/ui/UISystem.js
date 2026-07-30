// ============================================================================
// APEX: CATACLYSM CANYON — UISystem (SPEC §8)
// NFS-Unbound graffiti energy x Forza readability. DOM overlay in #ui-root.
// All motion is CSS transform/opacity. Cached refs, pooled popups, zero DOM
// creation per frame.
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// tiny DOM helpers (init-time only)
// ---------------------------------------------------------------------------
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function retrigger(elm, cls) {
  elm.classList.remove(cls);
  // force style flush so the animation restarts (rare, event-driven only)
  void elm.offsetWidth;
  elm.classList.add(cls);
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
function fmtTime(t) {
  if (!(t >= 0)) t = 0;
  const ms = Math.floor((t % 1) * 1000);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60);
  return pad2(m) + ':' + pad2(s) + '.' + pad3(ms);
}
function fmtDiff(d) {
  const sign = d < 0 ? '−' : '+';
  const a = Math.abs(d);
  return sign + a.toFixed(3);
}
function easeOutCubic(p) { const q = 1 - p; return 1 - q * q * q; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Procedural film grain tile (no network assets).
function makeGrainURL() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d');
    const img = g.createImageData(96, 96);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 28;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// UISystem
// ---------------------------------------------------------------------------
export class UISystem {
  constructor(ctx) {
    this.ctx = ctx;
    this._phase = null;
    this._time = 0;

    // cached last-shown values (avoid textContent churn)
    this._lastKmh = -1;
    this._lastGear = -1;
    this._lastRpmOff = -1;
    this._lastNeedle = -999;
    this._lastBoostX = -1;
    this._lastPos = -1;
    this._lastCp = -1;
    this._lastLinesOp = -1;
    this._wrongShown = false;
    this._muteShown = null;
    this._boostLow = false;
    this._boostFull = false;
    this._boosting = false;

    // drift
    this._driftBase = 0;
    this._driftOn = false;
    this._lastDriftPts = -1;
    this._flyIdx = 0;

    // splits
    this._splits = [];
    this._refSplits = null;

    // center messages
    this._msgQueue = [];
    this._msgNextAt = 0;
    this._msgIdx = 0;

    // finish
    this._finishData = null;
    this._finishRevealT = -1;
    this._finishDone = false;

    // minimap
    this._mapOK = false;
    this._mapScale = 1;
    this._mapOffX = 0;
    this._mapOffY = 0;
    this._aiSource = null;
    this._aiProbe = 0;
    this._cpTicks = [];
  }

  async init() {
    this._injectStyle();

    const root = document.getElementById('ui-root') || document.body;
    this.root = el('div', 'ax', root);
    this.root.dataset.phase = 'loading';

    // stage receives the screen-punch scale so class juggling stays local
    this.stage = el('div', 'ax-stage', this.root);

    this._buildGrain();
    this._buildSpeedLines();
    this._buildWrongWay();
    this._buildHUD();
    this._buildMinimap();
    this._buildDrift();
    this._buildMessages();
    this._buildCountdown();
    this._buildFinish();
    this._buildTitle();
    this._buildMuteTag();

    this._bindEvents();
  }

  // =========================================================================
  // BUILDERS
  // =========================================================================
  _buildGrain() {
    const g = el('div', 'ax-grain', this.stage);
    const url = makeGrainURL();
    if (url) g.style.backgroundImage = `url(${url})`;
  }

  _buildSpeedLines() {
    this.linesEl = el('div', 'ax-lines', this.stage);
    el('div', 'ax-lines-spin', this.linesEl);
  }

  _buildWrongWay() {
    this.wrongEl = el('div', 'ax-wrong', this.stage);
    const inner = el('div', 'ax-wrong-inner', this.wrongEl);
    // U-turn arrow
    const s = svg('svg', { viewBox: '0 0 64 64', class: 'ax-wrong-arrow' }, inner);
    svg('path', {
      d: 'M20 54 V30 a12 12 0 0 1 24 0 v6 h8 L40 50 28 36 h8 v-6 a4 4 0 0 0 -8 0 v24 z',
      fill: 'currentColor',
    }, s);
    el('div', 'ax-wrong-text', inner, 'WRONG WAY');
    el('div', 'ax-wrong-sub', inner, 'TURN AROUND');
  }

  _buildHUD() {
    this.hud = el('div', 'ax-hud', this.stage);

    // ---- top cluster -------------------------------------------------
    const top = el('div', 'ax-top', this.hud);

    const posP = el('div', 'ax-panel ax-pos', top);
    this.posEl = el('span', 'ax-pos-n', posP, 'P4');
    this.posTotEl = el('span', 'ax-pos-t', posP, '/4');

    const timP = el('div', 'ax-panel ax-timerbox', top);
    this.timerEl = el('div', 'ax-timer', timP, '00:00.000');
    this.splitEl = el('div', 'ax-split', timP, '');

    const cpP = el('div', 'ax-panel ax-cpbox', top);
    el('span', 'ax-cp-lab', cpP, 'CP ');
    this.cpEl = el('span', 'ax-cp-n', cpP, '0');
    this.cpTotEl = el('span', 'ax-cp-t', cpP, '/12');

    // ---- bottom-right speed cluster -----------------------------------
    const sp = el('div', 'ax-speedo', this.hud);
    this.speedoEl = sp;

    const gauge = svg('svg', { viewBox: '0 0 220 190', class: 'ax-gauge' }, sp);
    const defs = svg('defs', null, gauge);
    const grad = svg('linearGradient', { id: 'ax-rpm-grad', x1: '0', y1: '1', x2: '1', y2: '0' }, defs);
    svg('stop', { offset: '0%', 'stop-color': '#ff2d78' }, grad);
    svg('stop', { offset: '60%', 'stop-color': '#ff9a3d' }, grad);
    svg('stop', { offset: '100%', 'stop-color': '#ffe14d' }, grad);

    const CX = 110, CY = 112, R = 86;
    const arc = `M 35.5 155 A ${R} ${R} 0 1 1 184.5 155`;
    svg('path', { d: arc, class: 'ax-arc-bg', pathLength: '100' }, gauge);
    svg('path', { d: arc, class: 'ax-arc-red', pathLength: '100' }, gauge);
    this.rpmArc = svg('path', { d: arc, class: 'ax-arc-rpm', pathLength: '100' }, gauge);

    // ticks
    for (let i = 0; i <= 8; i++) {
      const a = (-120 + (240 * i) / 8) * DEG2RAD;
      const sn = Math.sin(a), cs = Math.cos(a);
      const r1 = 74, r2 = i % 2 === 0 ? 64 : 69;
      svg('line', {
        x1: (CX + r1 * sn).toFixed(1), y1: (CY - r1 * cs).toFixed(1),
        x2: (CX + r2 * sn).toFixed(1), y2: (CY - r2 * cs).toFixed(1),
        class: i >= 7 ? 'ax-tick ax-tick-red' : 'ax-tick',
      }, gauge);
    }

    // needle (CSS-rotated, pivot at gauge center via transform-box)
    this.needle = svg('g', { class: 'ax-needle' }, gauge);
    svg('polygon', { points: '107,118 113,118 110.8,34 109.2,34', class: 'ax-needle-body' }, this.needle);
    svg('circle', { cx: CX, cy: CY, r: 7, class: 'ax-needle-cap' }, gauge);
    svg('circle', { cx: CX, cy: CY, r: 2.6, class: 'ax-needle-pin' }, gauge);

    const readout = el('div', 'ax-readout', sp);
    this.kmhEl = el('div', 'ax-kmh', readout, '0');
    el('div', 'ax-kmh-unit', readout, 'KM/H');
    this.gearEl = el('div', 'ax-gear', sp, '1');
    el('div', 'ax-gear-lab', sp, 'GEAR');

    const boost = el('div', 'ax-boost', sp);
    this.boostBox = boost;
    el('div', 'ax-boost-lab', boost, 'NITRO');
    const bar = el('div', 'ax-boost-bar', boost);
    this.boostFill = el('i', 'ax-boost-fill', bar);
    el('i', 'ax-boost-sheen', bar);
    this.boostFill.style.transform = 'scaleX(1)';
  }

  _buildMinimap() {
    this.mapEl = el('div', 'ax-map ax-panel', this.stage);
    const W = 168, H = 168;
    const track = this.ctx.track;
    this._mapOK = false;
    try {
      if (track && typeof track.sample === 'function') {
        const N = 200;
        const xs = new Float32Array(N + 1);
        const zs = new Float32Array(N + 1);
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i <= N; i++) {
          const s = track.sample(i / N);
          xs[i] = s.position.x; zs[i] = s.position.z;
          if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
          if (zs[i] < minZ) minZ = zs[i]; if (zs[i] > maxZ) maxZ = zs[i];
        }
        const pad = 14;
        const sc = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxZ - minZ));
        this._mapScale = sc;
        this._mapOffX = (W - (maxX - minX) * sc) * 0.5 - minX * sc;
        this._mapOffY = (H - (maxZ - minZ) * sc) * 0.5 - minZ * sc;

        const map = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ax-map-svg' }, this.mapEl);
        let pts = '';
        for (let i = 0; i <= N; i++) {
          pts += (xs[i] * sc + this._mapOffX).toFixed(1) + ',' + (zs[i] * sc + this._mapOffY).toFixed(1) + ' ';
        }
        svg('polyline', { points: pts, class: 'ax-map-route-glow' }, map);
        svg('polyline', { points: pts, class: 'ax-map-route' }, map);

        // checkpoint ticks
        this._cpTicks.length = 0;
        const cps = track.checkpoints || [];
        for (let i = 0; i < cps.length; i++) {
          const p = cps[i].position;
          if (!p) continue;
          const tick = svg('circle', {
            cx: (p.x * sc + this._mapOffX).toFixed(1),
            cy: (p.z * sc + this._mapOffY).toFixed(1),
            r: 2.4, class: 'ax-map-cp',
          }, map);
          this._cpTicks.push(tick);
        }
        // finish flag (mini checkers) at end of route
        const fx = xs[N] * sc + this._mapOffX, fy = zs[N] * sc + this._mapOffY;
        const flag = svg('g', { class: 'ax-map-flag', transform: `translate(${fx.toFixed(1)} ${fy.toFixed(1)})` }, map);
        svg('rect', { x: -0.8, y: -12, width: 1.6, height: 12, fill: '#dfe3ea' }, flag);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
          svg('rect', {
            x: 0.8 + c * 3, y: -12 + r * 3, width: 3, height: 3,
            fill: (r + c) % 2 === 0 ? '#f2f4f8' : '#14141a',
          }, flag);
        }
        // start pip
        svg('circle', { cx: (xs[0] * sc + this._mapOffX).toFixed(1), cy: (zs[0] * sc + this._mapOffY).toFixed(1), r: 3, class: 'ax-map-start' }, map);

        // moving dots (HTML, transform-only updates)
        const dots = el('div', 'ax-map-dots', this.mapEl);
        this.aiDots = [
          el('i', 'ax-dot ax-dot-ai a0', dots),
          el('i', 'ax-dot ax-dot-ai a1', dots),
          el('i', 'ax-dot ax-dot-ai a2', dots),
        ];
        for (const d of this.aiDots) d.style.opacity = '0';
        this.meDot = el('i', 'ax-dot ax-dot-me', dots);
        this._mapOK = true;
      }
    } catch (e) { /* track data unavailable — hide map */ }
    if (!this._mapOK) this.mapEl.style.display = 'none';
  }

  _buildDrift() {
    this.driftEl = el('div', 'ax-driftbox', this.stage);
    el('div', 'ax-drift-lab', this.driftEl, 'DRIFT');
    this.driftPts = el('div', 'ax-drift-pts', this.driftEl, '0');
    // flyaway pool
    this.flyPool = [];
    const fp = el('div', 'ax-flyaways', this.stage);
    for (let i = 0; i < 6; i++) this.flyPool.push(el('div', 'ax-fly', fp));
  }

  _buildMessages() {
    const wrap = el('div', 'ax-msgs', this.stage);
    this.msgPool = [];
    for (let i = 0; i < 3; i++) {
      const m = el('div', 'ax-msg', wrap);
      el('div', 'ax-msg-text', m);
      el('div', 'ax-msg-under', m);
      el('div', 'ax-msg-sub', m);
      this.msgPool.push(m);
    }
  }

  _buildCountdown() {
    this.countWrap = el('div', 'ax-countwrap', this.stage);
    this.countEl = el('div', 'ax-count', this.countWrap, '');
    this.goFlash = el('div', 'ax-goflash', this.stage);
  }

  _buildFinish() {
    this.finishEl = el('div', 'ax-finish', this.stage);
    const card = el('div', 'ax-card', this.finishEl);
    el('div', 'ax-card-kicker', card, 'RACE COMPLETE');
    this.fPosEl = el('div', 'ax-fpos', card, 'P1');
    this.fSubEl = el('div', 'ax-fsub', card, 'CANYON CONQUERED');
    const rows = el('div', 'ax-frows', card);
    const mkRow = (label, unit, i) => {
      const r = el('div', 'ax-frow', rows);
      r.style.animationDelay = (0.35 + i * 0.14).toFixed(2) + 's';
      el('span', 'ax-frow-lab', r, label);
      const v = el('span', 'ax-frow-val', r, '—');
      if (unit) el('span', 'ax-frow-unit', r, unit);
      return v;
    };
    this.fTime = mkRow('FINAL TIME', '', 0);
    this.fSpeed = mkRow('TOP SPEED', 'KM/H', 1);
    this.fDrift = mkRow('DRIFT SCORE', 'PTS', 2);
    this.fAir = mkRow('AIR TIME', 'S', 3);
    this.fProps = mkRow('PROPS BROKEN', '', 4);
    el('div', 'ax-again', card, 'ENTER / R — RUN IT BACK');
  }

  _buildTitle() {
    this.titleEl = el('div', 'ax-title', this.stage);
    el('div', 'ax-title-scrim', this.titleEl);
    el('div', 'ax-title-slash s1', this.titleEl);
    el('div', 'ax-title-slash s2', this.titleEl);

    const mid = el('div', 'ax-title-mid', this.titleEl);
    el('div', 'ax-logo', mid, 'APEX');
    const sub = el('div', 'ax-logo-sub', mid);
    el('i', 'ax-rule', sub);
    el('span', null, sub, 'CATACLYSM CANYON');
    el('i', 'ax-rule', sub);
    el('div', 'ax-tagline', mid, 'ONE CANYON. FOUR CARS. THE SKY IS FALLING — OUTDRIVE IT.');

    const legend = el('div', 'ax-legend', this.titleEl);
    const K = (keys, act) => {
      const row = el('div', 'ax-key-row', legend);
      const kwrap = el('div', 'ax-keys', row);
      for (const k of keys) el('kbd', 'ax-kbd', kwrap, k);
      el('span', 'ax-key-act', row, act);
    };
    K(['W A S D', '←↑→↓'], 'DRIVE');
    K(['SPACE'], 'HANDBRAKE');
    K(['SHIFT'], 'NITRO');
    K(['C'], 'CAMERA');
    K(['R'], 'RESET');
    K(['M'], 'MUTE');

    const press = el('div', 'ax-press', this.titleEl);
    el('span', null, press, 'PRESS ');
    el('kbd', 'ax-kbd ax-kbd-hot', press, 'ENTER');
    el('span', null, press, ' TO RACE');
  }

  _buildMuteTag() {
    this.muteEl = el('div', 'ax-mutetag', this.stage, 'MUTED · M');
  }

  // =========================================================================
  // EVENTS
  // =========================================================================
  _bindEvents() {
    const ev = this.ctx.events;
    if (!ev) return;

    ev.on('race:countdown', (p) => this._onCountdown(p));
    ev.on('race:start', () => { this._splits.length = 0; });
    ev.on('race:checkpoint', (p) => this._onCheckpoint(p));
    ev.on('race:finish', (p) => this._onFinish(p));
    ev.on('race:restart', () => this._onRestart());
    ev.on('drift:start', () => this._onDriftStart());
    ev.on('drift:end', (p) => this._onDriftEnd(p));
    ev.on('boost:start', () => { this._boosting = true; this.speedoEl.classList.add('boosting'); });
    ev.on('boost:end', () => { this._boosting = false; this.speedoEl.classList.remove('boosting'); });
    ev.on('ui:message', (p) => this._onMessage(p));
  }

  _onCountdown(p) {
    const n = p && typeof p.n === 'number' ? p.n : 0;
    const go = n === 0;
    this.countEl.textContent = go ? 'GO' : String(n);
    this.countEl.classList.toggle('go', go);
    retrigger(this.countEl, 'stamp');
    retrigger(this.stage, 'ax-punch');
    if (go) retrigger(this.goFlash, 'on');
  }

  _onCheckpoint(p) {
    if (!p) return;
    const st = this.ctx.state;
    const idx = p.index | 0;
    const t = st.raceTime;
    this._splits[idx] = t;
    let txt, cls;
    if (this._refSplits && typeof this._refSplits[idx] === 'number') {
      const d = t - this._refSplits[idx];
      txt = fmtDiff(d);
      cls = d <= 0 ? 'ax-split good' : 'ax-split bad';
    } else {
      txt = fmtTime(t);
      cls = 'ax-split neutral';
    }
    this.splitEl.textContent = txt;
    this.splitEl.className = cls;
    retrigger(this.splitEl, 'flash');
    // visual chime tick on the CP counter + minimap tick
    retrigger(this.cpEl.parentElement, 'chime');
    const tick = this._cpTicks[idx] || this._cpTicks[idx - 1];
    if (tick) tick.classList.add('hit');
  }

  _onFinish(p) {
    const st = this.ctx.state;
    const stats = (p && p.stats) || st.stats || {};
    this._finishData = {
      time: p && typeof p.time === 'number' ? p.time : st.raceTime,
      pos: st.racePosition || 4,
      topSpeed: stats.topSpeedKmh || 0,
      drift: stats.driftScore || 0,
      air: stats.airTime || 0,
      props: stats.propsBroken || 0,
    };
    this._finishRevealT = -1; // armed; stamped on first finished-phase update
    this._finishDone = false;

    const f = this._finishData;
    const won = f.pos === 1;
    this.fPosEl.textContent = won ? 'P1' : 'P' + f.pos;
    this.fPosEl.classList.toggle('win', won);
    this.fSubEl.textContent =
      won ? 'CANYON CONQUERED' :
      f.pos === 2 ? 'INCHES FROM GLORY' :
      f.pos === 3 ? 'THE CANYON BIT BACK' : 'SHAKEDOWN RUN';
    // keep this run as the split reference for next run
    if (this._splits.length) this._refSplits = this._splits.slice();
  }

  _onRestart() {
    if (this._splits.length) this._refSplits = this._splits.slice();
    this._splits.length = 0;
    this._finishData = null;
    this._finishRevealT = -1;
    this._msgQueue.length = 0;
    this._msgNextAt = 0;
    this._driftOn = false;
    this.driftEl.classList.remove('on');
    this.splitEl.classList.remove('flash');
    for (const t of this._cpTicks) t.classList.remove('hit');
    for (const m of this.msgPool) m.classList.remove('show');
  }

  _onDriftStart() {
    const st = this.ctx.state;
    this._driftBase = (st.stats && st.stats.driftScore) || 0;
    this._driftOn = true;
    this._lastDriftPts = -1;
    this.driftEl.classList.add('on');
  }

  _onDriftEnd(p) {
    this._driftOn = false;
    this.driftEl.classList.remove('on');
    const score = p && p.score ? Math.round(p.score) : 0;
    if (score < 50) return; // don't celebrate scraps
    const f = this.flyPool[this._flyIdx];
    this._flyIdx = (this._flyIdx + 1) % this.flyPool.length;
    f.textContent = '+' + score.toLocaleString('en-US') + ' BANKED';
    f.classList.toggle('big', score >= 2000);
    retrigger(f, 'fly');
  }

  _onMessage(p) {
    if (!p || !p.text) return;
    if (this._msgQueue.length > 5) this._msgQueue.shift();
    this._msgQueue.push({
      text: String(p.text),
      sub: p.sub ? String(p.sub) : '',
      style: p.style === 'epic' || p.style === 'warn' ? p.style : 'info',
    });
  }

  // =========================================================================
  // UPDATE
  // =========================================================================
  update(dt, time) {
    const st = this.ctx.state;
    if (!st) return;
    this._time = time;

    if (st.phase !== this._phase) {
      this._phase = st.phase;
      this.root.dataset.phase = st.phase;
    }

    // mute tag
    const mute = !!(st.settings && st.settings.mute);
    if (mute !== this._muteShown) {
      this._muteShown = mute;
      this.muteEl.classList.toggle('on', mute);
    }

    if (st.phase === 'countdown' || st.phase === 'racing') {
      this._updateHUD(st);
    } else if (st.phase === 'finished') {
      this._updateFinish(time);
    }
    this._updateMessages(time);
  }

  _updateHUD(st) {
    const car = st.car;
    if (!car) return;

    // --- speed digits ---
    const kmh = Math.round(car.speedKmh || 0);
    if (kmh !== this._lastKmh) {
      this._lastKmh = kmh;
      this.kmhEl.textContent = kmh;
    }

    // --- gear ---
    const gear = car.gear | 0;
    if (gear !== this._lastGear) {
      this._lastGear = gear;
      this.gearEl.textContent = gear > 0 ? String(gear) : 'N';
      retrigger(this.gearEl, 'pop');
    }

    // --- rpm arc + needle ---
    const rpm = clamp01(car.rpm || 0);
    const off = Math.round((100 - rpm * 100) * 10) / 10;
    if (off !== this._lastRpmOff) {
      this._lastRpmOff = off;
      this.rpmArc.style.strokeDashoffset = off;
    }
    const deg = -120 + rpm * 240;
    if (Math.abs(deg - this._lastNeedle) > 0.15) {
      this._lastNeedle = deg;
      this.needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }

    // --- boost bar ---
    const boost = clamp01(car.boost == null ? 1 : car.boost);
    const bx = Math.round(boost * 200) / 200;
    if (bx !== this._lastBoostX) {
      this._lastBoostX = bx;
      this.boostFill.style.transform = `scaleX(${bx})`;
    }
    if (!this._boostLow && boost < 0.22) { this._boostLow = true; this.boostBox.classList.add('low'); }
    else if (this._boostLow && boost > 0.32) { this._boostLow = false; this.boostBox.classList.remove('low'); }
    if (!this._boostFull && boost >= 0.985) {
      this._boostFull = true;
      this.boostBox.classList.add('full');
      retrigger(this.boostBox, 'ready'); // boost-ready flash cue
    } else if (this._boostFull && boost < 0.9) {
      this._boostFull = false;
      this.boostBox.classList.remove('full');
    }

    // --- position / checkpoint / timer ---
    const pos = st.racePosition | 0;
    if (pos !== this._lastPos) {
      this._lastPos = pos;
      this.posEl.textContent = 'P' + pos;
      retrigger(this.posEl, 'pop');
    }
    const cp = st.checkpoint | 0;
    if (cp !== this._lastCp) {
      this._lastCp = cp;
      this.cpEl.textContent = cp;
      this.cpTotEl.textContent = '/' + (st.checkpointTotal || 12);
    }
    this.timerEl.textContent = fmtTime(st.raceTime);

    // --- drift live counter ---
    if (this._driftOn && car.drifting && st.stats) {
      const pts = Math.max(0, Math.round(st.stats.driftScore - this._driftBase));
      if (pts !== this._lastDriftPts) {
        this._lastDriftPts = pts;
        this.driftPts.textContent = pts.toLocaleString('en-US');
      }
    } else if (this._driftOn && !car.drifting) {
      // physics dropped drift without event — recover gracefully
      this._driftOn = false;
      this.driftEl.classList.remove('on');
    }

    // --- wrong way ---
    const ww = !!st.wrongWay;
    if (ww !== this._wrongShown) {
      this._wrongShown = ww;
      this.wrongEl.classList.toggle('on', ww);
    }

    // --- speed-lines vignette >200 km/h ---
    let lop = clamp01((kmh - 200) / 55) * 0.8;
    if (this._boosting) lop = Math.min(0.9, lop + 0.12);
    if (Math.abs(lop - this._lastLinesOp) > 0.02 || (lop === 0 && this._lastLinesOp !== 0)) {
      this._lastLinesOp = lop;
      this.linesEl.style.opacity = lop.toFixed(2);
    }

    this._updateMinimap(st);
  }

  _updateMinimap(st) {
    if (!this._mapOK) return;
    const sc = this._mapScale, ox = this._mapOffX, oy = this._mapOffY;
    const p = st.car && st.car.position;
    if (p) {
      this.meDot.style.transform = `translate3d(${(p.x * sc + ox).toFixed(1)}px,${(p.z * sc + oy).toFixed(1)}px,0)`;
    }
    // AI positions: no contracted channel — probe conventional spots, degrade to hidden
    if (!this._aiSource && (this._aiProbe++ & 31) === 0) {
      const cand = [st.aiCars, st.ai, st.rivals, this.ctx.ai && this.ctx.ai.cars];
      for (const c of cand) {
        if (Array.isArray(c) && c.length) { this._aiSource = c; break; }
      }
      if (this._aiSource) for (const d of this.aiDots) d.style.opacity = '1';
    }
    const src = this._aiSource;
    if (!src) return;
    const track = this.ctx.track;
    for (let i = 0; i < 3; i++) {
      const a = src[i];
      if (!a) { continue; }
      let x = null, z = null;
      const ap = a.position || (a.group && a.group.position) || (a.mesh && a.mesh.position) || (a.car && a.car.position);
      if (ap && typeof ap.x === 'number') { x = ap.x; z = ap.z; }
      else if (typeof a.progress === 'number' && track && track.sample) {
        try {
          const s = track.sample(clamp01(a.progress));
          x = s.position.x; z = s.position.z;
        } catch (e) { /* skip this frame */ }
      }
      if (x === null) continue;
      this.aiDots[i].style.transform = `translate3d(${(x * sc + ox).toFixed(1)}px,${(z * sc + oy).toFixed(1)}px,0)`;
    }
  }

  _updateMessages(time) {
    if (!this._msgQueue.length || time < this._msgNextAt) return;
    const m = this._msgQueue.shift();
    const node = this.msgPool[this._msgIdx];
    this._msgIdx = (this._msgIdx + 1) % this.msgPool.length;
    node.firstChild.textContent = m.text;            // .ax-msg-text
    node.lastChild.textContent = m.sub;              // .ax-msg-sub
    node.className = 'ax-msg ' + m.style;
    retrigger(node, 'show');
    const dur = m.style === 'epic' ? 2.6 : m.style === 'warn' ? 2.2 : 1.9;
    node.style.animationDuration = dur + 's';
    this._msgNextAt = time + dur * 0.62; // slight overlap keeps flow punchy
  }

  _updateFinish(time) {
    const f = this._finishData;
    if (!f) {
      // finished without event data (defensive): synthesize from state once
      const st = this.ctx.state;
      this._onFinish({ time: st.raceTime, stats: st.stats });
      return;
    }
    if (this._finishRevealT < 0) this._finishRevealT = time;
    if (this._finishDone) return;

    const e = time - this._finishRevealT;
    const DELAYS = [0.45, 0.62, 0.79, 0.96, 1.13];
    const DUR = 0.85;
    const pT = easeOutCubic(clamp01((e - DELAYS[0]) / DUR));
    const pS = easeOutCubic(clamp01((e - DELAYS[1]) / DUR));
    const pD = easeOutCubic(clamp01((e - DELAYS[2]) / DUR));
    const pA = easeOutCubic(clamp01((e - DELAYS[3]) / DUR));
    const pP = easeOutCubic(clamp01((e - DELAYS[4]) / DUR));

    this.fTime.textContent = fmtTime(f.time * pT);
    this.fSpeed.textContent = Math.round(f.topSpeed * pS);
    this.fDrift.textContent = Math.round(f.drift * pD).toLocaleString('en-US');
    this.fAir.textContent = (f.air * pA).toFixed(1);
    this.fProps.textContent = Math.round(f.props * pP);
    if (pP >= 1) this._finishDone = true;
  }

  // =========================================================================
  // STYLE
  // =========================================================================
  _injectStyle() {
    const css = String.raw`
:root {
  --ax-mag: #ff2d78;
  --ax-org: #ff9a3d;
  --ax-yel: #ffe14d;
  --ax-cyan: #3dfff4;
  --ax-ink: rgba(8, 5, 10, 0.72);
  --ax-grad: linear-gradient(100deg, #ff2d78 0%, #ff9a3d 70%, #ffe14d 100%);
}
.ax, .ax * { box-sizing: border-box; margin: 0; padding: 0; }
.ax {
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font-family: 'Arial Narrow', 'Helvetica Neue', Impact, Arial, sans-serif;
  color: #fff; user-select: none;
  -webkit-font-smoothing: antialiased;
}
.ax-stage { position: absolute; inset: 0; will-change: transform; }
.ax-stage.ax-punch { animation: axPunch 0.28s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes axPunch {
  0% { transform: scale(1.018); }
  100% { transform: scale(1); }
}

/* ---- grain ---- */
.ax-grain {
  position: absolute; inset: 0; opacity: 0.5; mix-blend-mode: overlay;
  background-repeat: repeat; pointer-events: none;
}

/* =========================== TITLE ================================= */
.ax-title {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  opacity: 0; visibility: hidden;
  transition: opacity 0.45s ease, visibility 0s linear 0.45s;
}
.ax[data-phase="menu"] .ax-title { opacity: 1; visibility: visible; transition: opacity 0.6s ease; }
.ax-title-scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(130% 100% at 50% 20%, rgba(20, 8, 16, 0.42) 0%, rgba(6, 3, 6, 0.88) 78%),
    linear-gradient(0deg, rgba(4, 2, 4, 0.92) 0%, rgba(4, 2, 4, 0.15) 34%);
}
.ax-title-slash {
  position: absolute; top: -12%; height: 124%; width: 10px;
  background: var(--ax-grad); opacity: 0.65;
  transform: skewX(-18deg);
  filter: drop-shadow(0 0 18px rgba(255, 45, 120, 0.6));
}
.ax-title-slash.s1 { left: 6%; }
.ax-title-slash.s2 { right: 6%; width: 4px; opacity: 0.4; }
.ax-title-mid { position: relative; text-align: center; transform: skewX(-4deg); }
.ax-logo {
  font-size: clamp(110px, 19vw, 300px); line-height: 0.86;
  font-weight: 900; font-style: italic; font-stretch: condensed;
  letter-spacing: 0.02em;
  background: linear-gradient(100deg,
    #ff2d78 0%, #ff9a3d 28%, #ffe14d 42%, #fff6d8 50%, #ffe14d 58%, #ff9a3d 72%, #ff2d78 100%);
  background-size: 320% 100%;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 4px 0 rgba(90, 8, 40, 0.9)) drop-shadow(0 0 34px rgba(255, 45, 120, 0.38));
  animation: axSheen 4.2s ease-in-out infinite;
}
@keyframes axSheen {
  0%, 12% { background-position: 110% 0; }
  55%, 100% { background-position: -60% 0; }
}
.ax-logo-sub {
  display: flex; align-items: center; justify-content: center; gap: 16px;
  margin-top: 10px;
  font-size: clamp(18px, 2.6vw, 36px); font-weight: 700; font-style: italic;
  letter-spacing: 0.52em; text-indent: 0.52em; color: #f4e9ef;
  text-shadow: 0 0 18px rgba(255, 154, 61, 0.55);
}
.ax-rule { display: block; width: clamp(40px, 7vw, 110px); height: 2px; background: var(--ax-grad); opacity: 0.8; }
.ax-tagline {
  margin-top: 16px; font-size: clamp(11px, 1.2vw, 16px); font-weight: 700;
  letter-spacing: 0.34em; text-indent: 0.34em; color: rgba(255, 255, 255, 0.62);
}
.ax-legend {
  position: relative; margin-top: clamp(20px, 4vh, 48px);
  display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 26px;
  max-width: 900px;
}
.ax-key-row { display: flex; align-items: center; gap: 8px; }
.ax-keys { display: flex; gap: 5px; }
.ax-kbd {
  font-family: inherit; font-weight: 700; font-size: 12px; letter-spacing: 0.1em;
  padding: 4px 9px; border: 1px solid rgba(255, 255, 255, 0.32); border-radius: 4px;
  background: rgba(255, 255, 255, 0.06); color: #fff;
  box-shadow: 0 2px 0 rgba(255, 255, 255, 0.14) inset, 0 -2px 0 rgba(0, 0, 0, 0.5) inset;
}
.ax-key-act { font-size: 12px; font-weight: 700; letter-spacing: 0.28em; color: rgba(255, 255, 255, 0.5); }
.ax-press {
  position: relative; margin-top: clamp(18px, 4vh, 44px);
  font-size: clamp(16px, 2vw, 26px); font-weight: 900; font-style: italic;
  letter-spacing: 0.3em; display: flex; align-items: center; gap: 10px;
  animation: axPressPulse 1.5s ease-in-out infinite;
}
.ax-kbd-hot {
  font-size: 0.8em; border-color: transparent;
  background: var(--ax-grad); color: #1a0510;
  box-shadow: 0 0 22px rgba(255, 90, 90, 0.55);
}
@keyframes axPressPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.985); }
}

/* =========================== COUNTDOWN ============================= */
.ax-countwrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.ax-count {
  position: relative; top: -6%;
  font-size: clamp(140px, 26vw, 380px); font-weight: 900; font-style: italic;
  letter-spacing: -0.02em; opacity: 0; color: #fff;
  text-shadow:
    -5px 0 0 rgba(255, 45, 120, 0.85),
    5px 0 0 rgba(61, 255, 244, 0.75),
    0 0 60px rgba(255, 154, 61, 0.5);
  will-change: transform, opacity, filter;
}
.ax-count.go {
  background: var(--ax-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  text-shadow: none;
  filter: drop-shadow(-4px 0 0 rgba(255, 45, 120, 0.7)) drop-shadow(4px 0 0 rgba(61, 255, 244, 0.55)) drop-shadow(0 0 46px rgba(255, 154, 61, 0.8));
}
.ax-count.stamp { animation: axStamp 0.92s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
@keyframes axStamp {
  0% { opacity: 0; transform: scale(3) rotate(2deg); filter: blur(20px); }
  26% { opacity: 1; transform: scale(0.98) rotate(-1deg); filter: blur(0); }
  36% { transform: scale(1.05); }
  46% { transform: scale(1); }
  78% { opacity: 1; }
  100% { opacity: 0; transform: scale(0.9); filter: blur(3px); }
}
.ax-goflash { position: absolute; inset: 0; background: radial-gradient(80% 60% at 50% 45%, rgba(255, 230, 200, 0.85), rgba(255, 45, 120, 0) 70%); opacity: 0; }
.ax-goflash.on { animation: axGoFlash 0.5s ease-out forwards; }
@keyframes axGoFlash { 0% { opacity: 0.9; } 100% { opacity: 0; } }

/* =========================== HUD =================================== */
.ax-hud {
  position: absolute; inset: 0;
  opacity: 0; visibility: hidden;
  transition: opacity 0.4s ease, visibility 0s linear 0.4s;
}
.ax[data-phase="countdown"] .ax-hud,
.ax[data-phase="racing"] .ax-hud {
  opacity: 1; visibility: visible; transition: opacity 0.4s ease;
}
.ax[data-phase="countdown"] .ax-hud { animation: axHudIn 0.7s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes axHudIn {
  0% { opacity: 0; transform: translateY(26px); }
  100% { opacity: 1; transform: translateY(0); }
}
.ax-panel {
  background: linear-gradient(160deg, rgba(20, 12, 18, 0.78), rgba(8, 5, 10, 0.68));
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-left: 3px solid var(--ax-mag);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(3px);
}

/* ---- top cluster ---- */
.ax-top {
  position: absolute; top: 18px; left: 50%; transform: translateX(-50%) skewX(-8deg);
  display: flex; align-items: stretch; gap: 10px;
}
.ax-top > .ax-panel { padding: 8px 18px; display: flex; align-items: baseline; }
.ax-pos { border-left-color: var(--ax-org); }
.ax-pos-n {
  font-size: 34px; font-weight: 900; font-style: italic; line-height: 1;
  color: #fff; display: inline-block;
}
.ax-pos-n.pop { animation: axPop 0.35s cubic-bezier(0.22, 1.6, 0.36, 1); }
.ax-pos-t { font-size: 16px; font-weight: 700; color: rgba(255, 255, 255, 0.45); margin-left: 2px; }
.ax-timerbox { position: relative; flex-direction: column; align-items: center; justify-content: center; min-width: 176px; }
.ax-timer {
  font-size: 30px; font-weight: 900; line-height: 1.1; letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}
.ax-split {
  position: absolute; left: 50%; top: 100%; margin-top: 9px; transform: translateX(-50%);
  font-size: 21px; font-weight: 900; font-style: italic; letter-spacing: 0.05em;
  font-variant-numeric: tabular-nums; opacity: 0; white-space: nowrap;
  padding: 3px 12px; background: rgba(8, 5, 10, 0.7);
}
.ax-split.good { color: #5dffa1; text-shadow: 0 0 14px rgba(93, 255, 161, 0.6); }
.ax-split.bad { color: #ff5d6e; text-shadow: 0 0 14px rgba(255, 93, 110, 0.6); }
.ax-split.neutral { color: #ffe14d; }
.ax-split.flash { animation: axSplit 1.8s ease-out forwards; }
@keyframes axSplit {
  0% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(1.3); }
  12% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translateX(-50%) translateY(6px); }
}
.ax-cpbox { border-left-color: var(--ax-yel); }
.ax-cpbox.chime { animation: axChime 0.5s ease-out; }
@keyframes axChime {
  0% { box-shadow: 0 0 0 0 rgba(255, 225, 77, 0.8); }
  100% { box-shadow: 0 0 0 16px rgba(255, 225, 77, 0); }
}
.ax-cp-lab { font-size: 15px; font-weight: 700; letter-spacing: 0.2em; color: rgba(255, 255, 255, 0.5); }
.ax-cp-n { font-size: 30px; font-weight: 900; font-style: italic; line-height: 1; }
.ax-cp-t { font-size: 15px; font-weight: 700; color: rgba(255, 255, 255, 0.45); }
@keyframes axPop {
  0% { transform: scale(1.45); }
  100% { transform: scale(1); }
}

/* ---- speed cluster (bottom-right) ---- */
.ax-speedo {
  position: absolute; right: 26px; bottom: 22px; width: 300px; height: 262px;
  filter: drop-shadow(0 8px 26px rgba(0, 0, 0, 0.5));
}
.ax-gauge { position: absolute; right: 0; bottom: 54px; width: 286px; height: 247px; }
.ax-arc-bg { fill: none; stroke: rgba(255, 255, 255, 0.1); stroke-width: 10; stroke-linecap: round; }
.ax-arc-red { fill: none; stroke: rgba(255, 45, 90, 0.28); stroke-width: 10; stroke-linecap: butt;
  stroke-dasharray: 15 85; stroke-dashoffset: -85; }
.ax-arc-rpm {
  fill: none; stroke: url(#ax-rpm-grad); stroke-width: 10; stroke-linecap: round;
  stroke-dasharray: 100 100; stroke-dashoffset: 100;
  filter: drop-shadow(0 0 6px rgba(255, 100, 90, 0.75));
}
.ax-speedo.boosting .ax-arc-rpm { filter: drop-shadow(0 0 12px rgba(255, 45, 120, 1)); }
.ax-tick { stroke: rgba(255, 255, 255, 0.34); stroke-width: 2; }
.ax-tick-red { stroke: rgba(255, 60, 90, 0.85); }
.ax-needle { transform-box: view-box; transform-origin: 110px 112px; will-change: transform; }
.ax-needle-body { fill: #ff3d6e; filter: drop-shadow(0 0 5px rgba(255, 61, 110, 0.9)); }
.ax-needle-cap { fill: #1a1016; stroke: rgba(255, 255, 255, 0.25); stroke-width: 1.5; }
.ax-needle-pin { fill: #ff9a3d; }
.ax-readout { position: absolute; right: 86px; bottom: 108px; text-align: center; width: 160px; }
.ax-kmh {
  font-size: 78px; font-weight: 900; font-style: italic; line-height: 0.9;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  text-shadow: 0 3px 0 rgba(60, 5, 26, 0.9), 0 0 28px rgba(255, 154, 61, 0.35);
}
.ax-kmh-unit { font-size: 14px; font-weight: 700; letter-spacing: 0.5em; text-indent: 0.5em; color: rgba(255, 255, 255, 0.55); margin-top: 3px; }
.ax-gear {
  position: absolute; right: 22px; bottom: 138px; width: 58px; text-align: center;
  font-size: 56px; font-weight: 900; font-style: italic; line-height: 1;
  background: var(--ax-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 0 12px rgba(255, 45, 120, 0.45));
  will-change: transform;
}
.ax-gear.pop { animation: axPop 0.3s cubic-bezier(0.22, 1.6, 0.36, 1); }
.ax-gear-lab { position: absolute; right: 22px; bottom: 122px; width: 58px; text-align: center;
  font-size: 11px; font-weight: 700; letter-spacing: 0.4em; color: rgba(255, 255, 255, 0.45); }
.ax-boost { position: absolute; right: 0; bottom: 8px; width: 288px; transform: skewX(-14deg); }
.ax-boost-lab { font-size: 12px; font-weight: 900; letter-spacing: 0.42em; color: rgba(255, 255, 255, 0.6); margin-bottom: 5px; margin-left: 2px; }
.ax-boost-bar {
  position: relative; height: 14px; overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
.ax-boost-fill {
  position: absolute; inset: 0; transform-origin: left center;
  background: linear-gradient(90deg, var(--ax-mag), var(--ax-org));
  transition: filter 0.35s ease;
  will-change: transform;
}
.ax-boost.low .ax-boost-fill { filter: saturate(0.15) brightness(0.7); }
.ax-boost-sheen {
  position: absolute; top: 0; bottom: 0; left: -40%; width: 34%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.85), transparent);
  opacity: 0; will-change: transform;
}
.ax-boost.full .ax-boost-sheen { opacity: 1; animation: axShimmer 1.1s linear infinite; }
@keyframes axShimmer {
  0% { transform: translateX(0); }
  100% { transform: translateX(420%); }
}
.ax-boost.ready .ax-boost-bar { animation: axBoostReady 0.7s ease-out; }
@keyframes axBoostReady {
  0% { box-shadow: 0 0 0 0 rgba(255, 154, 61, 0.9); }
  100% { box-shadow: 0 0 0 22px rgba(255, 154, 61, 0); }
}

/* ---- drift (left-center) ---- */
.ax-driftbox {
  position: absolute; left: 42px; top: 50%; transform: translateY(-60%) skewX(-8deg);
  opacity: 0; visibility: hidden;
  transition: opacity 0.18s ease, transform 0.18s ease, visibility 0s linear 0.2s;
  text-align: left;
}
.ax-driftbox.on {
  opacity: 1; visibility: visible; transform: translateY(-64%) skewX(-8deg);
  transition: opacity 0.12s ease, transform 0.25s cubic-bezier(0.22, 1.4, 0.36, 1);
}
.ax-drift-lab {
  font-size: 17px; font-weight: 900; font-style: italic; letter-spacing: 0.5em;
  color: var(--ax-cyan); text-shadow: 0 0 16px rgba(61, 255, 244, 0.7);
}
.ax-drift-pts {
  font-size: 62px; font-weight: 900; font-style: italic; line-height: 1;
  font-variant-numeric: tabular-nums;
  background: var(--ax-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 3px 0 rgba(70, 5, 32, 0.9)) drop-shadow(0 0 20px rgba(255, 45, 120, 0.4));
}
.ax-flyaways { position: absolute; left: 42px; top: 50%; }
.ax-fly {
  position: absolute; left: 0; top: 0; white-space: nowrap;
  font-size: 30px; font-weight: 900; font-style: italic; letter-spacing: 0.04em;
  color: #ffe14d; text-shadow: 0 2px 0 rgba(80, 40, 0, 0.9), 0 0 22px rgba(255, 225, 77, 0.65);
  opacity: 0; transform: skewX(-8deg); will-change: transform, opacity;
}
.ax-fly.big { font-size: 42px; color: #fff;
  text-shadow: 0 2px 0 rgba(90, 8, 40, 0.9), 0 0 12px rgba(255, 45, 120, 0.9), 0 0 34px rgba(255, 154, 61, 0.8); }
.ax-fly.fly { animation: axFly 1.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
@keyframes axFly {
  0% { opacity: 0; transform: skewX(-8deg) translateY(10px) scale(1.5); }
  14% { opacity: 1; transform: skewX(-8deg) translateY(0) scale(1); }
  70% { opacity: 1; transform: skewX(-8deg) translateY(-64px); }
  100% { opacity: 0; transform: skewX(-8deg) translateY(-100px) scale(0.92); }
}

/* ---- center callouts ---- */
.ax-msgs { position: absolute; left: 0; right: 0; top: 24%; pointer-events: none; }
.ax-msg {
  position: absolute; left: 50%; top: 0; transform: translateX(-50%);
  text-align: center; opacity: 0; white-space: nowrap; will-change: transform, opacity;
}
.ax-msg-text {
  font-weight: 900; font-style: italic; letter-spacing: 0.03em; line-height: 1;
}
.ax-msg.info .ax-msg-text { font-size: clamp(26px, 3.4vw, 44px); color: #fff;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.6), 0 0 22px rgba(120, 200, 255, 0.4); }
.ax-msg.epic .ax-msg-text {
  font-size: clamp(48px, 7.5vw, 104px);
  background: var(--ax-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 4px 0 rgba(80, 6, 36, 0.95)) drop-shadow(0 0 34px rgba(255, 90, 60, 0.55));
}
.ax-msg.warn .ax-msg-text { font-size: clamp(34px, 4.6vw, 62px); color: #ffb13d;
  text-shadow: 0 2px 0 rgba(60, 26, 0, 0.9), 0 0 26px rgba(255, 177, 61, 0.75);
  animation: axWarnBlink 0.22s steps(2, jump-none) infinite; }
@keyframes axWarnBlink { 0% { opacity: 1; } 100% { opacity: 0.55; } }
.ax-msg-under { height: 0; margin: 6px auto 0; width: 0; }
.ax-msg.epic .ax-msg-under {
  height: 5px; width: 78%;
  background: var(--ax-grad);
  box-shadow: 0 0 24px rgba(255, 154, 61, 0.9);
  transform: scaleX(0); transform-origin: center;
  animation: axUnder 0.55s 0.12s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes axUnder {
  0% { transform: scaleX(0); }
  60% { transform: scaleX(1.06); }
  100% { transform: scaleX(1); }
}
.ax-msg-sub {
  margin-top: 8px; font-size: clamp(13px, 1.4vw, 19px); font-weight: 700;
  letter-spacing: 0.4em; text-indent: 0.4em; color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.7);
}
.ax-msg.show { animation-name: axMsg; animation-timing-function: ease-out; animation-fill-mode: forwards; }
@keyframes axMsg {
  0% { opacity: 0; transform: translateX(-50%) translateY(14px) scale(1.24); filter: blur(6px); }
  9% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); filter: blur(0); }
  82% { opacity: 1; transform: translateX(-50%) translateY(-4px); }
  100% { opacity: 0; transform: translateX(-50%) translateY(-16px) scale(0.96); }
}

/* ---- wrong way ---- */
.ax-wrong { position: absolute; inset: 0; opacity: 0; visibility: hidden;
  transition: opacity 0.25s ease, visibility 0s linear 0.25s; }
.ax-wrong.on { opacity: 1; visibility: visible; transition: opacity 0.15s ease; }
.ax-wrong::before {
  content: ''; position: absolute; inset: 0;
  box-shadow: inset 0 0 140px 30px rgba(255, 20, 40, 0.55);
  animation: axWrongPulse 0.7s ease-in-out infinite;
}
@keyframes axWrongPulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
.ax-wrong-inner {
  position: absolute; left: 50%; top: 33%; transform: translate(-50%, -50%);
  text-align: center; color: #ff3548;
}
.ax-wrong-arrow { width: 84px; height: 84px; margin-bottom: 4px;
  filter: drop-shadow(0 0 16px rgba(255, 53, 72, 0.8));
  animation: axWrongPulse 0.7s ease-in-out infinite; }
.ax-wrong-text {
  font-size: clamp(38px, 5vw, 64px); font-weight: 900; font-style: italic; line-height: 1;
  color: #ff3548; text-shadow: 0 0 30px rgba(255, 20, 40, 0.8), 0 2px 0 rgba(40, 0, 4, 0.9);
  letter-spacing: 0.06em;
}
.ax-wrong-sub { margin-top: 6px; font-size: 15px; font-weight: 700; letter-spacing: 0.5em;
  text-indent: 0.5em; color: rgba(255, 255, 255, 0.8); }

/* ---- speed lines vignette ---- */
.ax-lines { position: absolute; inset: 0; opacity: 0; will-change: opacity; }
.ax-lines-spin {
  position: absolute; left: 50%; top: 50%; width: 160vmax; height: 160vmax;
  transform: translate(-50%, -50%);
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    transparent 0deg 5.2deg,
    rgba(255, 255, 255, 0.11) 5.2deg 5.9deg,
    transparent 5.9deg 9.4deg,
    rgba(255, 210, 190, 0.07) 9.4deg 9.9deg);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 0 26%, #000 58%);
  mask-image: radial-gradient(circle at 50% 50%, transparent 0 26%, #000 58%);
  animation: axLinesJitter 0.4s steps(3, jump-none) infinite;
  will-change: transform;
}
@keyframes axLinesJitter {
  0% { transform: translate(-50%, -50%) rotate(0deg) scale(1); }
  50% { transform: translate(-50%, -50%) rotate(2.4deg) scale(1.01); }
  100% { transform: translate(-50%, -50%) rotate(-1.8deg) scale(1); }
}

/* ---- minimap (bottom-left) ---- */
.ax-map {
  position: absolute; left: 26px; bottom: 22px; width: 184px; height: 184px;
  padding: 8px; transform: skewX(-4deg);
  border-left-color: var(--ax-org);
  opacity: 0; visibility: hidden; transition: opacity 0.4s ease, visibility 0s linear 0.4s;
}
.ax[data-phase="countdown"] .ax-map,
.ax[data-phase="racing"] .ax-map { opacity: 1; visibility: visible; transition: opacity 0.4s ease; }
.ax-map-svg { position: absolute; left: 8px; top: 8px; width: 168px; height: 168px; transform: skewX(4deg); }
.ax-map-route-glow { fill: none; stroke: rgba(255, 45, 120, 0.35); stroke-width: 5.5; stroke-linejoin: round; stroke-linecap: round; }
.ax-map-route { fill: none; stroke: rgba(255, 255, 255, 0.85); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.ax-map-cp { fill: rgba(10, 8, 12, 0.9); stroke: rgba(255, 225, 77, 0.75); stroke-width: 1.2; }
.ax-map-cp.hit { fill: #ffe14d; stroke: #fff; }
.ax-map-start { fill: none; stroke: rgba(255, 255, 255, 0.5); stroke-width: 1.2; }
.ax-map-dots { position: absolute; left: 8px; top: 8px; width: 168px; height: 168px; transform: skewX(4deg); }
.ax-dot { position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; border-radius: 50%; will-change: transform; }
.ax-dot-me {
  width: 10px; height: 10px; left: -5px; top: -5px;
  background: #fff; box-shadow: 0 0 0 2px rgba(255, 45, 120, 0.95), 0 0 14px rgba(255, 45, 120, 0.9);
}
.ax-dot-me::after {
  content: ''; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid rgba(255, 45, 120, 0.8);
  animation: axPing 1.2s ease-out infinite;
}
@keyframes axPing {
  0% { transform: scale(0.6); opacity: 1; }
  100% { transform: scale(1.9); opacity: 0; }
}
.ax-dot-ai.a0 { background: #3dfff4; box-shadow: 0 0 8px rgba(61, 255, 244, 0.8); }
.ax-dot-ai.a1 { background: #b06bff; box-shadow: 0 0 8px rgba(176, 107, 255, 0.8); }
.ax-dot-ai.a2 { background: #7dff5d; box-shadow: 0 0 8px rgba(125, 255, 93, 0.8); }

/* =========================== FINISH ================================ */
.ax-finish {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(110% 90% at 50% 40%, rgba(10, 4, 8, 0.28) 0%, rgba(5, 2, 4, 0.78) 100%);
  opacity: 0; visibility: hidden; transition: opacity 0.3s ease, visibility 0s linear 0.3s;
}
.ax[data-phase="finished"] .ax-finish { opacity: 1; visibility: visible; transition: opacity 0.35s ease; }
.ax-card {
  position: relative; width: min(560px, 86vw); padding: 34px 46px 30px;
  transform: skewX(-4deg);
  background: linear-gradient(165deg, rgba(26, 14, 22, 0.94), rgba(8, 4, 8, 0.92));
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-top: 4px solid transparent;
  border-image: linear-gradient(90deg, #ff2d78, #ff9a3d, #ffe14d) 1;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.7), 0 0 60px rgba(255, 45, 120, 0.18);
}
.ax[data-phase="finished"] .ax-card { animation: axSlam 0.65s cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes axSlam {
  0% { opacity: 0; transform: skewX(-4deg) translateY(-70px) scale(1.28); filter: blur(12px); }
  55% { opacity: 1; transform: skewX(-4deg) translateY(6px) scale(0.99); filter: blur(0); }
  75% { transform: skewX(-4deg) translateY(-3px) scale(1.005); }
  100% { transform: skewX(-4deg) translateY(0) scale(1); }
}
.ax-card-kicker { font-size: 13px; font-weight: 900; letter-spacing: 0.55em; color: rgba(255, 255, 255, 0.5); }
.ax-fpos {
  font-size: 118px; font-weight: 900; font-style: italic; line-height: 0.95; margin-top: 4px;
  color: #fff; text-shadow: 0 4px 0 rgba(60, 6, 28, 0.9);
}
.ax-fpos.win {
  background: var(--ax-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  filter: drop-shadow(0 4px 0 rgba(90, 8, 40, 0.9)) drop-shadow(0 0 38px rgba(255, 154, 61, 0.6));
}
.ax-fsub {
  font-size: clamp(17px, 2vw, 24px); font-weight: 900; font-style: italic;
  letter-spacing: 0.3em; color: #ffe14d; margin: 2px 0 22px;
  text-shadow: 0 0 20px rgba(255, 225, 77, 0.5);
}
.ax-frows { display: flex; flex-direction: column; gap: 9px; }
.ax-frow {
  display: flex; align-items: baseline; gap: 10px;
  padding: 7px 14px; background: rgba(255, 255, 255, 0.045);
  border-left: 3px solid var(--ax-mag);
  opacity: 0; animation: axRowIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.ax-frow:nth-child(2) { border-left-color: var(--ax-org); }
.ax-frow:nth-child(3) { border-left-color: var(--ax-yel); }
.ax-frow:nth-child(4) { border-left-color: var(--ax-cyan); }
.ax-frow:nth-child(5) { border-left-color: #b06bff; }
@keyframes axRowIn {
  0% { opacity: 0; transform: translateX(-26px); }
  100% { opacity: 1; transform: translateX(0); }
}
.ax-frow-lab { flex: 1; font-size: 13px; font-weight: 900; letter-spacing: 0.34em; color: rgba(255, 255, 255, 0.55); }
.ax-frow-val {
  font-size: 30px; font-weight: 900; font-style: italic; line-height: 1;
  font-variant-numeric: tabular-nums; color: #fff;
}
.ax-frow-unit { font-size: 12px; font-weight: 700; letter-spacing: 0.2em; color: rgba(255, 255, 255, 0.45); }
.ax-again {
  margin-top: 24px; text-align: center;
  font-size: 17px; font-weight: 900; font-style: italic; letter-spacing: 0.32em;
  color: #fff; animation: axPressPulse 1.4s ease-in-out infinite;
}

/* finished: hide HUD except minimal timer */
.ax[data-phase="finished"] .ax-hud { opacity: 1; visibility: visible; }
.ax[data-phase="finished"] .ax-speedo,
.ax[data-phase="finished"] .ax-pos,
.ax[data-phase="finished"] .ax-cpbox,
.ax[data-phase="finished"] .ax-split,
.ax[data-phase="finished"] .ax-driftbox,
.ax[data-phase="finished"] .ax-map,
.ax[data-phase="finished"] .ax-lines,
.ax[data-phase="finished"] .ax-wrong { opacity: 0 !important; visibility: hidden !important; }
.ax[data-phase="finished"] .ax-timerbox {
  background: none; border: none; box-shadow: none; backdrop-filter: none;
}
.ax[data-phase="finished"] .ax-timer { opacity: 0.55; font-size: 22px; }

/* ---- mute tag ---- */
.ax-mutetag {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  font-size: 11px; font-weight: 900; letter-spacing: 0.45em; text-indent: 0.45em;
  color: rgba(255, 255, 255, 0.55); padding: 4px 12px;
  background: rgba(8, 5, 10, 0.6); border: 1px solid rgba(255, 255, 255, 0.12);
  opacity: 0; transition: opacity 0.25s ease;
}
.ax-mutetag.on { opacity: 1; }

@media (max-width: 860px) {
  .ax-speedo { transform: scale(0.78); transform-origin: right bottom; }
  .ax-map { transform: skewX(-4deg) scale(0.8); transform-origin: left bottom; }
  .ax-legend { max-width: 92vw; }
}
`;
    const style = document.createElement('style');
    style.id = 'ax-ui-style';
    style.textContent = css;
    document.head.appendChild(style);
  }
}
