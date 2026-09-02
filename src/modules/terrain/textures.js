/**
 * Texture helpers for the terrain module:
 *   - loads the CC0 ambientCG PBR sets into two sampler2DArray textures (albedo+AO, normal+roughness)
 *   - generates deterministic procedural textures (tileable noise, water normals, leaf/needle cards,
 *     undergrowth atlas) on a canvas so we do not depend on assets that cannot be CC0-sourced easily.
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';
import { SimplexNoise } from '../../shared/noise.js';

/** Terrain splat layers — index order matters (matches the shader). */
export const LAYERS = [
  { name: 'grass', dir: 'Grass004', scale: 5.0 },
  { name: 'drygrass', dir: 'Grass003', scale: 5.5 },
  { name: 'dirt', dir: 'Ground048', scale: 4.5 },
  { name: 'rock', dir: 'Rock030', scale: 7.0 },
  { name: 'sand', dir: 'Ground033', scale: 4.0 },
  { name: 'mud', dir: 'Ground054', scale: 4.0 },
  { name: 'rock2', dir: 'Rock035', scale: 9.0 },
  { name: 'forestfloor', dir: 'forest_floor', scale: 4.0 },
];

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image failed ' + url));
  img.src = url;
});

function drawToData(img, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

/**
 * Build the two layer arrays. Returns { albedo, normal, size }.
 * albedo: RGB = colour (sRGB), A = ambient occlusion.  normal: RGB = tangent normal (GL), A = roughness.
 */
export async function loadLayerArrays(size = 1024, anisotropy = 16) {
  const n = LAYERS.length;
  const albedo = new Uint8Array(size * size * 4 * n);
  const normal = new Uint8Array(size * size * 4 * n);
  const avg = LAYERS.map(() => [0.5, 0.5, 0.5]);   // mean sRGB colour per layer (0..1) — used to tint undergrowth
  await Promise.all(LAYERS.map(async (layer, li) => {
    const base = `/assets/shared/${layer.dir}/`;
    const [col, nor, rou, ao] = await Promise.all([
      loadImage(base + 'color.jpg'), loadImage(base + 'normal.jpg'), loadImage(base + 'roughness.jpg'), loadImage(base + 'ao.jpg').catch(() => null),
    ]);
    const c = drawToData(col, size), nn = drawToData(nor, size), r = drawToData(rou, size), a = ao ? drawToData(ao, size) : null;
    const off = li * size * size * 4;
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let i = 0; i < size * size * 4; i += 4) {
      albedo[off + i] = c[i]; albedo[off + i + 1] = c[i + 1]; albedo[off + i + 2] = c[i + 2]; albedo[off + i + 3] = a ? a[i] : 255;
      normal[off + i] = nn[i]; normal[off + i + 1] = nn[i + 1]; normal[off + i + 2] = nn[i + 2]; normal[off + i + 3] = r[i];
      if ((i & 0x7c) === 0) { sr += c[i]; sg += c[i + 1]; sb += c[i + 2]; cnt++; }
    }
    avg[li] = [sr / cnt / 255, sg / cnt / 255, sb / cnt / 255];
  }));
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(albedo, true), normal: mk(normal, false), size, avg };
}

// -------------------------------------------------------------------------------------------------
// procedural textures
// -------------------------------------------------------------------------------------------------

/** Seamless fBm value in [0,1] using the 4-corner blend trick (tile period = 1 in uv). */
function seamlessFbm(noise, u, v, freq, oct) {
  const s = (x, y) => 0.5 + 0.5 * noise.fbm2D(x * freq, y * freq, oct);
  const a = s(u, v), b = s(u - 1, v), c = s(u, v - 1), d = s(u - 1, v - 1);
  const wu = u * u * (3 - 2 * u), wv = v * v * (3 - 2 * v);
  const top = a * (1 - wu) + b * wu;
  const bot = c * (1 - wu) + d * wu;
  return top * (1 - wv) + bot * wv;
}

