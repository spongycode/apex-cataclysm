// Camera-subsystem QA probe: telemetry + targeted screenshots at high quality.
// - verifies MENU_SHOTS focus t vs real track markers
// - captures all 5 menu shots
// - records per-frame camera telemetry (fov, cam-car dist, cam/car Y, timeScale, occl, roll)
// - captures big-jump flight, landing, loop (3 points), finish orbit
// Usage: node qa/probe-cam.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });
const TAG = 'cam';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function ensureServer() {
  try { const r = await fetch('http://127.0.0.1:5173/index.html'); if (r.ok) return; } catch {}
  const proc = spawn('python3', ['-m', 'http.server', '5173', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
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
      steer,
      throttle: hardTurn ? 0.15 : 1,
      brake: hardTurn ? 0.7 : 0,
      boost: Math.abs(aFar) < 0.1 && sp > 28 && car.boost > 0.35,
      handbrake: false,
    };
  }, 33);
})();
`;

const RECORDER = `
(() => {
  const g = window.__APEX_GAME__;
  const R = window.__CAMREC__ = { samples: [], events: [] };
  const names = ['time:slowmo','car:jump','car:landed','camera:shake','race:finish','boost:start'];
  for (const n of names) g.events.on(n, (p) => R.events.push({ n, t: performance.now() / 1000,
    prog: +g.state.progress.toFixed(4), kmh: Math.round(g.state.car.speedKmh),
    p: p ? JSON.parse(JSON.stringify({ speed: p.speed, impactSpeed: p.impactSpeed, airTime: p.airTime, scale: p.scale, duration: p.duration, intensity: p.intensity })) : null }));
  const tick = () => {
    const s = g.state, c = g.camera, cs = g.cameraSys, car = s.car;
    if (car && car.position) {
      const dx = c.position.x - car.position.x, dy = c.position.y - car.position.y, dz = c.position.z - car.position.z;
      R.samples.push({
        t: +(performance.now() / 1000).toFixed(3), ph: s.phase, prog: +s.progress.toFixed(4),
        kmh: Math.round(car.speedKmh), fov: +c.fov.toFixed(1),
        dist: +Math.hypot(dx, dy, dz).toFixed(2), dy: +dy.toFixed(2),
        air: car.airborne ? 1 : 0, drift: car.drifting ? 1 : 0, dAng: +(car.driftAngle || 0).toFixed(2),
        ts: +s.timeScale.toFixed(2), occl: cs ? +cs._occl.toFixed(2) : null,
        roll: cs ? +(cs._roll * 57.3).toFixed(1) : null, trauma: cs ? +cs._trauma.toFixed(2) : null,
        camY: +c.position.y.toFixed(1), carY: +car.position.y.toFixed(1),
      });
      if (R.samples.length > 30000) R.samples.shift();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  const consoleLog = [];
  page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message}`));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
    console.log(`[shot] ${TAG}-${name}.png`);
  };

  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
  console.log('[boot] ok');

  // ---- 1. markers vs MENU_SHOTS
  const markers = await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    const m = g.track._data.markerT;
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(4)]));
  });
  console.log('[markers]', JSON.stringify(markers));

  // ---- 2. menu shots: capture at the middle of each 6 s shot (menuT starts at menu entry)
  await page.evaluate(RECORDER);
  for (let i = 0; i < 5; i++) {
    // wait until cameraSys._menuShot === i, then 2.5s into it
    await page.waitForFunction((idx) => window.__APEX_GAME__.cameraSys._menuShot === idx, { timeout: 40000 }, i).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    await shot(`menu-shot${i}`);
  }

  // ---- 3. race
  await page.keyboard.press('Enter');
  await page.evaluate(AUTOPILOT);
  await new Promise((r) => setTimeout(r, 1200));
  await shot('countdown-early');
  await new Promise((r) => setTimeout(r, 1500));
  await shot('countdown-late');

  const t0 = Date.now();
  let jumpShots = 0, loopShots = 0, landShot = false, finShots = 0, finAt = 0, driftShot = false;
  const loopT0 = markers.loopCircle, loopT1 = markers.loopCircleEnd;
  const loopMarks = [loopT0 + 0.22 * (loopT1 - loopT0), loopT0 + 0.5 * (loopT1 - loopT0), loopT0 + 0.78 * (loopT1 - loopT0)];
  let lastAir = 0;
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 90));
    const s = await page.evaluate(() => {
      const g = window.__APEX_GAME__, s = g.state;
      return { ph: s.phase, prog: +s.progress.toFixed(4), air: s.car.airborne, kmh: Math.round(s.car.speedKmh), drift: s.car.drifting };
    });
    if (s.ph === 'racing') {
      if (s.air && s.prog > markers.jump && s.prog < markers.rockslide && jumpShots < 3) {
        await shot(`jump-air${jumpShots}`); jumpShots++;
      }
      if (!s.air && lastAir && s.prog > markers.jump && s.prog < markers.rockslide && !landShot) {
        await shot('jump-landed'); landShot = true;
      }
      if (s.drift && !driftShot && s.kmh > 60) { await shot('drift'); driftShot = true; }
      if (loopShots < 3 && s.prog >= loopMarks[loopShots]) { await shot(`loop${loopShots}`); loopShots++; }
      lastAir = s.air;
    }
    if (s.ph === 'finished') {
      if (finAt === 0) finAt = Date.now();
      const dt = Date.now() - finAt;
      if (finShots === 0 && dt > 500) { await shot('finish-orbit0'); finShots++; }
      if (finShots === 1 && dt > 4000) { await shot('finish-orbit1'); finShots++; }
      if (finShots === 2 && dt > 9000) { await shot('finish-orbit2'); finShots++; break; }
    }
  }

  // ---- 4. dump telemetry
  const rec = await page.evaluate(() => {
    const R = window.__CAMREC__;
    return { events: R.events, n: R.samples.length, samples: R.samples };
  });
  fs.writeFileSync(path.join(OUT, `${TAG}-telemetry.json`), JSON.stringify(rec));
  console.log(`[events] ${JSON.stringify(rec.events, null, 0)}`);
  console.log(`[samples] ${rec.n} → qa/out/${TAG}-telemetry.json`);
  fs.writeFileSync(path.join(OUT, `${TAG}-console.log`), consoleLog.join('\n'));
  await browser.close();
}

main().catch((e) => { console.error('[probe] failed:', e.message); process.exit(1); });
