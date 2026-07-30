// FX-lead probe: high-quality run, event telemetry, forced drift/boost moments,
// screenshots timed to explosions / water ford / finish fireworks, live particle counts.
// Usage: node qa/probe-fxlead.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });
const TAG = 'fxlead';
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
    try {
      const r = await fetch('http://127.0.0.1:5173/index.html');
      if (r.ok) return;
    } catch {}
  }
  throw new Error('static server failed to start');
}

const AUTOPILOT = `
(() => {
  if (window.__AP_TIMER__) return;
  window.__AP_PAUSE__ = false;
  window.__AP_TIMER__ = setInterval(() => {
    if (window.__AP_PAUSE__) return;
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
      steer,
      throttle: hardTurn ? 0.15 : 1,
      brake: hardTurn ? 0.7 : 0,
      boost: Math.abs(aFar) < 0.1 && sp > 28 && car.boost > 0.35,
      handbrake: false,
    };
  }, 33);
})();
`;

// hooks event counters + live particle counter helper into the page
const HOOKS = `
(() => {
  const g = window.__APEX_GAME__;
  if (!g || window.__EVC__) return;
  const evc = window.__EVC__ = {};
  const names = ['car:collision','car:jump','car:landed','drift:start','drift:end','boost:start','boost:end',
    'prop:break','setpiece:rockslide','setpiece:collapse','setpiece:explosion','weather:lightning','race:finish'];
  window.__LASTEXP__ = 0; window.__LASTLIGHT__ = 0;
  for (const n of names) {
    evc[n] = 0;
    g.events.on(n, () => {
      evc[n]++;
      if (n === 'setpiece:explosion') window.__LASTEXP__ = performance.now();
      if (n === 'weather:lightning') window.__LASTLIGHT__ = performance.now();
    });
  }
  window.__LIVE__ = () => {
    const count = (pool) => {
      const d = pool._data, cap = pool.capacity, t = pool.material.uniforms.uTime.value;
      let n = 0;
      for (let i = 0; i < cap; i++) {
        const o = i * 24, st = d[o], life = d[o + 1];
        if (life > 0.002 && t >= st && t < st + life) n++;
      }
      return n;
    };
    return { smoke: count(g.vfx.smoke), glow: count(g.vfx.glow) };
  };
})();
`;

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  const log = [];
  page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => { log.push(`[pageerror] ${e.message}`); console.log('[pageerror]', e.message); });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
    console.log(`[shot] ${TAG}-${name}.png`);
  };

  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
  await page.keyboard.press('Enter');
  await page.evaluate(AUTOPILOT);
  await page.evaluate(HOOKS);
  await new Promise((r) => setTimeout(r, 4200));

  const getS = () => page.evaluate(() => {
    const s = window.__APEX_STATE__;
    const w = s.weather;
    return {
      phase: s.phase, progress: +s.progress.toFixed(4), speed: Math.round(s.car.speedKmh),
      surface: s.car.surface, boosting: s.car.boosting, drifting: s.car.drifting,
      slips: s.car.wheels.map((x) => +x.slip.toFixed(2)),
      weather: { rain: +w.rain.toFixed(2), wet: +w.wetness.toFixed(2), fog: +w.fog.toFixed(2), sunset: +w.sunset.toFixed(2), windX: +w.windX.toFixed(1), windZ: +w.windZ.toFixed(1), light: +w.lightning.toFixed(2) },
      live: window.__LIVE__(), evc: window.__EVC__,
      lastExpAgoMs: window.__LASTEXP__ ? Math.round(performance.now() - window.__LASTEXP__) : -1,
    };
  });

  // ---- moment 1: forced handbrake drift on the sweepers (~progress 0.04-0.1)
  let driftDone = false, boostDone = false, waterDone = false, expShots = 0;
  const t0 = Date.now();
  let mi = 0;
  const marks = [[0.09, 'a-sweepers'], [0.2, 'b-drift-zone'], [0.45, 'c-forest-rain'], [0.58, 'd-tunnel'], [0.66, 'e-loop'], [0.94, 'k-finish-straight']];

  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 300));
    const s = await getS();
    if (s.phase === 'finished') {
      await new Promise((r) => setTimeout(r, 700));
      await shot('m-finish-1s');
      await new Promise((r) => setTimeout(r, 2000));
      await shot('n-finish-3s');
      await new Promise((r) => setTimeout(r, 2200));
      await shot('o-finish-5s');
      console.log('[final]', JSON.stringify(await getS()));
      break;
    }
    if (s.phase !== 'racing') continue;

    if (mi < marks.length && s.progress >= marks[mi][0]) {
      console.log(`[state@${marks[mi][1]}]`, JSON.stringify(s));
      await shot(marks[mi][1]);
      mi++;
    }

    // forced drift on asphalt sweeper
    if (!driftDone && s.progress > 0.045 && s.progress < 0.12 && s.speed > 110) {
      driftDone = true;
      await page.evaluate(() => {
        window.__AP_PAUSE__ = true;
        window.__APEX_QA__ = { throttle: 1, brake: 0, steer: 0.85, handbrake: true, boost: false };
      });
      await new Promise((r) => setTimeout(r, 900));
      await page.evaluate(() => { window.__APEX_QA__ = { throttle: 1, brake: 0, steer: -0.5, handbrake: false, boost: false }; });
      await new Promise((r) => setTimeout(r, 500));
      console.log('[state@drift]', JSON.stringify(await getS()));
      await shot('f-forced-drift');
      await page.evaluate(() => { window.__AP_PAUSE__ = false; });
    }

    // forced boost on a straight
    if (!boostDone && driftDone && s.progress > 0.13 && s.speed > 80) {
      boostDone = true;
      await page.evaluate(() => {
        window.__AP_PAUSE__ = true;
        window.__APEX_QA__ = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: true };
      });
      await new Promise((r) => setTimeout(r, 900));
      console.log('[state@boost]', JSON.stringify(await getS()));
      await shot('g-forced-boost');
      await page.evaluate(() => { window.__AP_PAUSE__ = false; });
    }

    // water ford
    if (!waterDone && s.surface === 'water') {
      waterDone = true;
      await new Promise((r) => setTimeout(r, 350));
      console.log('[state@water]', JSON.stringify(await getS()));
      await shot('h-water-ford');
    }

    // explosion just happened → shoot immediately
    if (expShots < 3 && s.lastExpAgoMs >= 0 && s.lastExpAgoMs < 900) {
      console.log('[state@explosion]', JSON.stringify(s));
      await shot(`i-explosion-${++expShots}`);
    }
  }

  fs.writeFileSync(path.join(OUT, `${TAG}-console.log`), log.join('\n'));
  console.log(`[console] ${log.length} lines`);
  await browser.close();
}

main().catch((e) => { console.error('[probe] failed:', e.message); process.exit(1); });
