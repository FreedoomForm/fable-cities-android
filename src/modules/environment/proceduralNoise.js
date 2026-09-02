/**
 * Tileable, seeded noise generators used to bake cloud / weather / star textures.
 * Everything here is deterministic for a given seed (see src/shared/random.js).
 */
import { makeRng } from '../../shared/random.js';

/** Gradient (Perlin) noise on an integer lattice that wraps every `period` cells → tileable. */
export class TileablePerlin3D {
  constructor(seed, period = 16) {
    const rng = makeRng(seed);
    this.period = period;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // 16 gradient directions
    this.grad = [
      [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
      [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
      [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
      [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1],
    ];
  }
  _g(ix, iy, iz, period) {
    const perm = this.perm;
    ix = ((ix % period) + period) % period;
    iy = ((iy % period) + period) % period;
    iz = ((iz % period) + period) % period;
    return this.grad[perm[ix + perm[iy + perm[iz]]] & 15];
  }
  /** x,y,z in lattice units; tiles with period `period` (defaults to constructor period). Returns [-1,1]. */
  noise(x, y, z, period = this.period) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    let result = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const g = this._g(X + dx, Y + dy, Z + dz, period);
          const dot = g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
          const wgt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
          result += wgt * dot;
        }
      }
    }
    return result * 1.15;
  }
  /** fBm in [0,1] across `octaves`, each octave doubling the frequency (tileable when period*2^o is integer). */
  fbm(x, y, z, octaves = 3, basePeriod = this.period) {
    let amp = 0.5, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f, y * f, z * f, basePeriod * f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return 0.5 + 0.5 * (sum / norm);
  }
}

/** Tileable Worley (cellular) noise: one feature point per cell, wraps every `cells`. Returns inverted distance in [0,1]. */
export class TileableWorley3D {
  constructor(seed, cells = 4) {
    this.cells = cells;
    const rng = makeRng(seed);
    const n = cells * cells * cells;
    this.points = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.points[i * 3] = rng();
      this.points[i * 3 + 1] = rng();
      this.points[i * 3 + 2] = rng();
    }
  }
  /** x,y,z in [0,1) texture space. */
  sample(x, y, z) {
    const c = this.cells;
    const px = x * c, py = y * c, pz = z * c;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let minD = 1e9;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const wx = ((cx % c) + c) % c, wy = ((cy % c) + c) % c, wz = ((cz % c) + c) % c;
          const idx = (wx + wy * c + wz * c * c) * 3;
          const fx = cx + this.points[idx] - px;
          const fy = cy + this.points[idx + 1] - py;
          const fz = cz + this.points[idx + 2] - pz;
          const d = fx * fx + fy * fy + fz * fz;
          if (d < minD) minD = d;
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(minD));
  }
}

/** Tileable 2D fBm in [0,1] built from the 3D Perlin with z fixed. */
export class TileablePerlin2D {
  constructor(seed, period = 8) {
    this.p3 = new TileablePerlin3D(seed, period);
    this.period = period;
  }
  fbm(x, y, octaves = 4, basePeriod = this.period, gain = 0.5) {
    let amp = 0.5, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.p3.noise(x * f, y * f, 0.37, basePeriod * f);
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return 0.5 + 0.5 * (sum / norm);
  }
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
