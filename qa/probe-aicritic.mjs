// AI-critic probe: runs an autopilot race and samples player + AI progress
// every second. Prints gap telemetry to diagnose rubber-banding / racePosition.
// Usage: node qa/probe-aicritic.mjs [--secs 200]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : dflt;
};
const SECS = Number(opt('secs', 200));
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

// same autopilot as qa/shot.mjs
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

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    { timeout: 90000 }
  );
  await new Promise((r) => setTimeout(r, 1500));
  await page.keyboard.press('Enter');
  await page.evaluate(AUTOPILOT);

  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = await page.evaluate(() => {
      const g = window.__APEX_GAME__;
      const s = g.state;
      const L = 8052;
      const pSpd = Math.hypot(s.car.velocity.x, s.car.velocity.y, s.car.velocity.z);
      return {
        phase: s.phase,
        rt: +s.raceTime.toFixed(1),
        pT: +s.progress.toFixed(4),
        pSpd: +pSpd.toFixed(1),
        pos: s.racePosition,
        ai: g.ai.cars.map((c) => ({
          n: c.driver.name,
          t: +c.t.toFixed(4),
          v: +c.speed.toFixed(1),
          tv: +c.targetSpeed.toFixed(1),
          fin: c.finished,
          // gap in meters and (crude) seconds at player speed
          gapM: +((c.t - s.progress) * L).toFixed(0),
        })),
        finishOrder: g.ai._finishOrder.slice(),
      };
    });
    rows.push(row);
    const gaps = row.ai.map((a) => `${a.n} t=${a.t} v=${a.v}/${a.tv} gap=${a.gapM}m${a.fin ? ' FIN' : ''}`).join(' | ');
    console.log(`[${row.rt}s ${row.phase} P${row.pos}] player t=${row.pT} v=${row.pSpd} || ${gaps}`);
    if (row.phase === 'finished') {
      console.log('[finishOrder]', JSON.stringify(row.finishOrder));
      break;
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error('[probe] failed:', e.message);
  process.exit(1);
});
