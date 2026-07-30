// Procedural 2x2 particle atlas (256px canvas, 128px tiles), drawn in white so the
// shader color ramp tints it. uv row 0 (tiles 0,1) maps to the canvas bottom half
// because CanvasTexture flips Y.
//   tile 0: soft noisy blob (smoke/dust)   tile 1: hot glow dot (sparks/fire)
//   tile 2: soft annulus (shockwave/splash) tile 3: solid shaded chunk (debris/confetti)

import * as THREE from 'three';

export function buildParticleAtlas() {
  const S = 256;
  const T = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, S, S);

  const tileX = (t) => (t % 2) * T;
  const tileY = (t) => (t < 2 ? T : 0); // flipY: uv row 0 = canvas bottom

  // ---- tile 0: soft noisy blob ----
  {
    const x = tileX(0), y = tileY(0), cx = x + 64, cy = y + 64;
    const g = c.createRadialGradient(cx, cy, 4, cx, cy, 58);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, T, T);
    // punch wispy holes for texture
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 42;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      const pr = 4 + Math.random() * 12;
      const ng = c.createRadialGradient(px, py, 0, px, py, pr);
      ng.addColorStop(0, 'rgba(0,0,0,0.26)');
      ng.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = ng;
      c.beginPath();
      c.arc(px, py, pr, 0, 6.2832);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  // ---- tile 1: hot glow dot ----
  {
    const x = tileX(1), y = tileY(1), cx = x + 64, cy = y + 64;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, 56);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, T, T);
  }

  // ---- tile 2: soft annulus ----
  {
    const x = tileX(2), y = tileY(2), cx = x + 64, cy = y + 64;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, 60);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(0.64, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.92, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, T, T);
  }

  // ---- tile 3: solid shaded chunk ----
  {
    const x = tileX(3), y = tileY(3);
    c.fillStyle = 'rgba(255,255,255,1)';
    c.fillRect(x + 34, y + 34, 60, 60);
    // shade one corner so tumbling reads as 3D
    const g = c.createLinearGradient(x + 34, y + 34, x + 94, y + 94);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(70,70,70,0.75)');
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = g;
    c.fillRect(x + 34, y + 34, 60, 60);
    c.globalCompositeOperation = 'source-over';
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