/**
 * Tileable RGBA noise: R = large blotches, G = mid, B = fine, A = cellular-ish (for foam / variation).
 */
export function makeNoiseTexture(size = 512, seed = 1) {
  const n1 = new SimplexNoise(seed + 11), n2 = new SimplexNoise(seed + 12), n3 = new SimplexNoise(seed + 13), n4 = new SimplexNoise(seed + 14);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const k = (y * size + x) * 4;
      data[k] = 255 * seamlessFbm(n1, u, v, 2.0, 3);
      data[k + 1] = 255 * seamlessFbm(n2, u, v, 5.0, 4);
      data[k + 2] = 255 * seamlessFbm(n3, u, v, 13.0, 4);
      const w = seamlessFbm(n4, u, v, 7.0, 2);
      data[k + 3] = 255 * Math.pow(Math.abs(w * 2 - 1), 0.6);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Tileable water normal map from a sum of directional waves with integer wave counts. */
export function makeWaterNormalTexture(size = 512, seed = 3) {
  const rng = makeRng(seed);
  const waves = [];
  for (let i = 0; i < 18; i++) {
    const kx = rng.int(-7, 7), ky = rng.int(-7, 7);
    if (kx === 0 && ky === 0) continue;
    const len = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: (0.55 / len) * rng.range(0.4, 1.0), phase: rng.range(0, Math.PI * 2), sharp: rng.range(1.0, 2.2) });
  }
  const noise = new SimplexNoise(seed + 99);
  const data = new Uint8Array(size * size * 4);
  const height = (u, v) => {
    let h = 0;
    for (const w of waves) {
      const s = Math.sin(2 * Math.PI * (w.kx * u + w.ky * v) + w.phase);
      h += w.amp * Math.sign(s) * Math.pow(Math.abs(s), w.sharp);
    }
    h += 2.4 * (seamlessFbm(noise, u, v, 5, 4) - 0.5) + 0.9 * (seamlessFbm(noise, u + 0.37, v + 0.61, 11, 3) - 0.5);
    return h;
  };
  const e = 1 / size;
  const strength = 0.035;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const dx = (height(u + e, v) - height(u - e, v)) / (2 * e) * strength;
      const dy = (height(u, v + e) - height(u, v - e)) / (2 * e) * strength;
      const l = Math.hypot(dx, dy, 1);
      const k = (y * size + x) * 4;
      data[k] = 255 * (0.5 - 0.5 * dx / l);
      data[k + 1] = 255 * (0.5 - 0.5 * dy / l);
      data[k + 2] = 255 * (0.5 + 0.5 / l);
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function canvasTexture(canvas, { srgb = true, anisotropy = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.premultiplyAlpha = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Dilate colour into fully transparent pixels (nearest opaque colour, a few passes) and force alpha
 * strictly to 0 there, so mip-mapping never blends a foreign colour into the leaf edges.
 */
function dilateAlpha(g, size, fallback, height = size) {
  const img = g.getImageData(0, 0, size, height);
  const d = img.data;
  const mask = new Uint8Array(size * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) mask[p] = d[i + 3] >= 8 ? 1 : 0;
  const cur = mask;
  for (let pass = 0; pass < 6; pass++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < height; y++) for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (cur[p]) continue;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= height) continue;
        const q = yy * size + xx;
        if (!cur[q]) continue;
        r += d[q * 4]; gg += d[q * 4 + 1]; b += d[q * 4 + 2]; n++;
      }
      if (n) { d[p * 4] = r / n; d[p * 4 + 1] = gg / n; d[p * 4 + 2] = b / n; next[p] = 1; }
    }
    cur.set(next);
  }
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (!mask[p] && d[i + 3] < 8) { if (!cur[p]) { d[i] = fallback[0]; d[i + 1] = fallback[1]; d[i + 2] = fallback[2]; } d[i + 3] = 0; }
  }
  g.putImageData(img, 0, 0);
}

