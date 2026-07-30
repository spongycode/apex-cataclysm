// Probe: lighting/shadow/sun-geometry telemetry. Boots game to menu, inspects scene.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function ensureServer() {
  try { const r = await fetch('http://127.0.0.1:5173/index.html'); if (r.ok) return; } catch {}
  const proc = spawn('python3', ['-m', 'http.server', '5173', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
  proc.unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); try { const r = await fetch('http://127.0.0.1:5173/index.html'); if (r.ok) return; } catch {} }
  throw new Error('no server');
}

const browser = await (async () => {
  await ensureServer();
  return puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--window-size=1280,720', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
})();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.evaluateOnNewDocument(`window.__APEX_LOCK_QUALITY__ = 'high';`);
await page.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), { timeout: 90000 });
await new Promise(r => setTimeout(r, 2000));

const info = await page.evaluate(() => {
  const g = window.__APEX_GAME__;
  const sc = g.scene;
  let cast = 0, recv = 0, meshes = 0;
  sc.traverse(o => { if (o.isMesh) { meshes++; if (o.castShadow) cast++; if (o.receiveShadow) recv++; } });
  const r = g.rendering || {};
  const sun = r.sun;
  // Sun azimuth vs track tangent at key t values (sunset value per weather curve approx)
  const SUN_K = [0, 0, 0.35, 0.06, 0.55, 0.12, 0.7, 0.22, 0.8, 0.42, 0.85, 0.62, 0.93, 0.92, 1, 1];
  const evalCurve = (k, p) => {
    for (let i = k.length - 2; i >= 0; i -= 2) {
      if (p >= k[i]) {
        const j = Math.min(i + 2, k.length - 2);
        const t = j === i ? 0 : (p - k[i]) / (k[j] - k[i]);
        return k[i + 1] + (k[j + 1] - k[i + 1]) * t;
      }
    }
    return k[1];
  };
  const rows = [];
  for (const t of [0.02, 0.05, 0.10, 0.20, 0.30, 0.90, 0.93, 0.96, 0.985]) {
    const s = g.track.sample(t);
    const sunset = evalCurve(SUN_K, t);
    const el = 0.58 + (0.14 - 0.58) * sunset;
    const az = -0.6 + sunset * 1.0;
    const sd = { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) };
    // camera looks along +tangent; sun visible in frame if dot(tangent, sunDir) high
    const dot = s.tangent.x * sd.x + s.tangent.z * sd.z; // horizontal alignment
    const headingTrack = Math.atan2(s.tangent.x, s.tangent.z);
    const headingSun = Math.atan2(sd.x, sd.z);
    rows.push({
      t, sunset: +sunset.toFixed(2), elevDeg: +(el * 57.3).toFixed(1),
      trackHeadingDeg: +(headingTrack * 57.3).toFixed(0), sunHeadingDeg: +(headingSun * 57.3).toFixed(0),
      angleOffDeg: +((Math.abs(((headingTrack - headingSun) * 57.3 + 540) % 360 - 180))).toFixed(0),
    });
  }
  return {
    meshes, cast, recv,
    sun: sun ? { intensity: sun.intensity, mapSize: sun.shadow.mapSize.x, bias: sun.shadow.bias, normalBias: sun.shadow.normalBias } : null,
    toneMappingExposure: g.renderer.toneMappingExposure,
    envIntensity: sc.environmentIntensity,
    fogDensity: sc.fog.density,
    fogColor: sc.fog.color.getHexString(),
    hemi: r.hemi ? { intensity: r.hemi.intensity, color: r.hemi.color.getHexString(), ground: r.hemi.groundColor.getHexString() } : null,
    sunTable: rows,
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
process.exit(0);
