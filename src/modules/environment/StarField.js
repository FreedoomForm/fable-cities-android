/**
 * Baked celestial textures: a cube map with the Milky Way band (dust lanes, warm bulge — individual
 * stars are procedural in the shader), and an equirect moon albedo map with maria and craters.
 * All deterministic for a seed.
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';
import { SimplexNoise } from '../../shared/noise.js';

const FACE_SIZE = 256;
/** Star intensity stored as alpha; radiance = rgb * alpha * STAR_ALPHA_SCALE in the shader. */
export const STAR_ALPHA_SCALE = 0.7; // low scale: the cube only holds the (dim) Milky Way, so 8-bit alpha keeps its gradients

// Face → direction (WebGL cube map convention; s,t in [-1,1], t grows downwards in the image)
function faceDir(face, s, t, out) {
  switch (face) {
    case 0: return out.set(1, -t, -s);
    case 1: return out.set(-1, -t, s);
    case 2: return out.set(s, 1, t);
    case 3: return out.set(s, -1, -t);
    case 4: return out.set(s, -t, 1);
    default: return out.set(-s, -t, -1);
  }
}
// project a direction onto a given face (may fall outside [-1,1])
function projectToFace(face, d) {
  switch (face) {
    case 0: return d.x > 0 ? { s: -d.z / d.x, t: -d.y / d.x } : null;
    case 1: return d.x < 0 ? { s: d.z / -d.x, t: -d.y / -d.x } : null;
    case 2: return d.y > 0 ? { s: d.x / d.y, t: d.z / d.y } : null;
    case 3: return d.y < 0 ? { s: d.x / -d.y, t: -d.z / -d.y } : null;
    case 4: return d.z > 0 ? { s: d.x / d.z, t: -d.y / d.z } : null;
    default: return d.z < 0 ? { s: -d.x / -d.z, t: -d.y / -d.z } : null;
  }
}

/** Black-body-ish star colour by spectral class in linear RGB. */
function starColor(rng) {
  const r = rng();
  if (r < 0.03) return [0.62, 0.72, 1.0];   // O/B blue
  if (r < 0.12) return [0.78, 0.85, 1.0];   // A blue-white
  if (r < 0.30) return [0.95, 0.96, 1.0];   // F white
  if (r < 0.60) return [1.0, 0.95, 0.85];   // G yellow-white
  if (r < 0.85) return [1.0, 0.82, 0.62];   // K orange
  return [1.0, 0.66, 0.45];                  // M red
}

/**
 * Build the star/Milky Way cube texture (celestial frame: +Y = celestial pole).
 * @returns {THREE.CubeTexture}
 */
