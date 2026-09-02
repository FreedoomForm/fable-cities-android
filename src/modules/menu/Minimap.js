/**
 * Seed preview — a hillshaded survey chart of the map the current seed produces, drawn with a plain
 * 2D canvas from the same analytic generator as the world (and as the 3D backdrop). Cheap enough
 * (~10 ms) to repaint on every keystroke in the seed field, so rerolling visibly changes the land.
 */
const MAP_HALF = 1024;          // world.half — the playable map
const VIEW_HALF = 1180;         // a little margin so the coastline is not clipped

const RAMP = [
  // [height, r, g, b]
  [-24, 18, 40, 58],
  [-6, 30, 74, 96],
  [-0.5, 62, 122, 134],
  [0.6, 190, 176, 138],
  [4, 108, 128, 74],
  [26, 92, 114, 64],
  [70, 122, 118, 78],
  [130, 122, 112, 98],
  [180, 196, 200, 202],
  [260, 236, 242, 246],
];

function ramp(h, out) {
  let i = 0;
  while (i < RAMP.length - 1 && h > RAMP[i + 1][0]) i++;
  const a = RAMP[Math.max(0, i)], b = RAMP[Math.min(RAMP.length - 1, i + 1)];
  const t = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0])));
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

/**
 * Paint a relief chart of `source` into `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {{sample(x,z,lod):number}} source
 * @param {{ grid?:number, showFrame?:boolean, viewHalf?:number, lod?:number }} [opts]
 */
export function paintRelief(canvas, source, opts = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 120;
  const cssH = canvas.clientHeight || 120;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const aspect = Math.max(0.25, Math.min(4, canvas.width / canvas.height));
  const base = Math.max(48, Math.min(opts.grid || 176, 220));
  const Gy = Math.round(aspect >= 1 ? base : base * aspect);
  const Gx = Math.round(aspect >= 1 ? base * aspect : base);
  const halfZ = opts.viewHalf || VIEW_HALF;
  const halfX = halfZ * aspect;
  const lod = opts.lod == null ? 2 : opts.lod;
  const sx = (halfX * 2) / (Gx - 1);
  const sz = (halfZ * 2) / (Gy - 1);

  const H = new Float32Array(Gx * Gy);
  for (let j = 0; j < Gy; j++) {
    const z = -halfZ + j * sz;
    for (let i = 0; i < Gx; i++) H[j * Gx + i] = source.sample(-halfX + i * sx, z, lod);
  }

  const img = ctx.createImageData(Gx, Gy);
  const px = img.data;
  const c = [0, 0, 0];
  // light from the north-west, the cartographic convention
  const lx = -0.62, ly = 0.66, lz = -0.42;
  for (let j = 0; j < Gy; j++) {
    for (let i = 0; i < Gx; i++) {
      const k = j * Gx + i;
      const h = H[k];
      ramp(h, c);
      const hl = H[j * Gx + (i > 0 ? i - 1 : i)];
      const hr = H[j * Gx + (i < Gx - 1 ? i + 1 : i)];
      const hd = H[(j > 0 ? j - 1 : j) * Gx + i];
      const hu = H[(j < Gy - 1 ? j + 1 : j) * Gx + i];
      const dx = (hr - hl) / (2 * sx), dz = (hu - hd) / (2 * sz);
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      const nx = -dx * inv, ny = inv, nz = -dz * inv;
      let shade = nx * lx + ny * ly + nz * lz;
      shade = 0.52 + 0.72 * Math.max(0, shade);
      if (h <= 0) shade = 0.82 + 0.18 * shade;       // water stays flat and readable
      const o = k * 4;
      px[o] = Math.min(255, c[0] * shade);
      px[o + 1] = Math.min(255, c[1] * shade);
      px[o + 2] = Math.min(255, c[2] * shade);
      px[o + 3] = 255;
    }
  }

  const off = document.createElement('canvas');
  off.width = Gx; off.height = Gy;
  off.getContext('2d').putImageData(img, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  if (opts.showFrame !== false) {
    // the playable map boundary, as a survey frame
    const kx = canvas.width / (halfX * 2), kz = canvas.height / (halfZ * 2);
    const mx = (halfX - MAP_HALF) * kx, mz = (halfZ - MAP_HALF) * kz;
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeRect(mx, mz, canvas.width - 2 * mx, canvas.height - 2 * mz);
    ctx.setLineDash([]);
  }
  ctx.restore();
}
