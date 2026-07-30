// Physics/handling probe: boots the game headless, drives scripted maneuvers via
// window.__APEX_QA__, records 120 Hz telemetry by wrapping physics.fixedUpdate,
// and prints quantitative handling metrics (accel, braking, step-steer, drift,
// jump, loop, walls, top speed).
// Usage: node qa/probe-phys.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function ensureServer() {
  try { const r = await fetch('http://127.0.0.1:5173/index.html'); if (r.ok) return; } catch {}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'low';`);
  await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
  await sleep(1000);

  // ---- install recorder + event log + controller
  await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    window.__REC__ = { rows: [], on: false, step: 0 };
    const ph = g.physics;
    const orig = ph.fixedUpdate.bind(ph);
    ph.fixedUpdate = (fdt) => {
      orig(fdt);
      const R = window.__REC__;
      R.step++;
      if (!R.on) return;
      const c = g.state.car;
      R.rows.push([
        R.step, +c.speedKmh.toFixed(2), +ph.vel.dot(ph._fwd).toFixed(3), +ph.vel.dot(ph._right).toFixed(3),
        +ph.angVelL.y.toFixed(4), +c.driftAngle.toFixed(4), +c.steer.toFixed(3), +ph._up.y.toFixed(3),
        +ph.pos.x.toFixed(2), +ph.pos.y.toFixed(2), +ph.pos.z.toFixed(2),
        c.grounded ? 1 : 0, +c.boost.toFixed(4), +g.state.stats.driftScore.toFixed(1),
        +g.state.progress.toFixed(4), c.airborne ? 1 : 0,
      ]);
      if (R.rows.length > 60000) R.on = false;
    };
    window.__EV__ = [];
    for (const n of ['car:jump', 'car:landed', 'car:collision', 'drift:start', 'drift:end', 'boost:start', 'boost:end', 'car:respawn', 'race:finish'])
      g.events.on(n, (pl) => {
        const lite = {};
        if (pl) for (const k of ['speed', 'impactSpeed', 'airTime', 'score', 'duration']) if (pl[k] !== undefined) lite[k] = +(+pl[k]).toFixed(2);
        window.__EV__.push({ n, step: window.__REC__.step, ...lite });
      });
    // controller (16 ms): modes raw | lane (spline-follow steering) | cs (countersteer hold)
    window.__CTRL__ = { mode: 'raw', throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, csGain: 1.4 };
    setInterval(() => {
      const C = window.__CTRL__;
      const s = g.state;
      if (C.mode === 'lane') {
        const car = s.car, q = car.quaternion, p = car.position;
        const sp = Math.hypot(car.velocity.x, car.velocity.y, car.velocity.z);
        const L = 8052;
        const near = g.track.sample(Math.min(0.9995, s.progress + Math.max(14, sp * 0.85) / L));
        const nx = near.position.x - p.x, ny = near.position.y - p.y, nz = near.position.z - p.z;
        const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x);
        const cxx = fy * nz - fz * ny, cyy = fz * nx - fx * nz, czz = fx * ny - fy * nx;
        const aNear = Math.atan2(cxx * ux + cyy * uy + czz * uz, fx * nx + fy * ny + fz * nz);
        window.__APEX_QA__ = { steer: Math.max(-1, Math.min(1, -aNear * 2.0)), throttle: C.throttle, brake: C.brake, boost: C.boost, handbrake: false };
      } else if (C.mode === 'cs') {
        const a = s.car.driftAngle;
        window.__APEX_QA__ = { steer: Math.max(-1, Math.min(1, C.csGain * a)), throttle: C.throttle, brake: 0, boost: false, handbrake: false };
      } else {
        window.__APEX_QA__ = { throttle: C.throttle, brake: C.brake, steer: C.steer, handbrake: C.handbrake, boost: C.boost };
      }
    }, 16);
    window.__TELE__ = (t, speed, yawDeg) => {
      const sm = g.track.sample(t);
      const tan = sm.tangent;
      const yaw = Math.atan2(-tan.x, -tan.z) + (yawDeg || 0) * Math.PI / 180;
      const q = g.physics.quat.clone();
      q.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      const pos = sm.position.clone();
      pos.y += 1.0;
      g.physics.respawn(pos, q);
      const fwdx = -Math.sin(yaw), fwdz = -Math.cos(yaw);
      g.physics.vel.set(fwdx * speed, 0, fwdz * speed);
    };
  });

  // start race
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__APEX_STATE__.phase === 'racing', { timeout: 15000 });
  console.log('[probe] racing');

  const ctrl = (o) => page.evaluate((o) => Object.assign(window.__CTRL__, o), o);
  const tele = (t, v, y) => page.evaluate((a) => window.__TELE__(a[0], a[1], a[2]), [t, v, y]);
  const recOn = () => page.evaluate(() => { window.__REC__.rows = []; window.__EV__ = []; window.__REC__.on = true; });
  const recOff = () => page.evaluate(() => {
    window.__REC__.on = false;
    return { rows: window.__REC__.rows, ev: window.__EV__ };
  });
  const speedNow = () => page.evaluate(() => window.__APEX_STATE__.car.speedKmh);
  const waitSpeed = async (kmh, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if ((await speedNow()) >= kmh) return true; await sleep(40); }
    return false;
  };

  const F = 1 / 120;
  const dist = (rows, i0, i1) => {
    let d = 0;
    for (let i = i0 + 1; i <= i1; i++) d += Math.hypot(rows[i][8] - rows[i - 1][8], rows[i][9] - rows[i - 1][9], rows[i][10] - rows[i - 1][10]);
    return d;
  };

  // ============================== 1. ACCEL 0-100 / 0-200 =====================
  await tele(0.006, 0, 0);
  await ctrl({ mode: 'lane', throttle: 0, brake: 0, boost: false });
  await sleep(700); // settle
  await recOn();
  await ctrl({ throttle: 1 });
  await waitSpeed(201, 16000);
  {
    const { rows } = await recOff();
    // find launch = first step where speed starts rising from ~0
    let s0 = rows.findIndex((r) => r[1] > 1);
    const t100 = rows.findIndex((r) => r[1] >= 100);
    const t200 = rows.findIndex((r) => r[1] >= 200);
    const tt = (i) => ((rows[i][0] - rows[s0][0]) * F).toFixed(2);
    console.log(`[accel] 0-100 ${t100 > 0 ? tt(t100) : 'n/a'} s | 0-200 ${t200 > 0 ? tt(t200) : 'n/a'} s (dist ${t200 > 0 ? dist(rows, s0, t200).toFixed(0) : '?'} m)`);
  }

  // ============================== 2. BRAKE 100-0 =============================
  await tele(0.006, 0, 0);
  await ctrl({ mode: 'lane', throttle: 1, brake: 0 });
  await sleep(300);
  await waitSpeed(103, 10000);
  await recOn();
  await ctrl({ mode: 'raw', throttle: 0, brake: 1, steer: 0 });
  await sleep(3600);
  {
    const { rows } = await recOff();
    const b0 = rows.findIndex((r) => r[1] <= 100.5);
    const b1 = rows.findIndex((r) => r[1] < 2);
    if (b0 >= 0 && b1 > b0) {
      const d = dist(rows, b0, b1);
      // stability: max |yaw rate| & max |drift angle| during stop
      let maxYaw = 0, maxA = 0;
      for (let i = b0; i <= b1; i++) { maxYaw = Math.max(maxYaw, Math.abs(rows[i][4])); maxA = Math.max(maxA, Math.abs(rows[i][5])); }
      console.log(`[brake] 100-0 in ${d.toFixed(1)} m, ${((rows[b1][0] - rows[b0][0]) * F).toFixed(2)} s | maxYawRate ${maxYaw.toFixed(3)} rad/s maxSlip ${(maxA * 57.3).toFixed(1)} deg`);
    } else console.log('[brake] failed to capture', b0, b1);
  }

  // ============================== 3. STEP STEER @100 =========================
  await tele(0.006, 27.8, 0);
  await ctrl({ mode: 'raw', throttle: 0.42, brake: 0, steer: 0 });
  await sleep(400);
  await recOn();
  await ctrl({ steer: 1 });
  await sleep(2500);
  {
    const { rows } = await recOff();
    const s0 = rows.findIndex((r) => Math.abs(r[6]) > 0.02);
    const yaw = rows.map((r) => -r[4]); // steer right => negative yaw about +Y; flip for readability
    let peak = 0, peakI = s0;
    for (let i = s0; i < rows.length; i++) if (yaw[i] > peak) { peak = yaw[i]; peakI = i; }
    const tail = yaw.slice(Math.max(0, rows.length - 60));
    const ss = tail.reduce((a, b) => a + b, 0) / tail.length;
    let t90 = -1;
    for (let i = s0; i < rows.length; i++) if (yaw[i] >= 0.9 * ss) { t90 = i; break; }
    let maxA = 0, minSpeed = 999;
    for (let i = s0; i < rows.length; i++) { maxA = Math.max(maxA, Math.abs(rows[i][5])); minSpeed = Math.min(minSpeed, rows[i][1]); }
    console.log(`[step-steer@100] t90 ${(t90 > 0 ? (rows[t90][0] - rows[s0][0]) * F * 1000 : -1).toFixed(0)} ms | peak ${peak.toFixed(3)} ss ${ss.toFixed(3)} rad/s overshoot ${(peak / Math.max(ss, 1e-3)).toFixed(2)} | latG ~${(peak * 27.8 / 9.81).toFixed(2)} | maxSlip ${(maxA * 57.3).toFixed(1)} deg minSpd ${minSpeed.toFixed(0)}`);
  }

  // ============================== 4. HANDBRAKE DRIFT =========================
  await tele(0.006, 25, 0);
  await ctrl({ mode: 'raw', throttle: 0.6, brake: 0, steer: 0, handbrake: false });
  await sleep(300);
  await recOn();
  await ctrl({ steer: 1, handbrake: true, throttle: 0.3 });
  await sleep(500);
  await ctrl({ mode: 'cs', throttle: 0.9, handbrake: false, csGain: 1.4 });
  await sleep(4000);
  {
    const { rows, ev } = await recOff();
    // sustain window = 1.0 s after entry to end
    const i0 = Math.min(rows.length - 1, 180);
    let sum = 0, n = 0, maxA = 0, spun = false;
    for (let i = i0; i < rows.length; i++) {
      const a = Math.abs(rows[i][5]) * 57.3;
      sum += a; n++; maxA = Math.max(maxA, a);
      if (a > 85) spun = true;
    }
    const score0 = rows[0][13], score1 = rows[rows.length - 1][13];
    const boost0 = rows[0][12], boost1 = rows[rows.length - 1][12];
    const driftEvs = ev.filter((e) => e.n.startsWith('drift'));
    console.log(`[hb-drift] meanAngle ${(sum / Math.max(n, 1)).toFixed(1)} deg max ${maxA.toFixed(1)} deg spun=${spun} | score +${(score1 - score0).toFixed(0)} boost ${boost0.toFixed(2)}→${boost1.toFixed(2)} | evs ${JSON.stringify(driftEvs)}`);
    // angle trace every 0.25s for shape
    const tr = [];
    for (let i = 0; i < rows.length; i += 30) tr.push((rows[i][5] * 57.3).toFixed(0));
    console.log(`[hb-drift] angle(deg)@4Hz: ${tr.join(' ')}`);
  }

  // ============================== 5. BIG JUMP ================================
  await tele(0.245, 52, 0);
  await ctrl({ mode: 'lane', throttle: 1, brake: 0, boost: false });
  await recOn();
  await sleep(9000);
  {
    const { rows, ev } = await recOff();
    const jump = ev.find((e) => e.n === 'car:jump');
    const land = ev.find((e) => e.n === 'car:landed');
    let minUp = 1, maxAir = 0;
    for (const r of rows) { minUp = Math.min(minUp, r[7]); maxAir = Math.max(maxAir, r[15]); }
    // speed retained: 0.5 s before landing vs 0.7 s after
    let landI = land ? rows.findIndex((r) => r[0] >= land.step) : -1;
    const spdBefore = landI > 60 ? rows[landI - 60][1] : -1;
    const spdAfter = landI >= 0 && landI + 84 < rows.length ? rows[landI + 84][1] : -1;
    console.log(`[jump] jumpEv=${JSON.stringify(jump)} landEv=${JSON.stringify(land)} | minUpY ${minUp.toFixed(2)} | spd ${spdBefore.toFixed(0)}→${spdAfter.toFixed(0)} km/h | respawns ${ev.filter((e) => e.n === 'car:respawn').length}`);
  }

  // ============================== 6. THE LOOP ================================
  await tele(0.615, 45, 0);
  await ctrl({ mode: 'lane', throttle: 1, brake: 0, boost: true });
  await recOn();
  await sleep(12000);
  {
    const { rows, ev } = await recOff();
    let minUp = 1, minSpd = 999, maxProg = 0, invertedGrounded = false;
    for (const r of rows) {
      if (r[7] < minUp) minUp = r[7];
      if (r[7] < -0.5 && r[11]) invertedGrounded = true;
      maxProg = Math.max(maxProg, r[14]);
      if (r[14] > 0.63 && r[14] < 0.66) minSpd = Math.min(minSpd, r[1]);
    }
    console.log(`[loop] minUpY ${minUp.toFixed(2)} invertedGrounded=${invertedGrounded} minSpdInLoop ${minSpd.toFixed(0)} maxProg ${maxProg.toFixed(3)} respawns ${ev.filter((e) => e.n === 'car:respawn').length}`);
  }

  // ============================== 7. WALL HITS ===============================
  for (const [deg, label] of [[25, 'glancing'], [65, 'head-on-ish']]) {
    await tele(0.575, 26, deg); // mine tunnel — walls both sides
    await ctrl({ mode: 'raw', throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false });
    await recOn();
    await sleep(2500);
    const { rows, ev } = await recOff();
    const col = ev.find((e) => e.n === 'car:collision');
    let colI = col ? rows.findIndex((r) => r[0] >= col.step) : -1;
    const before = colI > 12 ? rows[colI - 12][1] : -1;
    const after = colI >= 0 && colI + 36 < rows.length ? rows[colI + 36][1] : -1;
    let maxYaw = 0;
    for (const r of rows) maxYaw = Math.max(maxYaw, Math.abs(r[4]));
    console.log(`[wall-${label} ${deg}deg] colEv=${JSON.stringify(col)} | spd ${before.toFixed(0)}→${after.toFixed(0)} km/h (kept ${(after / Math.max(before, 1) * 100).toFixed(0)}%) maxYawRate ${maxYaw.toFixed(2)}`);
  }

  // ============================== 8. TOP SPEED (bridge) ======================
  await tele(0.80, 55, 0);
  await ctrl({ mode: 'lane', throttle: 1, brake: 0, boost: false });
  await recOn();
  await sleep(9000);
  {
    const { rows } = await recOff();
    let vmax = 0;
    for (const r of rows) vmax = Math.max(vmax, r[1]);
    console.log(`[topspeed] no-boost vmax ${vmax.toFixed(1)} km/h`);
  }
  await tele(0.80, 62, 0);
  await page.evaluate(() => { window.__APEX_GAME__.physics._boostTank = 1; });
  await ctrl({ mode: 'lane', throttle: 1, brake: 0, boost: true });
  await recOn();
  await sleep(8000);
  {
    const { rows } = await recOff();
    let vmax = 0;
    for (const r of rows) vmax = Math.max(vmax, r[1]);
    const bTank = rows[rows.length - 1][12];
    console.log(`[topspeed] boost vmax ${vmax.toFixed(1)} km/h (tank ${bTank})`);
  }

  // ============================== 9. STEP STEER @180 (speed sensitivity) =====
  await tele(0.82, 50, 0);
  await ctrl({ mode: 'raw', throttle: 0.6, brake: 0, steer: 0, boost: false });
  await sleep(400);
  await recOn();
  await ctrl({ steer: 1 });
  await sleep(2200);
  {
    const { rows } = await recOff();
    const s0 = Math.max(0, rows.findIndex((r) => Math.abs(r[6]) > 0.02));
    let peak = 0;
    for (let i = s0; i < rows.length; i++) peak = Math.max(peak, -rows[i][4]);
    let maxA = 0;
    for (let i = s0; i < rows.length; i++) maxA = Math.max(maxA, Math.abs(rows[i][5]));
    console.log(`[step-steer@180] peakYaw ${peak.toFixed(3)} rad/s latG ~${(peak * 50 / 9.81).toFixed(2)} maxSlip ${(maxA * 57.3).toFixed(1)} deg`);
  }

  await browser.close();
  console.log('[probe] done');
}

main().catch((e) => { console.error('[probe] failed:', e); process.exit(1); });