const hsl = (h, s, l) => `hsl(${h.toFixed(1)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%)`;

/** Sobel-emboss a canvas into a tangent-space normal map (RGB), alpha forced opaque. */
function normalFromCanvas(canvas, strength = 2.4) {
  const w = canvas.width, h = canvas.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const src = g.getImageData(0, 0, w, h).data;
  const hgt = new Float32Array(w * h);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const a = src[i + 3] / 255;
    hgt[p] = a * (0.3 * src[i] + 0.59 * src[i + 1] + 0.11 * src[i + 2]) / 255;
  }
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const og = out.getContext('2d');
  const img = og.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => hgt[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    const nx = -dx * strength, ny = -dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const k = (y * w + x) * 4;
    d[k] = 255 * (0.5 + 0.5 * nx / l); d[k + 1] = 255 * (0.5 + 0.5 * ny / l); d[k + 2] = 255 * (0.5 + 0.5 * nz / l); d[k + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  return canvasTexture(out, { srgb: false });
}

/**
 * Broadleaf leaf-spray card. Not a filled blob: a twig skeleton carrying ~700 individual leaves whose
 * outline is a noisy star (deep notches) with isolated leaves poking past the rim and punched-through
 * sky holes, so a crown assembled from these cards has a broken, lumpy silhouette instead of a ball.
 * Returns { map, normalMap }.
 */
export function makeBroadleafCardTexture(size = 512, seed = 5, hueBase = 100, lightBase = 0.26, sat = 0.34) {
  const rng = makeRng(seed);
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, size, size);
  const cx = size * 0.5, cy = size * 0.52;
  const R = size * 0.455;
  // --- irregular silhouette: R(theta) from 5 harmonics, plus 3 deep notches -------------------
  const harm = [];
  for (let k = 0; k < 5; k++) harm.push({ k: k + 2, a: rng.range(0.05, 0.17) / (k * 0.6 + 1), p: rng.range(0, Math.PI * 2) });
  const notches = [];
  for (let k = 0; k < 3; k++) notches.push({ a: rng.range(0, Math.PI * 2), w: rng.range(0.35, 0.7), d: rng.range(0.22, 0.42) });
  const radAt = (th) => {
    let r = 0.80;
    for (const hh of harm) r += hh.a * Math.sin(hh.k * th + hh.p);
    for (const n of notches) {
      let dd = Math.abs(((th - n.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      r -= n.d * Math.max(0, 1 - dd / n.w) ** 2;
    }
    return Math.max(0.24, r) * R;
  };
  // --- twig skeleton (visible through the gaps) -----------------------------------------------
  g.lineCap = 'round';
  const twigs = [];
  const nMain = 5;
  for (let i = 0; i < nMain; i++) {
    const a = -Math.PI * 0.5 + (i / (nMain - 1) - 0.5) * 2.45 + rng.range(-0.16, 0.16);
    const len = radAt(a) * rng.range(0.72, 0.98);
    twigs.push({ x0: cx, y0: cy + R * 0.62, x1: cx + Math.cos(a) * len, y1: cy + R * 0.62 + Math.sin(a) * len, w: 0.0075, a });
  }
  for (const t of twigs.slice()) {
    for (let k = 0; k < 3; k++) {
      const u = rng.range(0.35, 0.9);
      const bx = t.x0 + (t.x1 - t.x0) * u, by = t.y0 + (t.y1 - t.y0) * u;
      const a = t.a + (rng() < 0.5 ? 1 : -1) * rng.range(0.35, 0.85);
      const len = R * rng.range(0.14, 0.3);
      twigs.push({ x0: bx, y0: by, x1: bx + Math.cos(a) * len, y1: by + Math.sin(a) * len, w: 0.004, a });
    }
  }
  for (const t of twigs) {
    g.strokeStyle = hsl(28, 0.26, 0.13 + (t.w > 0.005 ? 0.03 : 0));
    g.lineWidth = size * t.w;
    g.beginPath(); g.moveTo(t.x0, t.y0); g.lineTo(t.x1, t.y1); g.stroke();
  }
  // --- leaves ---------------------------------------------------------------------------------
  const leaf = (x, y, r, rot, hue, s, light) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    const grd = g.createLinearGradient(0, -r, 0, r);
    grd.addColorStop(0, hsl(hue + 5, s * 0.9, Math.min(0.62, light * 1.22)));
    grd.addColorStop(1, hsl(hue - 7, s, light * 0.66));
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -r);
    g.bezierCurveTo(r * 0.62, -r * 0.55, r * 0.60, r * 0.5, 0, r);
    g.bezierCurveTo(-r * 0.60, r * 0.5, -r * 0.62, -r * 0.55, 0, -r);
    g.fill();
    g.strokeStyle = hsl(hue - 12, s * 0.45, light * 0.48);
    g.lineWidth = Math.max(0.7, r * 0.055);
    g.beginPath(); g.moveTo(0, -r * 0.85); g.lineTo(0, r * 0.85); g.stroke();
    g.restore();
  };
  const pts = [];
  const N = 900;
  for (let i = 0; i < N; i++) {
    // most leaves inside the outline, ~14 % isolated past the rim so the edge never reads as a curve
    const th = rng.range(0, Math.PI * 2);
    const rim = radAt(th);
    const out = rng() < 0.10;
    const rr = out ? rim * rng.range(1.0, 1.22) : rim * Math.pow(rng(), 0.52);
    const px = cx + Math.cos(th) * rr, py = cy + Math.sin(th) * rr * 0.98;
    pts.push({ x: px, y: py, out, t: rr / rim });
  }
  // paint back-to-front so the interior stays dark and the sunlit upper rim reads bright
  pts.sort((p, q) => (q.y * 0.75 + Math.abs(q.x - cx) * 0.25) - (p.y * 0.75 + Math.abs(p.x - cx) * 0.25));
  pts.forEach((p, i) => {
    const f = i / N;                                       // 0 back/bottom … 1 front/top
    const r = size * rng.range(0.026, 0.044) * (p.out ? 0.86 : 1.0);
    const hue = hueBase + rng.range(-11, 13) + (p.out ? 4 : 0);
    const vert = 1 - (p.y - (cy - R)) / (2 * R);           // 1 at the top of the card
    const light = lightBase * (0.62 + 0.5 * f + 0.42 * vert) + rng.range(-0.028, 0.028);
    leaf(p.x, p.y, r, rng.range(0, Math.PI * 2), hue, rng.range(sat - 0.09, sat + 0.09), Math.max(0.09, light));
  });
  // --- punch sky holes so light gets through the canopy ---------------------------------------
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 4; i++) {
    const th = rng.range(0, Math.PI * 2), rr = radAt(th) * rng.range(0.15, 0.62);
    const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
    const r = size * rng.range(0.024, 0.046);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.72, 'rgba(0,0,0,0.95)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const normalMap = normalFromCanvas(c, 2.0);
  dilateAlpha(g, size, [42, 62, 30]);
  return { map: canvasTexture(c), normalMap };
}

/**
 * Conifer bough card: the branch base sits at the LEFT edge, the stem runs to the right and droops,
 * side twigs feather out with needles that thin towards the tip. Placed radially around the trunk
 * (tilted down) it reads as a spruce/fir bough rather than a flat plate. Returns { map, normalMap }.
 */
export function makeConiferCardTexture(size = 512, seed = 9, hueBase = 118, lightBase = 0.24) {
  const rng = makeRng(seed);
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, size, size);
  const x0 = size * 0.03, yc = size * 0.5;
  const L = size * 0.94;
  g.lineCap = 'round';
  const stem = (u) => ({ x: x0 + L * u, y: yc + size * 0.085 * u * u });
  // --- twig skeleton: few, well separated fingers so the bough silhouette stays feathered ---
  const twigs = [];
  const nT = 15;
  for (let i = 0; i < nT; i++) {
    const u = 0.05 + 0.93 * (i / (nT - 1));
    const b = stem(u);
    const reach = size * (0.42 * (1 - u * 0.80) + 0.045) * rng.range(0.82, 1.1);
    for (const side of [-1, 1]) {
      // swept back towards the base of the bough → fir-like fingers, not a symmetric fan
      const a = side * (Math.PI * 0.5 - rng.range(0.55, 0.95));
      const ex = b.x + Math.cos(a) * reach * 0.30 + reach * 0.42;
      const ey = b.y + Math.sin(a) * reach;
      twigs.push({ x0: b.x, y0: b.y, x1: ex, y1: ey, u, side });
    }
    // a shorter finger between the main ones fills the bough without closing its feathered edge
    if (i < nT - 1) {
      const u2 = u + 0.93 / (nT - 1) * 0.5;
      const b2 = stem(u2);
      const r2 = size * (0.42 * (1 - u2 * 0.80) + 0.045) * rng.range(0.42, 0.62);
      for (const side of [-1, 1]) {
        const a = side * (Math.PI * 0.5 - rng.range(0.5, 0.9));
        twigs.push({ x0: b2.x, y0: b2.y, x1: b2.x + Math.cos(a) * r2 * 0.30 + r2 * 0.42, y1: b2.y + Math.sin(a) * r2, u: u2, side });
      }
    }
  }
  // main stem
  g.strokeStyle = hsl(26, 0.28, 0.14); g.lineWidth = size * 0.011;
  g.beginPath(); g.moveTo(x0, yc);
  for (let u = 0.05; u <= 1.0001; u += 0.05) { const p = stem(u); g.lineTo(p.x, p.y); }
  g.stroke();
  // thin dark backing along each finger only — enough body that mip-mapping keeps the finger,
  // not so much that the bough becomes one solid leaf
  for (const t of twigs) {
    const mx = (t.x0 + t.x1) * 0.5, my = (t.y0 + t.y1) * 0.5;
    const len = Math.hypot(t.x1 - t.x0, t.y1 - t.y0);
    g.save();
    g.translate(mx, my); g.rotate(Math.atan2(t.y1 - t.y0, t.x1 - t.x0));
    g.fillStyle = hsl(hueBase - 8, 0.32, lightBase * 0.62);
    g.globalAlpha = 0.85;
    g.beginPath(); g.ellipse(0, 0, len * 0.52, size * 0.017 * (1 - 0.4 * t.u), 0, 0, Math.PI * 2); g.fill();
    g.restore();
    g.strokeStyle = hsl(28, 0.26, 0.16); g.lineWidth = size * 0.0032 * (1 - t.u * 0.5);
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(t.x0, t.y0); g.lineTo(t.x1, t.y1); g.stroke();
  }
  // needles — dark base layer, then a brighter shorter top layer (light comes from above)
  for (let layer = 0; layer < 2; layer++) {
    for (const t of twigs) {
      const len = Math.hypot(t.x1 - t.x0, t.y1 - t.y0);
      const n = Math.max(10, Math.round(len / (size * 0.010)));
      const dirA = Math.atan2(t.y1 - t.y0, t.x1 - t.x0);
      for (let k = 0; k < n; k++) {
        const u = (k + rng()) / n;
        const px = t.x0 + (t.x1 - t.x0) * u, py = t.y0 + (t.y1 - t.y0) * u;
        // needles point outward along the finger and fan ±, shortening towards the tip
        const na = dirA + (rng() < 0.5 ? 1 : -1) * rng.range(0.7, 1.45) + (layer ? rng.range(-0.2, 0.2) : rng.range(-0.45, 0.45));
        const nl = size * rng.range(0.030, 0.052) * (1 - 0.30 * t.u) * (1 - 0.35 * u) * (layer ? 0.85 : 1);
        const light = lightBase * (layer ? 1.7 : 1.0) + 0.10 * rng() + 0.10 * (1 - u) * layer;
        g.strokeStyle = hsl(hueBase + rng.range(-14, 12), rng.range(0.24, 0.42), Math.min(0.58, light));
        g.lineWidth = size * (layer ? 0.0040 : 0.0052);
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); g.stroke();
      }
    }
  }
  const normalMap = normalFromCanvas(c, 2.6);
  dilateAlpha(c.getContext('2d', { willReadFrequently: true }), size, [26, 46, 30]);
  return { map: canvasTexture(c), normalMap };
}

