// materials.js — canvas-procedural textures + PBR materials for every track surface,
// terrain, rails, scenery. Zero network fetches; everything painted at init.
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { repeatY = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = repeatY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

let _rngState = 1337;
function rng() {
  _rngState = (_rngState * 1664525 + 1013904223) >>> 0;
  return _rngState / 4294967296;
}

/** Speckle noise layer. */
function grain(ctx, w, h, n, alpha, dark = true) {
  for (let i = 0; i < n; i++) {
    const v = rng();
    ctx.fillStyle = dark && v < 0.5
      ? `rgba(0,0,0,${(alpha * rng()).toFixed(3)})`
      : `rgba(255,255,255,${(alpha * 0.6 * rng()).toFixed(3)})`;
    const s = 1 + rng() * 3;
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

function cracks(ctx, w, h, n, style) {
  ctx.strokeStyle = style;
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    let x = rng() * w, y = rng() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 3 + (rng() * 6 | 0);
    for (let s = 0; s < steps; s++) {
      x += (rng() - 0.5) * 60; y += (rng() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Road textures. UV: u = 0..1 across the ribbon, v = meters/3 along it.
// Painted markings: edge lines at u≈0.06/0.94, dashed center line.
// ---------------------------------------------------------------------------

function asphaltTexture() {
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#3c3a3c'; x.fillRect(0, 0, 512, 512);
  grain(x, 512, 512, 9000, 0.16);
  cracks(x, 512, 512, 14, 'rgba(20,18,20,0.35)');
  // subtle tire-polish darkening in the two wheel lines
  const g = x.createLinearGradient(0, 0, 512, 0);
  g.addColorStop(0.0, 'rgba(0,0,0,0)'); g.addColorStop(0.22, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.36, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.06)');
  g.addColorStop(0.64, 'rgba(0,0,0,0)'); g.addColorStop(0.78, 'rgba(0,0,0,0.22)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 512, 512);
  // edge lines (slightly worn)
  x.fillStyle = 'rgba(232,228,214,0.92)';
  x.fillRect(24, 0, 9, 512); x.fillRect(512 - 33, 0, 9, 512);
  x.globalAlpha = 0.35; grain(x, 512, 512, 600, 0.5); x.globalAlpha = 1;
  // dashed hot center line — magenta-orange APEX brand
  const cg = x.createLinearGradient(0, 0, 0, 512);
  cg.addColorStop(0, '#ff9a3d'); cg.addColorStop(1, '#ff5d3d');
  x.fillStyle = cg;
  for (let ySeg = 0; ySeg < 512; ySeg += 128) x.fillRect(251, ySeg, 10, 74);
  return tex(c);
}

function dirtTexture() {
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#6e5033'; x.fillRect(0, 0, 512, 512);
  grain(x, 512, 512, 12000, 0.2);
  // twin ruts
  const g = x.createLinearGradient(0, 0, 512, 0);
  g.addColorStop(0.0, 'rgba(40,26,14,0.25)'); g.addColorStop(0.2, 'rgba(30,20,10,0.5)');
  g.addColorStop(0.34, 'rgba(90,70,45,0.1)'); g.addColorStop(0.5, 'rgba(120,95,60,0.28)');
  g.addColorStop(0.66, 'rgba(90,70,45,0.1)'); g.addColorStop(0.8, 'rgba(30,20,10,0.5)');
  g.addColorStop(1.0, 'rgba(40,26,14,0.25)');
  x.fillStyle = g; x.fillRect(0, 0, 512, 512);
  // stones
  for (let i = 0; i < 260; i++) {
    x.fillStyle = `rgba(${120 + rng() * 60 | 0},${100 + rng() * 40 | 0},${70 + rng() * 30 | 0},0.55)`;
    const s = 2 + rng() * 5;
    x.beginPath(); x.arc(rng() * 512, rng() * 512, s, 0, 7); x.fill();
  }
  return tex(c);
}

function woodTexture() {
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#7a5b38'; x.fillRect(0, 0, 512, 512);
  // planks laid ACROSS the road (horizontal bands in v)
  for (let y = 0; y < 512; y += 42) {
    const tone = 96 + rng() * 44;
    x.fillStyle = `rgb(${tone + 20 | 0},${tone * 0.72 | 0},${tone * 0.45 | 0})`;
    x.fillRect(0, y, 512, 39);
    x.strokeStyle = 'rgba(28,18,10,0.85)'; x.lineWidth = 3;
    x.strokeRect(-2, y, 516, 39);
    // grain streaks
    x.strokeStyle = 'rgba(50,32,16,0.3)'; x.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const gy = y + 4 + rng() * 32;
      x.beginPath(); x.moveTo(0, gy); x.bezierCurveTo(170, gy + rng() * 6 - 3, 340, gy + rng() * 6 - 3, 512, gy); x.stroke();
    }
    // bolts
    x.fillStyle = 'rgba(30,26,24,0.9)';
    x.beginPath(); x.arc(30, y + 20, 4, 0, 7); x.arc(482, y + 20, 4, 0, 7); x.fill();
  }
  grain(x, 512, 512, 3000, 0.1);
  return tex(c);
}

function metalTexture() {
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#4c5258'; x.fillRect(0, 0, 512, 512);
  // diamond tread plate
  x.fillStyle = 'rgba(255,255,255,0.10)';
  x.strokeStyle = 'rgba(10,12,14,0.5)';
  for (let yy = 0; yy < 512; yy += 32) {
    for (let xx = 0; xx < 512; xx += 32) {
      const ox = (yy / 32) % 2 ? 16 : 0;
      x.save(); x.translate(xx + ox + 16, yy + 16); x.rotate(0.78);
      x.fillRect(-9, -3, 18, 6); x.strokeRect(-9, -3, 18, 6);
      x.restore();
    }
  }
  grain(x, 512, 512, 4000, 0.12);
  // safety edge stripes
  x.fillStyle = 'rgba(255,180,40,0.85)';
  for (let ySeg = 0; ySeg < 512; ySeg += 64) { x.fillRect(6, ySeg, 14, 40); x.fillRect(492, ySeg + 32, 14, 40); }
  return tex(c);
}

function sandTexture() {
  const [c, x] = canvas(256, 256);
  x.fillStyle = '#c49a62'; x.fillRect(0, 0, 256, 256);
  grain(x, 256, 256, 5000, 0.12);
  return tex(c);
}

/** Big yellow/black chevrons pointing "up" (along +v = direction of travel). */
function chevronTexture() {
  const [c, x] = canvas(256, 256);
  x.fillStyle = '#151210'; x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#ffc21a';
  for (let i = -1; i < 3; i++) {
    const y0 = i * 96;
    x.beginPath();
    x.moveTo(0, y0 + 64); x.lineTo(128, y0); x.lineTo(256, y0 + 64);
    x.lineTo(256, y0 + 110); x.lineTo(128, y0 + 46); x.lineTo(0, y0 + 110);
    x.closePath(); x.fill();
  }
  grain(x, 256, 256, 1200, 0.15);
  return tex(c);
}

function billboardTexture(text, sub, hue) {
  const [c, x] = canvas(512, 256);
  const g = x.createLinearGradient(0, 0, 512, 256);
  g.addColorStop(0, `hsl(${hue},85%,52%)`); g.addColorStop(1, `hsl(${(hue + 40) % 360},90%,45%)`);
  x.fillStyle = g; x.fillRect(0, 0, 512, 256);
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, 190, 512, 66);
  x.fillStyle = '#fff';
  x.font = 'italic 900 84px "Arial Narrow", Arial';
  x.textAlign = 'center';
  x.fillText(text, 256, 118);
  x.font = '700 34px "Arial Narrow", Arial';
  x.fillText(sub, 256, 238);
  x.strokeStyle = 'rgba(255,255,255,0.8)'; x.lineWidth = 10; x.strokeRect(5, 5, 502, 246);
  return tex(c, { repeatY: false });
}

// ---------------------------------------------------------------------------

export function buildMaterials() {
  const asphaltMap = asphaltTexture();
  const dirtMap = dirtTexture();
  const woodMap = woodTexture();
  const metalMap = metalTexture();
  const sandMap = sandTexture();

  const road = {
    asphalt: new THREE.MeshStandardMaterial({
      map: asphaltMap, roughness: 0.88, metalness: 0.02, vertexColors: true,
    }),
    dirt: new THREE.MeshStandardMaterial({
      map: dirtMap, roughness: 1.0, metalness: 0.0, vertexColors: true,
    }),
    wood: new THREE.MeshStandardMaterial({
      map: woodMap, roughness: 0.8, metalness: 0.05, vertexColors: true,
    }),
    metal: new THREE.MeshStandardMaterial({
      map: metalMap, roughness: 0.45, metalness: 0.75, vertexColors: true,
    }),
    water: new THREE.MeshStandardMaterial({
      map: dirtMap, roughness: 0.65, metalness: 0.0, vertexColors: true,
      color: new THREE.Color(0x8a9aa0),
    }),
  };

  const chevron = new THREE.MeshStandardMaterial({
    map: chevronTexture(), roughness: 0.7, metalness: 0.1,
    emissive: new THREE.Color(4400640), emissiveIntensity: 0.25, // dim amber glow so chevrons read at dusk
  });

  const terrain = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1.0, metalness: 0.0,
    map: sandMap,
  });
  sandMap.repeat.set(180, 180);

  const cliff = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.0,
  });

  const guardrail = new THREE.MeshStandardMaterial({
    color: 0x9aa3ab, roughness: 0.35, metalness: 0.85, map: null,
  });

  const waterPlane = new THREE.MeshStandardMaterial({
    color: 0x2e5d66, roughness: 0.12, metalness: 0.0,
    transparent: true, opacity: 0.82,
  });

  const invisible = new THREE.MeshBasicMaterial({ visible: false });

  return {
    road, chevron, terrain, cliff, guardrail, waterPlane, invisible,
    maps: { asphaltMap, dirtMap, woodMap, metalMap, sandMap },
    billboardTexture,
  };
}
