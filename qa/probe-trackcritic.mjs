// probe-trackcritic.mjs — quantitative track-design telemetry (no race).
// Boots the game, waits for init, then measures: spline continuity, checkpoint spacing,
// terrain cross-sections (canyon shelf / gorge / rockslide), prop lateral placement,
// rail coverage, gate/bridge geometry. Read-only.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

  const out = await page.evaluate(() => {
    const g = window.__APEX_GAME__;
    const track = g.track;
    const data = track._data;
    const S = track._sampler;
    const L = data.totalLen;
    const res = { totalLen: +L.toFixed(1) };

    // --- markers
    res.markers = Object.fromEntries(Object.entries(data.markerT).map(([k, v]) => [k, +v.toFixed(4)]));

    // --- continuity: max step-to-step angle + position jerk over 3000 samples
    let maxAng = 0, maxAngT = 0, maxUpAng = 0, maxUpT = 0;
    let prev = null, prevUp = null;
    for (let i = 0; i <= 3000; i++) {
      const t = i / 3000;
      const r = track.sample(t);
      const tan = { x: r.tangent.x, y: r.tangent.y, z: r.tangent.z };
      const up = { x: r.up.x, y: r.up.y, z: r.up.z };
      if (prev) {
        const d = prev.x * tan.x + prev.y * tan.y + prev.z * tan.z;
        const a = Math.acos(Math.min(1, Math.max(-1, d)));
        if (a > maxAng) { maxAng = a; maxAngT = t; }
        const du = prevUp.x * up.x + prevUp.y * up.y + prevUp.z * up.z;
        const au = Math.acos(Math.min(1, Math.max(-1, du)));
        if (au > maxUpAng) { maxUpAng = au; maxUpT = t; }
      }
      prev = tan; prevUp = up;
    }
    res.continuity = {
      maxTangentStepDeg: +(maxAng * 180 / Math.PI).toFixed(2), atT: +maxAngT.toFixed(4),
      maxUpStepDeg: +(maxUpAng * 180 / Math.PI).toFixed(2), atUpT: +maxUpT.toFixed(4),
      note: 'per 1/3000 t-step (~2.7 m)',
    };

    // --- banking summary per zone
    res.banking = data.zoneDefs.map(([name], zi) => {
      const t0 = data.zoneStarts[zi], t1 = zi + 1 < data.zoneStarts.length ? data.zoneStarts[zi + 1] : 1;
      let mx = 0;
      for (let i = Math.floor(t0 * (data.N - 1)); i < t1 * (data.N - 1); i++) mx = Math.max(mx, Math.abs(data.bank[i]));
      return [name, +(mx * 180 / Math.PI).toFixed(1)];
    });

    // --- checkpoint spacing (m)
    const cps = track.checkpoints.map((c) => c.t);
    res.checkpointGapsM = cps.map((t, i) => Math.round((t - (i ? cps[i - 1] : 0)) * L));

    // --- terrain cross sections via world.raycast straight down
    const world = g.ctx ? g.ctx.world : g.world;
    const W = (window.__APEX_GAME__.world) || null;
    const ray = (x, y, z) => {
      const o = new (Object.getPrototypeOf(track.sample(0).position).constructor)(x, y, z);
      const d = new (Object.getPrototypeOf(o).constructor)(0, -1, 0);
      const hit = (g.world || world || W).raycast(o, d, 600);
      return hit ? +hit.point.y.toFixed(1) : null;
    };
    const section = (t, maxLat, step) => {
      const r = track.sample(t);
      const px = r.position.x, py = r.position.y, pz = r.position.z;
      const rx = r.right.x, rz = r.right.z;
      const row = [];
      for (let lat = -maxLat; lat <= maxLat; lat += step) {
        const y = ray(px + rx * lat, py + 250, pz + rz * lat);
        row.push([lat, y === null ? null : +(y - py).toFixed(1)]);
      }
      return { t: +t.toFixed(3), roadY: +py.toFixed(1), width: +r.width.toFixed(1), rel: row };
    };
    const m = data.markerT;
    res.sections = {
      desertMid: section(0.07, 90, 15),
      canyonHairpin: section(m.canyon + 0.045, 90, 15),
      rockslideMid: section(m.rockslide + 0.03, 90, 15),
      bridgeMid: section((m.bridgeDeck + m.bridgeDeckEnd) / 2, 150, 25),
      fordMid: section((m.fordStart + m.fordEnd) / 2, 60, 10),
    };

    // --- prop lateral placement: min/median |lat|/halfwidth per type
    const B = track._breakables;
    const stats = {};
    for (const set of B.sets) {
      const rel = [];
      for (let i = 0; i < set.alive.length; i++) {
        const x = set.positions[i * 3], y = set.positions[i * 3 + 1], z = set.positions[i * 3 + 2];
        const t = S.progressAt(x, y, z, -1);
        const r = track.sample(t);
        const lat = (x - r.position.x) * r.right.x + (y - r.position.y) * r.right.y + (z - r.position.z) * r.right.z;
        rel.push(Math.abs(lat) / (r.width / 2));
      }
      rel.sort((a, b) => a - b);
      stats[set.type] = {
        n: rel.length,
        min: +rel[0].toFixed(2),
        p25: +rel[(rel.length * 0.25) | 0].toFixed(2),
        med: +rel[(rel.length / 2) | 0].toFixed(2),
      };
    }
    res.propLatOverHalfwidth = stats;

    // --- scene stats
    let meshes = 0, instanced = 0, tris = 0;
    g.scene.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        if (o.isInstancedMesh) instanced++;
        const idx = o.geometry.index;
        tris += (idx ? idx.count : o.geometry.attributes.position?.count || 0) / 3;
      }
    });
    res.scene = { meshes, instanced, tris: Math.round(tris) };
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
