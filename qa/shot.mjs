// QA harness: boots the game in headless Chrome, captures console output,
// drives the track with an injected autopilot, screenshots key moments.
// Usage: node qa/shot.mjs [--secs 240] [--tag run1] [--visible] [--noauto]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : dflt;
};
const SECS = Number(opt('secs', 240));
const TAG = opt('tag', 'run');
const HEADLESS = !args.includes('--visible');
const AUTO = !args.includes('--noauto');
const FPSPROBE = args.includes('--fpsprobe'); // uncapped rAF, no screenshots (they starve)
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

// Injected into the page: P-controller steering toward a speed-scaled lookahead
// point on the spline, brake on upcoming curvature, boost on straights.
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
    // forward = q * (0,0,-1); up = q * (0,1,0)
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

const consoleLog = [];

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: [
      '--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio',
      // headless caps rAF at ~30; uncap in fps-probe mode for true GPU throughput
      ...(FPSPROBE ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    consoleLog.push(line);
    if (m.type() === 'error') console.log(line.slice(0, 600));
  });
  page.on('pageerror', (e) => {
    consoleLog.push(`[pageerror] ${e.message}\n${e.stack || ''}`);
    console.log(`[pageerror] ${e.message}`);
  });

  const shot = async (name) => {
    if (FPSPROBE) return;
    await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
    console.log(`[shot] ${TAG}-${name}.png`);
  };

  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = '${opt('quality', 'high')}';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });

  const boot = await page
    .waitForFunction(
      () =>
        document.getElementById('loading')?.classList.contains('done') ||
        document.getElementById('fatal')?.style.display === 'flex',
      { timeout: 90000 }
    )
    .then(() => page.evaluate(() => (document.getElementById('fatal')?.style.display === 'flex' ? 'fatal' : 'ok')))
    .catch(() => 'timeout');
  console.log(`[boot] ${boot}`);

  const glInfo = await page.evaluate(() => {
    try {
      const gl = document.getElementById('game-canvas').getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    } catch (e) { return 'n/a: ' + e.message; }
  });
  console.log(`[gl] ${glInfo}`);

  await new Promise((r) => setTimeout(r, 2500));
  await shot('01-menu');

  if (boot !== 'ok') {
    const fatal = await page.evaluate(() => document.getElementById('fatal')?.textContent || '');
    console.log(`[fatal-text] ${fatal.slice(0, 2000)}`);
    await shot('99-fatal');
  } else {
    const getState = () =>
      page.evaluate(() => {
        const s = window.__APEX_STATE__;
        return s
          ? {
              phase: s.phase, progress: +s.progress.toFixed(4), speed: Math.round(s.car.speedKmh),
              cp: s.checkpoint, pos: s.racePosition, ww: s.wrongWay, q: s.settings.quality,
              boost: +s.car.boost.toFixed(2), drift: s.car.drifting, air: s.car.airborne,
            }
          : null;
      });

    await page.keyboard.press('Enter');
    if (AUTO) await page.evaluate(AUTOPILOT);
    await new Promise((r) => setTimeout(r, 1500));
    await shot('02-countdown');
    await new Promise((r) => setTimeout(r, 2600));
    if (!AUTO) await page.keyboard.down('KeyW');

    const t0 = Date.now();
    const marks = [
      [0.05, '03-sweepers'], [0.18, '04-drift-zone'], [0.275, '05-big-jump'], [0.34, '06-rockslide'],
      [0.46, '07-forest'], [0.60, '08-tunnel'], [0.675, '09-loop'], [0.73, '10-water'],
      [0.85, '11-bridge'], [0.95, '12-finish-straight'],
    ];
    let mi = 0;
    let lastMove = Date.now();
    let lastProgress = 0;
    let finished = false;
    while (Date.now() - t0 < SECS * 1000) {
      await new Promise((r) => setTimeout(r, 500));
      const s = await getState();
      if (!s) { console.log('[qa] no state hook'); break; }
      if (mi < marks.length && s.progress >= marks[mi][0]) {
        await shot(marks[mi][1]);
        console.log(`[state] ${JSON.stringify(s)}`);
        mi++;
      }
      if (s.phase === 'finished') {
        await new Promise((r) => setTimeout(r, 2000));
        await shot('13-finish');
        console.log(`[state] ${JSON.stringify(s)}`);
        finished = true;
        break;
      }
      if (s.progress > lastProgress + 0.001) { lastProgress = s.progress; lastMove = Date.now(); }
      if (s.phase === 'racing' && Date.now() - lastMove > 12000) {
        console.log(`[qa] stuck at progress ${s.progress} — R`);
        await page.keyboard.press('KeyR');
        lastMove = Date.now();
      }
    }
    console.log(`[result] finished=${finished} raceTime=${await page.evaluate(() => window.__APEX_STATE__.raceTime.toFixed(1))}s`);

    const fps = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const start = performance.now();
          const tick = () => (++n, performance.now() - start < 2000 ? requestAnimationFrame(tick) : res((n / 2).toFixed(1)));
          requestAnimationFrame(tick);
        })
    );
    console.log(`[fps] ~${fps}`);
    const perf = await page.evaluate(() => {
      const g = window.__APEX_GAME__;
      const p = Object.fromEntries(Object.entries(g.perf).map(([k, v]) => [k, +v.toFixed(2)]));
      const i = g.renderer.info;
      return JSON.stringify({ ...p, drawCalls: i.render.calls, tris: i.render.triangles, geoms: i.memory.geometries, texs: i.memory.textures, programs: i.programs?.length });
    });
    console.log(`[perf] ${perf}`);
  }

  fs.writeFileSync(path.join(OUT, `${TAG}-console.log`), consoleLog.join('\n'));
  const errors = consoleLog.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  console.log(`[console] ${consoleLog.length} lines, ${errors.length} errors → qa/out/${TAG}-console.log`);
  await browser.close();
}

main().catch((e) => {
  console.error('[qa] harness failed:', e.message);
  process.exit(1);
});
