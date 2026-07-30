// Audio-review probe: full autopilot race with WebAudio running.
// Measures: master peak levels (clipping hunt), tunnel reverb send vs progress,
// rain bed vs weather.rain, engine freq/rpm mapping, event coverage
// (audio:sfx names emitted, thunder doubling), countdown rev behavior.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });
const SECS = 260;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function ensureServer() {
  try {
    const r = await fetch('http://127.0.0.1:5173/index.html');
    if (r.ok) return;
  } catch {}
  const proc = spawn('python3', ['-m', 'http.server', '5173', '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', detached: true,
  });
  proc.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch('http://127.0.0.1:5173/index.html'); if (r.ok) return; } catch {}
  }
  throw new Error('server failed');
}

const AUTOPILOT = `
(() => {
  if (window.__AP_TIMER__) return;
  window.__AP_TIMER__ = setInterval(() => {
    const g = window.__APEX_GAME__;
    if (!g || !g.track) return;
    const s = g.state;
    if (s.phase !== 'racing') { window.__APEX_QA__ = { throttle: 0, brake: 0, steer: 0, boost: false, handbrake: false }; return; }
    const car = s.car, q = car.quaternion, p = car.position;
    const sp = Math.hypot(car.velocity.x, car.velocity.y, car.velocity.z);
    const L = 8052;
    const near = g.track.sample(Math.min(0.9995, s.progress + Math.max(14, sp * 0.85) / L));
    const nx = near.position.x - p.x, ny = near.position.y - p.y, nz = near.position.z - p.z;
    const far = g.track.sample(Math.min(0.9995, s.progress + Math.max(30, sp * 1.7) / L));
    const gx = far.position.x - p.x, gy = far.position.y - p.y, gz = far.position.z - p.z;
    const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x);
    const ang = (tx, ty, tz) => {
      const cxx = fy * tz - fz * ty, cyy = fz * tx - fx * tz, czz = fx * ty - fy * tx;
      return Math.atan2(cxx * ux + cyy * uy + czz * uz, fx * tx + fy * ty + fz * tz);
    };
    const aNear = ang(nx, ny, nz), aFar = ang(gx, gy, gz);
    const steer = Math.max(-1, Math.min(1, -aNear * 2.0));
    const hardTurn = Math.abs(aFar) > 0.5 && sp > 24;
    window.__APEX_QA__ = {
      steer, throttle: hardTurn ? 0.15 : 1, brake: hardTurn ? 0.7 : 0,
      boost: Math.abs(aFar) < 0.1 && sp > 28 && car.boost > 0.35, handbrake: false,
    };
  }, 33);
})();
`;

const INSTRUMENT = `
(() => {
  const g = window.__APEX_GAME__;
  const T = (window.__AUDIT__ = {
    sfxNames: {}, lightning: 0, thunderSfx: 0, samples: [], acState: 'n/a',
    peak: 0, clip: 0, blocks: 0, peakAt: [],
  });
  const em = g.events.emit.bind(g.events);
  g.events.emit = (name, p) => {
    if (name === 'audio:sfx' && p && p.name) T.sfxNames[p.name] = (T.sfxNames[p.name] || 0) + 1;
    if (name === 'weather:lightning') T.lightning++;
    if (name === 'audio:sfx' && p && p.name === 'thunder') T.thunderSfx++;
    return em(name, p);
  };
  // Tap the post-limiter master for true output peaks.
  const tap = () => {
    const a = g.audio;
    if (!a || !a.ready || !a.ac || window.__TAPPED__) return;
    window.__TAPPED__ = true;
    const an = a.ac.createAnalyser();
    an.fftSize = 2048;
    a.outGain.connect(an);
    const buf = new Float32Array(an.fftSize);
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let pk = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; }
      T.blocks++;
      if (pk > T.peak) T.peak = pk;
      if (pk > 0.999) { T.clip++; T.peakAt.push(+g.state.progress.toFixed(3)); }
      T.lastPk = pk;
    }, 50);
  };
  setInterval(() => {
    tap();
    const a = g.audio, s = g.state;
    if (!a || !a.ready) return;
    T.acState = a.ac.state;
    T.samples.push({
      t: +(performance.now() / 1000).toFixed(1),
      phase: s.phase,
      p: +s.progress.toFixed(4),
      rpm: +(s.car.rpm || 0).toFixed(3),
      gear: s.car.gear,
      f: +(a.e ? a.e.sawA.frequency.value : 0).toFixed(1),
      eg: +(a.e ? a.e.out.gain.value : 0).toFixed(3),
      tun: +(a.e ? a.e.tunnelSend.gain.value : 0).toFixed(3),
      rain: +(s.weather.rain || 0).toFixed(2),
      rainG: +(a.b ? a.b.rainGain.gain.value : 0).toFixed(4),
      pk: +(T.lastPk || 0).toFixed(3),
      surf: s.car.surface,
    });
  }, 400);
})();
`;

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720',
      '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1500));

  await page.keyboard.press('Enter');
  await page.evaluate(AUTOPILOT);
  await page.evaluate(INSTRUMENT);

  // During countdown, hold throttle for 1 s to test rev behavior.
  await new Promise((r) => setTimeout(r, 600));
  await page.keyboard.down('KeyW');
  const rev = await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    return new Promise((res) => setTimeout(() => res({
      phase: g.state.phase, rpm: g.state.car.rpm,
      f: g.audio.e ? g.audio.e.sawA.frequency.value : 0,
      ac: g.audio.ac ? g.audio.ac.state : 'none', ready: g.audio.ready,
    }), 1000));
  });
  await page.keyboard.up('KeyW');
  console.log('[countdown-rev]', JSON.stringify(rev));

  const t0 = Date.now();
  let finished = false;
  let lastMove = Date.now(), lastProgress = 0;
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await page.evaluate(() => ({
      phase: window.__APEX_STATE__.phase, p: window.__APEX_STATE__.progress,
    }));
    if (s.phase === 'finished') { finished = true; await new Promise((r) => setTimeout(r, 3000)); break; }
    if (s.p > lastProgress + 0.001) { lastProgress = s.p; lastMove = Date.now(); }
    if (s.phase === 'racing' && Date.now() - lastMove > 12000) { await page.keyboard.press('KeyR'); lastMove = Date.now(); }
  }
  console.log('[race] finished =', finished);

  const audit = await page.evaluate(() => {
    const T = window.__AUDIT__;
    return { sfxNames: T.sfxNames, lightning: T.lightning, thunderSfx: T.thunderSfx,
      acState: T.acState, peak: T.peak, clipBlocks: T.clip, blocks: T.blocks,
      peakAt: T.peakAt.slice(0, 30), nSamples: T.samples.length };
  });
  console.log('[audit]', JSON.stringify(audit, null, 1));
  const samples = await page.evaluate(() => window.__AUDIT__.samples);
  fs.writeFileSync(path.join(OUT, 'audio1-samples.json'), JSON.stringify(samples));
  fs.writeFileSync(path.join(OUT, 'audio1-console.log'), logs.join('\n'));
  console.log('[done] samples →', samples.length);
  await browser.close();
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
