/**
 * Procedural particle sprites (CC0 by construction — generated at init, deterministic per seed).
 *
 *  - smoke atlas: 4×4 eroded cauliflower puffs, RGB = tangent-space "pseudo normal" (for lit smoke), A = density.
 *    Density is a blob cluster eroded by 3 fBm octaves (threshold erosion → ragged internal turbulence,
 *    not an airbrush blob) with a second fine octave breaking the interior into wisps.
 *  - rain streak: head-weighted gaussian along the streak, tight gaussian across (alpha only)
 *  - spray: splash crown — a few small droplets on a short vertical arc (alpha only, camera-facing)
 *  - ring: thin impact ring for puddles (alpha only, additive)
 *  - snowflake: soft round flake with a slightly irregular edge (no star / hex shape)
 *
 * All textures carry data (not colour), so colorSpace = NoColorSpace.
 */
import * as THREE from 'three';
import { SimplexNoise } from '../../shared/noise.js';
import { makeRng } from '../../shared/random.js';
import { clamp01, smoothstep } from '../../shared/math.js';

function dataTexture(data, w, h, opts = {}) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy || 1;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = opts.name || 'effects-sprite';
  return tex;
}

/**
 * Smoke/dust puff atlas with eroded, turbulent interiors.
 * @returns {{texture: THREE.Texture, cols: number, rows: number}}
 */
export function makeSmokeAtlas(seed, cell = 256, cols = 4, rows = 4, anisotropy = 1) {
  const W = cell * cols, H = cell * rows;
  const data = new Uint8Array(W * H * 4);
  const noise = new SimplexNoise(seed ^ 0x5a0ce);
  const rng = makeRng(seed ^ 0x51);
  const height = new Float32Array(cell * cell);

  for (let py = 0; py < rows; py++) {
    for (let px = 0; px < cols; px++) {
      // cauliflower cluster: a dense centre lobe + 5-9 satellite lobes (each gets its own lit / shadow side
      // through the normal below → a puff reads as a cluster of small rolls, not one airbrush blob)
      const blobs = [];
      const n = 6 + rng.int(0, 4);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = i === 0 ? 0 : 0.09 + rng() * 0.25;
        blobs.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r, s: i === 0 ? 0.28 : 0.11 + rng() * 0.15 });
      }
      const nOff = rng() * 100;
      const freq = 3.0 + rng() * 2.0;
      const erode = 0.40 + rng() * 0.16;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell, v = (y + 0.5) / cell;
          let d = 0;
          for (const b of blobs) {
            const dx = u - b.x, dy = v - b.y;
            const q = Math.sqrt(dx * dx + dy * dy) / b.s;
            d += Math.max(0, 1 - q * q);
          }
          // 3-octave erosion field + a fine wisp octave
          const fb = noise.fbm2D(u * freq + nOff, v * freq + nOff * 0.7, 3, 2.15, 0.55);       // ~[-0.9, 0.9]
          const fine = noise.fbm2D(u * freq * 3.1 + nOff * 1.9, v * freq * 3.1 + nOff * 0.3, 2, 2.0, 0.5);
          const field = clamp01(d * 0.8) * (0.55 + 0.45 * (fb * 0.5 + 0.5));
          // threshold erosion: interior breaks into lobes; edges get ragged (no visible quad disc)
          let h = smoothstep(erode * (0.6 - fb * 0.35), 1.0, field + fine * 0.16);
          const cx = u - 0.5, cy = v - 0.5;
          const rr = Math.sqrt(cx * cx + cy * cy) * 2;
          h *= 1 - smoothstep(0.72 + fine * 0.1, 0.98, rr);
          height[y * cell + x] = clamp01(h);
        }
      }
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = y * cell + x;
          const h = height[i];
          const hl = height[y * cell + Math.max(0, x - 1)], hr = height[y * cell + Math.min(cell - 1, x + 1)];
          const hd = height[Math.max(0, y - 1) * cell + x], hu = height[Math.min(cell - 1, y + 1) * cell + x];
          // lobe normals (strong height derivative) blended with a sphere normal: every roll has a sun side
          let nx = (hl - hr) * 7.0 * cell / 256, ny = (hd - hu) * 7.0 * cell / 256, nz = 1.0;
          const cx = (x + 0.5) / cell - 0.5, cy = (y + 0.5) / cell - 0.5;
          const sr = Math.min(1, Math.sqrt(cx * cx + cy * cy) * 2.2);
          const sz = Math.sqrt(Math.max(0, 1 - sr * sr));
          nx = nx * 0.85 + cx * 2.2 * 0.65;
          ny = ny * 0.85 + cy * 2.2 * 0.65;
          nz = nz * 0.85 + sz * 0.65;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len; ny /= len; nz /= len;
          // dense core, thin ragged fringe
          const alpha = Math.pow(smoothstep(0.0, 0.82, h), 1.1);
          const o = ((py * cell + y) * W + (px * cell + x)) * 4;
          data[o] = Math.round((nx * 0.5 + 0.5) * 255);
          data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          data[o + 3] = Math.round(alpha * 255);
        }
      }
    }
  }
  return { texture: dataTexture(data, W, H, { anisotropy, name: 'effects-smoke-atlas' }), cols, rows };
}

