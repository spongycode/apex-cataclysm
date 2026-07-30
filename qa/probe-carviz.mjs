// QA probe: car visuals close-ups + wheel spin-direction telemetry.
// Modeled on qa/shot.mjs. Writes qa/out/carviz-*.png and prints telemetry.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
    try {
      const r = await fetch('http://127.0.0.1:5173/index.html');
      if (r.ok) return;
    } catch {}
  }
  throw new Error('static server failed to start');
}

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--hide-scrollbars', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `carviz-${name}.png`) });
    console.log(`[shot] carviz-${name}.png`);
  };

  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    { timeout: 90000 }
  );
  await new Promise((r) => setTimeout(r, 1500));

  // Start race, wait through countdown.
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 4500));

  // Install camera lock helper: a rAF loop that pins the camera at an offset in
  // the CAR's frame (runtime patch only — no source files touched).
  await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    g.cameraSys.update = () => {}; // freeze the game camera controller
    window.__CAMLOCK__ = null;
    const loop = () => {
      const cl = window.__CAMLOCK__;
      if (cl) {
        const c = g.state.car;
        const cam = g.camera;
        const o = cl.off;
        // world offset = quat * local offset
        const q = c.quaternion;
        const vx = o[0], vy = o[1], vz = o[2];
        // quat rotate
        const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        const ix = qw * vx + qy * vz - qz * vy;
        const iy = qw * vy + qz * vx - qx * vz;
        const iz = qw * vz + qx * vy - qy * vx;
        const iw = -qx * vx - qy * vy - qz * vz;
        const wx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
        const wy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
        const wz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
        cam.position.set(c.position.x + wx, c.position.y + wy, c.position.z + wz);
        cam.lookAt(c.position.x, c.position.y + (cl.lookY || 0), c.position.z);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  const setInput = (o) => page.evaluate((v) => { window.__APEX_QA__ = v; }, o);
  const setCam = (off, lookY = 0) => page.evaluate((c) => { window.__CAMLOCK__ = c; }, { off, lookY });

  // ---------- 1) wheel spin direction telemetry ----------
  // Creep forward at low speed, track FR wheel (index 1, unmirrored side):
  // marker = top-of-tire point local (0, 0.345, 0) in the spin group.
  // Correct forward roll => marker world velocity ~ 2x car velocity (both forward).
  // Backward spin => marker velocity ~ 0.
  await setInput({ throttle: 0.35, brake: 0, steer: 0, boost: false, handbrake: false });
  await new Promise((r) => setTimeout(r, 2500));
  const spinData = await page.evaluate(
    () =>
      new Promise((res) => {
        const g = window.__APEX_GAME__;
        const spin = g.carVisuals.rig.wheels[1].userData.spin;
        const sample = () => {
          const e = spin.matrixWorld.elements;
          return {
            mx: e[4] * 0.345 + e[12], my: e[5] * 0.345 + e[13], mz: e[6] * 0.345 + e[14],
            cx: g.state.car.position.x, cy: g.state.car.position.y, cz: g.state.car.position.z,
            rot: spin.rotation.x,
            spinAngle: g.state.car.wheels[1].spinAngle,
            speed: g.state.car.speedKmh,
          };
        };
        const a = sample();
        setTimeout(() => {
          requestAnimationFrame(() => {
            const b = sample();
            const q = g.state.car.quaternion;
            // forward = q*(0,0,-1)
            const fx = -2 * (q.x * q.z + q.w * q.y);
            const fy = -2 * (q.y * q.z - q.w * q.x);
            const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
            const carD = (b.cx - a.cx) * fx + (b.cy - a.cy) * fy + (b.cz - a.cz) * fz;
            const mkD = (b.mx - a.mx) * fx + (b.my - a.my) * fy + (b.mz - a.mz) * fz;
            res({
              carForwardDisp: +carD.toFixed(4),
              markerForwardDisp: +mkD.toFixed(4),
              ratio: +(mkD / carD).toFixed(3),
              dRot: +(b.rot - a.rot).toFixed(4),
              dSpinAngle: +(b.spinAngle - a.spinAngle).toFixed(4),
              speedKmh: Math.round(b.speed),
            });
          });
        }, 250);
      })
  );
  console.log('[spin-test]', JSON.stringify(spinData));
  console.log('[spin-test] ratio ~2 = correct forward roll; ~0 or negative = wheels spin backward');

  // ---------- 2) slow-roll close-ups (garage-style) ----------
  await setInput({ throttle: 0.06, brake: 0, steer: 0, boost: false, handbrake: false });
  await new Promise((r) => setTimeout(r, 1200));

  await setCam([2.6, 1.1, 4.2], 0.1); // rear 3/4
  await new Promise((r) => setTimeout(r, 300));
  await shot('01-rear34');

  await setCam([-2.8, 0.9, -4.0], 0.1); // front 3/4
  await new Promise((r) => setTimeout(r, 300));
  await shot('02-front34');

  await setCam([4.6, 0.45, 0], 0.05); // profile, low
  await new Promise((r) => setTimeout(r, 300));
  await shot('03-profile');

  await setCam([0, 0.75, 5.2], 0.15); // dead rear, low — light bar / diffuser / exhausts
  await new Promise((r) => setTimeout(r, 300));
  await shot('04-rear-low');

  await setCam([0, 0.6, -4.6], 0); // dead front, low — DRLs / splitter
  await new Promise((r) => setTimeout(r, 300));
  await shot('05-front-low');

  await setCam([1.6, 0.42, -1.4], -0.2); // front wheel close
  await new Promise((r) => setTimeout(r, 300));
  await shot('06-wheel-close');

  // ---------- 3) brake lights ----------
  await setInput({ throttle: 0, brake: 1, steer: 0, boost: false, handbrake: false });
  await setCam([1.8, 1.0, 4.6], 0.1);
  await new Promise((r) => setTimeout(r, 600));
  await shot('07-braking');

  // ---------- 4) boost flames at speed ----------
  await page.evaluate(() => { window.__APEX_GAME__.physics._boostTank = 1; });
  await setInput({ throttle: 1, brake: 0, steer: 0, boost: true, handbrake: false });
  await setCam([0.9, 0.8, 5.4], 0.1);
  await new Promise((r) => setTimeout(r, 1800));
  await page.evaluate(() => { window.__APEX_GAME__.physics._boostTank = 1; });
  await shot('08-boost');
  const boosting = await page.evaluate(() => window.__APEX_GAME__.state.car.boosting);
  console.log('[boost] boosting =', boosting);

  // ---------- 5) contact shadow / underglow check: side view at speed ----------
  await setCam([4.8, 0.9, 0.6], -0.1);
  await new Promise((r) => setTimeout(r, 400));
  await shot('09-side-speed');

  // ---------- 6) chase-distance read at high quality (default cam restored won't work; use lock far) ----------
  await setCam([0, 2.6, 9.5], 0.4);
  await new Promise((r) => setTimeout(r, 400));
  await shot('10-chase-far');

  await browser.close();
}

main().catch((e) => {
  console.error('[probe] failed:', e.message);
  process.exit(1);
});