/**
 * Undergrowth atlas (4×2 cells, bottom-anchored):
 *   0 green tuft · 1 broad tuft with seed heads · 2 dry tuft · 3 fern / low shrub
 *   4 low broad grass sheet · 5 weeds / clover patch · 6 wildflower tuft · 7 dry grass sheet
 * Colours are kept desaturated — the instance colour pulls each card towards the ground albedo.
 */
export function makeUndergrowthAtlas(size = 1024, seed = 21) {
  const rng = makeRng(seed);
  const c = document.createElement('canvas'); c.width = size; c.height = size / 2;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, size, size / 2);
  const cell = size / 4;
  const cellXY = (k) => [(k % 4) * cell, Math.floor(k / 4) * cell];
  const blades = (k, n, hue, sat, l0, l1, spread, seeds, lenMin = 0.5, lenMax = 0.96, widthMul = 1) => {
    const [ox, oy] = cellXY(k);
    const cx = ox + cell * 0.5, cy = oy + cell * 0.99;
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + rng.range(-spread, spread);
      const len = cell * rng.range(lenMin, lenMax);
      const bend = rng.range(-0.5, 0.5) * cell * 0.3;
      const w = cell * rng.range(0.016, 0.03) * widthMul;
      const h = hue + rng.range(-10, 12);
      const bx = cx + rng.range(-1, 1) * cell * (spread > 1 ? 0.42 : 0.08);
      const grd = g.createLinearGradient(bx, cy, bx, cy - len);
      grd.addColorStop(0, hsl(h - 6, sat, l0));
      grd.addColorStop(0.65, hsl(h, sat + 0.05, (l0 + l1) * 0.5));
      grd.addColorStop(1, hsl(h + 8, sat + 0.08, l1));
      g.fillStyle = grd;
      const tipX = bx + Math.cos(ang) * len + bend, tipY = cy + Math.sin(ang) * len;
      const midX = bx + Math.cos(ang) * len * 0.5 + bend * 0.35, midY = cy + Math.sin(ang) * len * 0.5;
      g.beginPath();
      g.moveTo(bx - w, cy);
      g.quadraticCurveTo(midX - w * 0.6, midY, tipX, tipY);
      g.quadraticCurveTo(midX + w * 0.6, midY, bx + w, cy);
      g.closePath();
      g.fill();
      if (seeds && rng() < 0.4) {
        g.fillStyle = hsl(h + 10, 0.3, 0.5);
        g.beginPath(); g.ellipse(tipX, tipY, w * 1.6, w * 3.2, ang + Math.PI / 2, 0, Math.PI * 2); g.fill();
      }
    }
  };
  const dots = (k, n, colours, yMin, yMax) => {
    const [ox, oy] = cellXY(k);
    for (let i = 0; i < n; i++) {
      const x = ox + cell * rng.range(0.12, 0.88), y = oy + cell * rng.range(yMin, yMax);
      const r = cell * rng.range(0.012, 0.022);
      g.fillStyle = rng.pick(colours);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,240,120,0.9)';
      g.beginPath(); g.arc(x, y, r * 0.4, 0, Math.PI * 2); g.fill();
    }
  };
  // 0: fine fescue — many narrow near-vertical blades, tight spread
  blades(0, 46, 96, 0.27, 0.15, 0.38, 0.34, false, 0.62, 0.99, 0.62);
  // 1: tall bent-grass — long arching culms with seed heads, wide spread (a clearly different silhouette)
  blades(1, 20, 76, 0.24, 0.16, 0.42, 1.15, true, 0.70, 1.0, 0.75);
  // 2: dry straw tuft
  blades(2, 30, 52, 0.22, 0.17, 0.36, 0.72, true, 0.45, 0.88, 0.85);
  // 3: fern / shrub — arching fronds with leaflets
  {
    const [ox, oy] = cellXY(3);
    const cx = ox + cell * 0.5, cy = oy + cell * 0.99;
    for (let i = 0; i < 9; i++) {
      const ang = -Math.PI / 2 + rng.range(-1.1, 1.1);
      const len = cell * rng.range(0.45, 0.85);
      const hue = 108 + rng.range(-10, 10);
      const steps = 14;
      let px = cx, py = cy;
      for (let s2 = 1; s2 <= steps; s2++) {
        const t = s2 / steps;
        const a = ang + t * t * 0.9 * Math.sign(Math.cos(ang) || 1);
        const nx = px + Math.cos(a) * len / steps, ny = py + Math.sin(a) * len / steps;
        g.strokeStyle = hsl(hue - 8, 0.32, 0.2); g.lineWidth = cell * 0.008 * (1 - t * 0.6);
        g.beginPath(); g.moveTo(px, py); g.lineTo(nx, ny); g.stroke();
        const ll = cell * 0.08 * (1 - t * 0.7);
        for (const side of [-1, 1]) {
          const la = a + side * 1.25;
          g.fillStyle = hsl(hue + rng.range(-6, 6), 0.34, 0.2 + 0.16 * t + rng.range(-0.03, 0.03));
          g.beginPath(); g.ellipse(nx + Math.cos(la) * ll * 0.5, ny + Math.sin(la) * ll * 0.5, ll * 0.5, ll * 0.16, la, 0, Math.PI * 2); g.fill();
        }
        px = nx; py = ny;
      }
    }
  }
  // 4: low, broad meadow sheet (dense short blades across the whole cell width)
  blades(4, 150, 100, 0.24, 0.13, 0.31, 0.60, false, 0.32, 0.70, 0.80);
  // 5: weeds / clover — short blades + round leaflets
  blades(5, 44, 104, 0.23, 0.15, 0.31, 0.7, false, 0.26, 0.5, 1.0);
  {
    const [ox, oy] = cellXY(5);
    for (let i = 0; i < 46; i++) {
      const x = ox + cell * rng.range(0.1, 0.9), y = oy + cell * rng.range(0.62, 0.97);
      const r = cell * rng.range(0.02, 0.036);
      g.fillStyle = hsl(104 + rng.range(-8, 8), 0.3, 0.2 + rng.range(0, 0.14));
      for (let l = 0; l < 3; l++) { const a = (l / 3) * Math.PI * 2 + rng.range(-0.2, 0.2); g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.6, r * 0.42, a, 0, Math.PI * 2); g.fill(); }
    }
  }
  // 6: wildflower tuft
  blades(6, 26, 86, 0.25, 0.15, 0.39, 0.70, false, 0.55, 0.95, 0.7);
  dots(6, 7, ['#cfc9b6', '#d2b64a', '#b8749a', '#d8d4c6'], 0.12, 0.55);
  // 7: dry sheet
  blades(7, 130, 56, 0.20, 0.15, 0.33, 0.62, true, 0.32, 0.70, 0.80);
  dilateAlpha(g, size, [40, 66, 30], size / 2);
  return canvasTexture(c);
}
