// UI/HUD probe: verifies minimap AI-dot sourcing, checkpoint tick indexing,
// and center-callout overlap behavior. Modeled on qa/shot.mjs.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'out');
fs.mkdirSync(OUT, { recursive: true });
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
  throw new Error('no server');
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

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.press('Enter');
  await page.evaluate(AUTOPILOT);
  await new Promise((r) => setTimeout(r, 5000)); // past countdown

  // race ~75s to cross several checkpoints
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 75000) {
    await new Promise((r) => setTimeout(r, 2500));
    last = await page.evaluate(() => {
      const g = window.__APEX_GAME__;
      const ui = g.ui;
      const st = g.state;
      const dotOp = ui.aiDots ? ui.aiDots.map((d) => d.style.opacity) : null;
      const hitTicks = ui._cpTicks.map((t, i) => (t.classList.contains('hit') ? i : -1)).filter((i) => i >= 0);
      const aiShape = g.ai && g.ai.cars && g.ai.cars[0] ? Object.keys(g.ai.cars[0]).slice(0, 20) : null;
      return {
        phase: st.phase, cp: st.checkpoint, progress: +st.progress.toFixed(3),
        aiSource: !!ui._aiSource, dotOp, hitTicks,
        stateAiCars: 'aiCars' in st, stateAi: 'ai' in st, stateRivals: 'rivals' in st,
        ctxAi: !!(ui.ctx && ui.ctx.ai), gameAiCars: g.ai ? g.ai.cars.length : 0, aiShape,
      };
    });
    console.log('[probe]', JSON.stringify(last));
    if (last.cp >= 4) break;
  }

  // --- message overlap test: emit two epics + a warn back-to-back, then measure ---
  await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    g.events.emit('ui:message', { text: 'MASSIVE AIR!', style: 'epic' });
    g.events.emit('ui:message', { text: 'THE LOOP', sub: 'DO NOT LIFT', style: 'epic' });
    g.events.emit('ui:message', { text: 'ROCKSLIDE!', sub: 'DODGE', style: 'warn' });
  });
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 900));
    const vis = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.ax-msg')];
      return nodes.map((n) => {
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return { txt: n.firstChild.textContent, op: +(+cs.opacity).toFixed(2), top: Math.round(r.top), h: Math.round(r.height), show: n.classList.contains('show') };
      }).filter((x) => x.op > 0.05);
    });
    console.log('[msgs t+' + ((i + 1) * 0.9).toFixed(1) + 's]', JSON.stringify(vis));
    if (i === 0) await page.screenshot({ path: path.join(OUT, 'uiprobe-msg-overlap.png') });
  }
  await browser.close();
}
main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
