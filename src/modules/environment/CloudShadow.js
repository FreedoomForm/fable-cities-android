/**
 * Cloud-shadow map for engine.setSunModulation: an R8 texture (1 = full sun, <1 under cloud) baked
 * on the CPU from the same data the volumetric cloud shader uses — the tileable weather map
 * (coverage fronts, km-scale) eroded by a slice of the 64³ Perlin-Worley shape noise (cumulus cells,
 * hundreds of metres) — so the shadows on the ground have the size and cellular breakup of the
 * clouds in the sky. Re-baked only when coverage changes noticeably (~2 ms for 512²).
 * Deterministic per seed (both source textures are).
 */
import * as THREE from 'three';

const SIZE = 512;
const CLOUD_BASE = 1000, CLOUD_THICK = 2350;   // must match CloudLayer uCloudBase / uCloudTop
const BASE_SCALE = 5600;                       // must match CloudLayer uBaseScale

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

export class CloudShadowMap {
  /**
   * @param weatherTexture DataTexture from buildWeatherTexture (RGBA8; R = rank-equalised coverage, B = mid structure)
   * @param noiseTexture   Data3DTexture from buildCloudNoiseTexture (RGBA8; R = Perlin-Worley, GBA = Worley octaves)
   * @param weatherScale   metres per weather tile (matches uWeatherScale)
   */
  constructor(weatherTexture, noiseTexture, weatherScale = 22000, { noiseTile = 780, shapeK = 1.0 } = {}) {
    this.shapeK = shapeK;
    const N = SIZE;
    this.size = N;
    this.field = new Float32Array(N * N);   // weather coverage field (thresholded per bake)
    this.base = new Float32Array(N * N);    // shape-noise base density low in the cloud (hf ≈ 0.12)
    const wImg = weatherTexture.image, M = wImg.width, w = wImg.data;
    const nImg = noiseTexture.image, K = nImg.width, nd = nImg.data;
    const wrapM = (i) => ((i % M) + M) % M;
    const wrapK = (i) => ((i % K) + K) % K;
    // cumulus cells: the shape noise is sampled on a ~780 m tile (250-450 m cells) with an integer number of
    // repeats per weather tile so the shadow texture itself stays seamless. Cells MUST stay well under the size
    // of a framed subject: at 1600 m one cell blanketed a whole 400 m set, which reads as a dull grey day rather
    // than as cloud shadow, and removed the sun the frame's modelling depends on.
    const noiseRepeats = Math.max(1, Math.round(weatherScale / noiseTile));
    // fixed y slice: hf 0.12 above the base, shader maps y → y * 0.85 / 8000 in noise space
    const qy = ((CLOUD_BASE + 0.12 * CLOUD_THICK) * 0.85 / BASE_SCALE) * K;
    const y0 = Math.floor(qy), ty = qy - y0, ya = wrapK(y0), yb = wrapK(y0 + 1);
    const hg = 0.92; // heightGradient(0.12) for cumulus-ish type (see CLOUD_FRAGMENT)
    const sampleNoise = (fx, fz) => {
      // trilinear on the 64³ RGBA volume at (fx, qy, fz) [texel units]
      const x0 = Math.floor(fx), tx = fx - x0, xa = wrapK(x0), xb = wrapK(x0 + 1);
      const z0 = Math.floor(fz), tz = fz - z0, za = wrapK(z0), zb = wrapK(z0 + 1);
      let r = 0, g = 0, b = 0, a = 0;
      const corners = [[xa, ya, za, (1 - tx) * (1 - ty) * (1 - tz)], [xb, ya, za, tx * (1 - ty) * (1 - tz)], [xa, yb, za, (1 - tx) * ty * (1 - tz)], [xb, yb, za, tx * ty * (1 - tz)],
        [xa, ya, zb, (1 - tx) * (1 - ty) * tz], [xb, ya, zb, tx * (1 - ty) * tz], [xa, yb, zb, (1 - tx) * ty * tz], [xb, yb, zb, tx * ty * tz]];
      for (const [x, y, z, wt] of corners) {
        const i = ((z * K + y) * K + x) * 4;
        r += nd[i] * wt; g += nd[i + 1] * wt; b += nd[i + 2] * wt; a += nd[i + 3] * wt;
      }
      return [r / 255, g / 255, b / 255, a / 255];
    };
    for (let y = 0; y < N; y++) {
      const v = (y + 0.5) / N;
      const fy = v * M - 0.5, wy0 = Math.floor(fy), wty = fy - wy0, wya = wrapM(wy0), wyb = wrapM(wy0 + 1);
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N;
        const fx = u * M - 0.5, wx0 = Math.floor(fx), wtx = fx - wx0, wxa = wrapM(wx0), wxb = wrapM(wx0 + 1);
        const i00 = (wya * M + wxa) * 4, i10 = (wya * M + wxb) * 4, i01 = (wyb * M + wxa) * 4, i11 = (wyb * M + wxb) * 4;
        const r = ((w[i00] * (1 - wtx) + w[i10] * wtx) * (1 - wty) + (w[i01] * (1 - wtx) + w[i11] * wtx) * wty) / 255;
        const bl = ((w[i00 + 2] * (1 - wtx) + w[i10 + 2] * wtx) * (1 - wty) + (w[i01 + 2] * (1 - wtx) + w[i11 + 2] * wtx) * wty) / 255;
        this.field[y * N + x] = r + (bl - 0.5) * 0.3; // same field coverageAt() thresholds
        // shape noise: Perlin-Worley (cumulus cells) sharpened by the first Worley octave
        const [pw, g] = sampleNoise(u * noiseRepeats * K, v * noiseRepeats * K);
        this.base[y * N + x] = clamp01(pw * 0.8 + (1 - g) * 0.2) * hg;
      }
    }
    // rank-equalise the shape noise so cell thresholds are exact area fractions
    const order = Array.from(this.base.keys()).sort((i, j) => this.base[i] - this.base[j]);
    for (let r = 0; r < order.length; r++) this.base[order[r]] = (r + 0.5) / order.length;
    this.data = new Uint8Array(N * N).fill(255);
    const tex = new THREE.DataTexture(this.data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.name = 'env-cloud-shadow';
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.texture = tex;
    this.bakedCover = -1;
    this.bakedStrength = -1;
    this.shadowFraction = 0;
  }