/**
 * Rain streak: a motion-blurred drop. Alpha tapers as a GAUSSIAN along the streak (bright, slightly
 * thicker at the head where the drop is now, dissolving towards the tail it came from) and as a tight
 * gaussian across it, so a 2 px streak has soft 1 px edges instead of a hard white rod. Alpha only.
 */
export function makeRainStreak(w = 32, h = 256) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;                     // 0 tail … 1 head
    // head-weighted gaussian: the drop's current position carries most of the exposure
    const t = (v - 0.62) / 0.30;
    const along = Math.exp(-t * t) * (0.35 + 0.65 * smoothstep(0.0, 0.30, v)) * (1 - smoothstep(0.90, 1.0, v));
    // the tail is thinner than the head (the drop stretched over the exposure)
    const wid = 0.55 + 0.45 * smoothstep(0.15, 0.75, v);
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w - 0.5) * 2 / wid;
      const core = Math.exp(-u * u * 4.5);
      const a = clamp01(core * along);
      const o = (y * w + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(a * 255);
    }
  }
  return dataTexture(data, w, h, { name: 'effects-rain-streak' });
}

/**
 * Splash crown (camera-facing): a short arc of 5-7 tiny droplets thrown up from the impact point at the
 * bottom-centre of the sprite, plus a faint spray haze. Alpha only.
 */
export function makeSpray(seed, size = 64) {
  const data = new Uint8Array(size * size * 4);
  const rng = makeRng(seed ^ 0x5b1a5);
  const drops = [];
  const n = 5 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) / n * Math.PI * 0.9 + Math.PI * 0.05 + (rng() - 0.5) * 0.25;   // spread over the top half
    const r = 0.28 + rng() * 0.16;
    drops.push({ x: 0.5 + Math.cos(a) * r, y: 0.15 + Math.sin(a) * r, s: 0.035 + rng() * 0.03 });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;   // v grows upward (flipY=false → row 0 = bottom)
      let a = 0;
      for (const p of drops) {
        const q = Math.hypot(u - p.x, v - p.y) / p.s;
        a += Math.max(0, 1 - q * q);
      }
      // faint spray haze fanning up from the impact
      const dx = (u - 0.5), dy = v - 0.12;
      const rr = Math.hypot(dx, dy * 1.2);
      const haze = Math.max(0, 1 - rr / 0.46) * smoothstep(-0.02, 0.1, dy) * 0.26;
      // impact bead (large enough to survive minification at 4-8 px sprites)
      const bead = Math.exp(-Math.pow(rr / 0.095, 2)) * 0.7;
      a = clamp01(a * 0.8 + haze + bead);
      const o = (y * size + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(a * 255);
    }
  }
  return dataTexture(data, size, size, { name: 'effects-spray' });
}

/** Thin expanding impact ring (ground-aligned, puddles only). Alpha only. */
export function makeRing(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      // fat rim so a 6-10 px ring on screen still carries a ≥ 1.5 px line after minification
      const rim = Math.exp(-Math.pow((r - 0.68) / 0.2, 2));
      const inner = Math.exp(-Math.pow((r - 0.36) / 0.12, 2)) * 0.5;
      const a = clamp01(rim + inner) * (1 - smoothstep(0.86, 1.0, r));
      const o = (y * size + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(a * 255);
    }
  }
  return dataTexture(data, size, size, { name: 'effects-ring' });
}

/** Snowflake: soft round flake with a slightly irregular edge. Alpha only. */
export function makeSnowflake(size = 32) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const ang = Math.atan2(dy, dx);
      const wob = 1 + 0.06 * Math.sin(ang * 5 + 0.7) + 0.04 * Math.sin(ang * 3);
      // dense core + a soft halo: minified far flakes stay a crisp dot, magnified near flakes read as
      // a defocused bokeh disc with a slightly brighter rim
      const q = r / wob;
      const a = clamp01((1 - smoothstep(0.20, 0.62, q)) * 0.92 + (1 - smoothstep(0.55, 1.0, q)) * 0.30);
      const o = (y * size + x) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(a * 255);
    }
  }
  return dataTexture(data, size, size, { name: 'effects-snowflake' });
}