export function buildStarCubeTexture(seed) {
  const rng = makeRng(seed ^ 0x5741);
  const simplex = new SimplexNoise(seed ^ 0x9d1);
  const N = FACE_SIZE;
  const faces = [];
  for (let f = 0; f < 6; f++) faces.push(new Float32Array(N * N * 3));

  // --- galactic frame (tilt ~63° from celestial equator, seeded roll) ---
  const tilt = 62.9 * Math.PI / 180;
  const roll = rng() * Math.PI * 2;
  const gPole = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)).applyAxisAngle(new THREE.Vector3(0, 1, 0), roll).normalize();
  const gX = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), roll);
  gX.sub(gPole.clone().multiplyScalar(gX.dot(gPole))).normalize();
  const gY = new THREE.Vector3().crossVectors(gPole, gX).normalize();

  // --- Milky Way at low resolution, bilinear upsampled ---
  const M = 96;
  const mw = [];
  const d = new THREE.Vector3();
  for (let f = 0; f < 6; f++) {
    const buf = new Float32Array(M * M * 3);
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        faceDir(f, (2 * (i + 0.5)) / M - 1, (2 * (j + 0.5)) / M - 1, d).normalize();
        const lat = Math.asin(THREE.MathUtils.clamp(d.dot(gPole), -1, 1));
        const lon = Math.atan2(d.dot(gY), d.dot(gX)); // 0 = galactic centre
        const bulge = Math.exp(-(lon * lon) / (2 * 0.55 * 0.55));
        const sigma = 0.085 + 0.12 * bulge;
        const band = Math.exp(-(lat * lat) / (2 * sigma * sigma));
        const wide = Math.exp(-(lat * lat) / (2 * 0.30 * 0.30)) * 0.16;
        const n1 = 0.55 + 0.45 * simplex.fbm2D(lon * 2.2 + 3.1, lat * 9.0, 4);
        const n2 = simplex.fbm2D(lon * 5.5 - 7.0, lat * 22.0 + 2.0, 4); // dust lanes
        const dust = THREE.MathUtils.smoothstep(n2, 0.05, 0.55) * (0.6 + 0.4 * bulge) * band;
        let inten = (band * (0.6 + 1.2 * bulge) * n1 + wide) * (1 - 0.9 * dust);
        inten = Math.max(0, inten) * 0.3;
        const warm = bulge * 0.5 + 0.2;
        buf[(j * M + i) * 3] = inten * (0.86 + 0.16 * warm);
        buf[(j * M + i) * 3 + 1] = inten * (0.88 + 0.06 * warm);
        buf[(j * M + i) * 3 + 2] = inten * (1.0 - 0.18 * warm);
      }
    }
    mw.push(buf);
  }
  for (let f = 0; f < 6; f++) {
    const src = mw[f], dst = faces[f];
    for (let j = 0; j < N; j++) {
      const y = ((j + 0.5) / N) * M - 0.5;
      const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(M - 1, y0 + 1), fy = Math.min(1, Math.max(0, y - y0));
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * M - 0.5;
        const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(M - 1, x0 + 1), fx = Math.min(1, Math.max(0, x - x0));
        const o = (j * N + i) * 3;
        for (let c = 0; c < 3; c++) {
          const a = src[(y0 * M + x0) * 3 + c] * (1 - fx) + src[(y0 * M + x1) * 3 + c] * fx;
          const b = src[(y1 * M + x0) * 3 + c] * (1 - fx) + src[(y1 * M + x1) * 3 + c] * fx;
          dst[o + c] = a * (1 - fy) + b * fy;
        }
      }
    }
  }

  // --- encode: rgb = chroma, a = intensity / STAR_ALPHA_SCALE ---
  const images = [];
  for (let f = 0; f < 6; f++) {
    const src = faces[f];
    const data = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
      const m = Math.max(r, g, b, 1e-6);
      const a = Math.min(1, m / STAR_ALPHA_SCALE); // decoded radiance = rgb * a * STAR_ALPHA_SCALE
      data[i * 4] = Math.round((r / m) * 255);
      data[i * 4 + 1] = Math.round((g / m) * 255);
      data[i * 4 + 2] = Math.round((b / m) * 255);
      data[i * 4 + 3] = Math.round(a * 255);
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    images.push(tex);
  }
  const cube = new THREE.CubeTexture(images);
  cube.format = THREE.RGBAFormat;
  cube.type = THREE.UnsignedByteType;
  cube.colorSpace = THREE.NoColorSpace;
  cube.minFilter = THREE.LinearFilter;
  cube.magFilter = THREE.LinearFilter;
  cube.generateMipmaps = false;
  cube.flipY = false;
  cube.needsUpdate = true;
  return cube;
}

/** Equirect moon albedo (linear grey levels stored in a NoColorSpace RGBA texture). */
export function buildMoonTexture(seed) {
  const W = 512, H = 256;
  const rng = makeRng(seed ^ 0x3a7e);
  const simplex = new SimplexNoise(seed ^ 0x77);
  const data = new Uint8Array(W * H * 4);
  const alb = new Float32Array(W * H);
  // base: highlands with subtle variation, maria as darker blotches
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const theta = v * Math.PI;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const phi = u * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
      const hi = 0.5 + 0.5 * simplex.noise3D(x * 3.1, y * 3.1, z * 3.1) * 0.5 + 0.5 * simplex.noise3D(x * 9, y * 9, z * 9) * 0.25;
      const maria = simplex.noise3D(x * 1.6 + 5, y * 1.6, z * 1.6 - 3) * 0.6 + simplex.noise3D(x * 3.5, y * 3.5 + 2, z * 3.5) * 0.4;
      const m = THREE.MathUtils.smoothstep(maria, 0.12, 0.42);
      alb[j * W + i] = THREE.MathUtils.lerp(0.62 + 0.14 * (hi - 0.5), 0.34 + 0.05 * (hi - 0.5), m);
    }
  }
  // craters
  const CR = 180;
  for (let c = 0; c < CR; c++) {
    const cu = rng() * W, cv = rng() * H;
    const rad = 2 + Math.pow(rng(), 2.2) * 26;
    const depth = 0.25 + rng() * 0.35;
    const r2 = Math.ceil(rad * 1.5);
    for (let dy = -r2; dy <= r2; dy++) {
      const jj = Math.round(cv + dy);
      if (jj < 0 || jj >= H) continue;
      const stretch = 1 / Math.max(0.25, Math.sin(((jj + 0.5) / H) * Math.PI));
      for (let dx = -r2 * stretch; dx <= r2 * stretch; dx++) {
        const ii = ((Math.round(cu + dx) % W) + W) % W;
        const dd = Math.hypot(dx / stretch, dy) / rad;
        if (dd > 1.5) continue;
        const idx = jj * W + ii;
        let f = 0;
        if (dd < 0.85) f = -depth * (1 - dd * dd * 0.5);           // floor
        else if (dd < 1.05) f = 0.22 * (1 - Math.abs(dd - 0.95) / 0.1); // rim
        else f = -0.04 * (1 - (dd - 1.05) / 0.45);                     // ejecta shadow
        alb[idx] = Math.max(0.05, Math.min(1, alb[idx] + f * 0.5));
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(Math.min(1, Math.max(0, alb[i])) * 255);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