  /** Re-threshold for the current cloud coverage (0..1) and shadow strength (0..1). Returns true if re-baked. */
  update(cover, strength) {
    if (Math.abs(cover - this.bakedCover) < 0.012 && Math.abs(strength - this.bakedStrength) < 0.02) return false;
    const th = 1 - cover;
    const a = th - 0.3, b = th + 0.16;
    // cell fraction inside a coverage front: scattered cumulus cells at low coverage, cells merge into a
    // deck as the coverage rises; base is rank-equalised so (1 - cf) is the exact threshold
    const cf = 0.42 + 0.58 * sstep(0.3, 0.9, cover) * this.shapeK;
    const pT = 1 - cf;
    const f = this.field, base = this.base, d = this.data;
    let shaded = 0;
    for (let i = 0; i < f.length; i++) {
      const cov = sstep(a, b, f[i]);
      let shadow = 1;
      if (cov > 0.002) {
        const cell = sstep(pT - 0.08, pT + 0.16, base[i]);
        const dens = cov * cell;
        const trans = Math.exp(-dens * 6.5);  // Beer through the cell: soft-edged, dark core
        shadow = 1 - strength * (1 - trans);
      }
      shaded += 1 - shadow;
      d[i] = Math.round(shadow * 255);
    }
    this.shadowFraction = shaded / f.length;
    this.texture.needsUpdate = true;
    this.bakedCover = cover;
    this.bakedStrength = strength;
    return true;
  }

  dispose() {
    this.texture.dispose();
  }
}
