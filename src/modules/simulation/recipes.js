/**
 * Procedural architecture for the eight city services. Each recipe fills a builder with
 * geometry parts keyed by material, plus vehicle placements, light pools and smoke sources.
 * Local space: origin at the footprint centre on the pad, +Z = street side (front), +Y up.
 * All UVs are in metres so the PBR sets tile at a physical scale.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PANES, PANE_W, BAND_H, WINDOW_ROWS } from './textures.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
export const FLOOR = 3.4;

// ---------------------------------------------------------------------------------------------
// geometry primitives
// ---------------------------------------------------------------------------------------------
/** Box with per-face UVs so one texture tile = `su` m (u) × `sv` m (v). */
export function box(w, h, d, su = 2, sv = su, uOff = 0, vOff = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * du / su + uOff, uv.getY(k) * dv / sv + vOff);
    }
  }
  return g;
}
export function cylinder(rTop, rBottom, h, scale = 2, seg = 24, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rTop + rBottom);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / scale, uv.getY(i) * h / scale);
  return g;
}
/** Plane facing +Z with an explicit UV window. */
export function quad(w, h, u0 = 0, u1 = 1, v0 = 0, v1 = 1) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}
export function place(g, x, y, z, ry = 0, rx = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  _m.compose(_v.set(x, y, z), _q, _s);
  g.applyMatrix4(_m);
  return g;
}
/** Sloped quad strip (embankment side): from edge A (y=ya) out to edge B (y=yb). */
function slope(x0, z0, x1, z1, ya, x2, z2, x3, z3, yb, uvScale = 3) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([x0, ya, z0, x1, ya, z1, x2, yb, z2, x3, yb, z3]);
  const len = Math.hypot(x1 - x0, z1 - z0), drop = Math.hypot(x2 - x0, z2 - z0, yb - ya);
  const uv = new Float32Array([0, 0, len / uvScale, 0, 0, drop / uvScale, len / uvScale, drop / uvScale]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------------------------
export function makeBuilder(skirt = 0) {
  return {
    list: [], vehicles: [], smoke: [], access: [], skirt,
    add(key, geo) { this.list.push({ key, geo }); return geo; },
    /** Vehicle access: a driveway is built from (x, z) in direction (dx, dz) to the nearest road. */
    drive(x, z, w = 7, dx = 0, dz = 1) { this.access.push({ x, z, w, dx, dz }); },
    vehicle(model, x, z, yaw = 0, opts = {}) { this.vehicles.push({ model, x, z, yaw, ...opts }); },
    smokeSource(kind, x, y, z, opts = {}) { this.smoke.push({ kind, x, y, z, ...opts }); },
    /** Additive light pool on the ground. r = radius, sx = elongation along the aim direction (ry). */
    pool(x, z, r, opts = {}) {
      const g = new THREE.PlaneGeometry(r * 2 * (opts.sx || 1), r * 2);
      g.rotateX(-Math.PI / 2);
      this.add(opts.key || 'pool', place(g, x, opts.y ?? 0.24, z, opts.ry || 0));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// site work
// ---------------------------------------------------------------------------------------------
/** Lawn over the whole lot, concrete kerb, terrace skirt / embankment for sloped sites. */
export function lot(P, w, d, extra = 10, opts = {}) {
  const W = w + extra, D = d + extra;
  P.add(opts.ground || 'lawn', place(box(W, 0.14, D, opts.ground ? 3 : 5), 0, -0.03, 0));
  // Mowing strip / kerb around the lot: wide enough not to alias into a dashed line at 100 m, and
  // capped below 0.12 m so it never pokes through an apron or path laid across the lot edge.
  const kw = 0.6, kh = 0.275;
  P.add('kerb', place(box(W + kw * 2, kh, kw, 2), 0, kh / 2 - 0.16, D / 2 + kw / 2));
  P.add('kerb', place(box(W + kw * 2, kh, kw, 2), 0, kh / 2 - 0.16, -D / 2 - kw / 2));
  P.add('kerb', place(box(kw, kh, D, 2), W / 2 + kw / 2, kh / 2 - 0.16, 0));
  P.add('kerb', place(box(kw, kh, D, 2), -W / 2 - kw / 2, kh / 2 - 0.16, 0));
  // terrace: a short retaining wall (≤ 1.5 m) and, for larger drops, a grass embankment
  const drop = Math.max(0, P.skirt || 0);
  if (drop > 0.25) {
    const wall = Math.min(drop, 1.5) + 0.2;
    P.add('concrete', place(box(W + kw * 2, wall, D + kw * 2, 4), 0, -0.16 - wall / 2 + 0.02, 0));
    if (drop > 1.5) {
      const top = -0.16 - wall + 0.02, bot = -drop - 0.4, spread = (drop - 1.5) * 1.4 + 1.5;
      const hx = W / 2 + kw, hz = D / 2 + kw, ox = hx + spread, oz = hz + spread;
      P.add('lawn', slope(-hx, hz, hx, hz, top, -ox, oz, ox, oz, bot));
      P.add('lawn', slope(hx, -hz, -hx, -hz, top, ox, -oz, -ox, -oz, bot));
      P.add('lawn', slope(hx, hz, hx, -hz, top, ox, oz, ox, -oz, bot));
      P.add('lawn', slope(-hx, -hz, -hx, hz, top, -ox, -oz, -ox, oz, bot));
    }
  }
}
/**
 * Landscaped corners: a bark planting bed with three clipped shrubs. Lot corners are the one part
 * of a civic site that is always free of aprons and driveways, so this is where a groundsman would
 * put the planting — it stops the site reading as a building dropped on a green rectangle.
 */
export function planting(P, x, z, rng, scale = 1) {
  P.add('gravel_dark', place(box(4.6 * scale, 0.1, 4.6 * scale, 2), x, 0.05, z));
  const spots = [[-1.0, -0.7, 1.05], [0.95, -0.95, 0.8], [-0.15, 1.05, 0.92]];
  for (const [ox, oz, sc] of spots) {
    const r = sc * scale * (0.82 + rng() * 0.4), hgt = r * (1.15 + rng() * 0.5);
    P.add('hedge', place(box(r * 1.7, hgt * 0.6, r * 1.7, 1), x + ox * scale, 0.06 + hgt * 0.3, z + oz * scale));
    P.add('hedge', place(box(r * 1.35, hgt * 0.36, r * 1.35, 1), x + ox * scale, 0.06 + hgt * 0.75, z + oz * scale));
  }
}

/** Four landscaped lot corners (skip any that a recipe uses for aprons). */
export function corners(P, w, d, extra, rng, skip = []) {
  const W = w + extra, D = d + extra;
  const at = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let i = 0; i < 4; i++) {
    if (skip.includes(i)) continue;
    planting(P, at[i][0] * (W / 2 - 3.0), at[i][1] * (D / 2 - 3.0), rng, 1);
  }
}

export function path(P, x, z, w, d, ry = 0) {
  P.add('paving', place(box(w, 0.12, d, 2), x, 0.08, z, ry));
}
export function apron(P, x, z, w, d, ry = 0, key = 'asphalt') {
  P.add(key, place(box(w, 0.12, d, 5), x, 0.07, z, ry));
}
/** Parking bays: n bays along local +x, cars nose to -z. Returns bay centres. */
export function parking(P, x, z, n, ry = 0, bayW = 2.8, bayD = 5.2, lines = true) {
  const w = n * bayW + 0.6;
  apron(P, x, z, w, bayD + 1.2, ry);
  const out = [];
  const c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i <= n; i++) {
    const lx = -w / 2 + 0.3 + i * bayW;
    if (lines) P.add('paint_white', place(box(0.12, 0.012, bayD - 0.6, 1), x + lx * c, 0.135, z - lx * s, ry));
    if (i < n) out.push({ x: x + (lx + bayW / 2) * c, z: z - (lx + bayW / 2) * s, yaw: ry });
  }
  return out;
}
export function fence(P, w, d, x = 0, z = 0, h = 2.1, postEvery = 6, gap = null) {
  const hw = w / 2, hd = d / 2;
  // front side (+z) may carry a gate opening: split it into two runs
  const fronts = gap ? [[x - hw, gap.x - gap.w / 2], [gap.x + gap.w / 2, x + hw]] : [[x - hw, x + hw]];
  for (const y of [h * 0.45, h * 0.9]) {
    for (const [a, b] of fronts) if (b - a > 0.2) P.add('dark_metal', place(box(b - a, 0.06, 0.06, 1), (a + b) / 2, y, z + hd));
    P.add('dark_metal', place(box(w, 0.06, 0.06, 1), x, y, z - hd));
    P.add('dark_metal', place(box(0.06, 0.06, d, 1), x + hw, y, z));
    P.add('dark_metal', place(box(0.06, 0.06, d, 1), x - hw, y, z));
  }
  // mesh panels (thin, dark, slightly translucent-looking via roughness)
  for (const [a, b] of fronts) if (b - a > 0.2) P.add('mesh', place(quad(b - a, h * 0.92), (a + b) / 2, h * 0.5, z + hd));
  P.add('mesh', place(quad(w, h * 0.92), x, h * 0.5, z - hd, Math.PI));
  if (gap) {
    // gate: heavier posts and a pair of sliding-gate leaves parked open
    for (const gx of [gap.x - gap.w / 2, gap.x + gap.w / 2]) P.add('paint_yellow', place(box(0.22, h + 0.3, 0.22, 1), gx, (h + 0.3) / 2, z + hd));
    P.add('dark_metal', place(box(gap.w * 0.45, 0.08, 0.08, 1), gap.x - gap.w / 2 - gap.w * 0.225 - 0.2, h * 0.92, z + hd + 0.3));
    P.add('mesh', place(quad(gap.w * 0.45, h * 0.85), gap.x - gap.w / 2 - gap.w * 0.225 - 0.2, h * 0.48, z + hd + 0.3));
  }
  P.add('mesh', place(quad(d, h * 0.92), x + hw, h * 0.5, z, Math.PI / 2));
  P.add('mesh', place(quad(d, h * 0.92), x - hw, h * 0.5, z, -Math.PI / 2));
  for (let i = -hw; i <= hw + 0.01; i += postEvery) {
    if (!gap || Math.abs(x + i - gap.x) > gap.w / 2 + 0.2) P.add('dark_metal', place(box(0.1, h, 0.1, 1), x + i, h / 2, z + hd));
    P.add('dark_metal', place(box(0.1, h, 0.1, 1), x + i, h / 2, z - hd));
  }
  for (let i = -hd + postEvery; i < hd; i += postEvery) { P.add('dark_metal', place(box(0.1, h, 0.1, 1), x + hw, h / 2, z + i)); P.add('dark_metal', place(box(0.1, h, 0.1, 1), x - hw, h / 2, z + i)); }
}
/** Street furniture: litter bin, bike rack (n hoops along local +x). */
export function bin(P, x, z) {
  P.add('dark_metal', place(cylinder(0.32, 0.3, 0.95, 1, 12), x, 0.5, z));
  P.add('paint_garbage', place(cylinder(0.34, 0.34, 0.12, 1, 12), x, 1.0, z));
  P.add('dark', place(cylinder(0.2, 0.2, 0.02, 1, 12), x, 1.07, z));
}
export function bikeRack(P, x, z, ry = 0, n = 3) {
  const c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * 0.9;
    const px = x + o * c, pz = z - o * s;
    for (const t of [-0.35, 0.35]) P.add('plates', place(cylinder(0.03, 0.03, 0.8, 1, 8), px - t * s, 0.4, pz - t * c));
    P.add('plates', place(box(0.06, 0.06, 0.76, 1), px, 0.8, pz, ry));
  }
}
/** Clipped hedge: three stacked slabs give the rounded, slightly tapered profile of a trimmed box. */
export function hedge(P, x, z, len, ry = 0, h = 1.0, t = 0.7) {
  P.add('hedge', place(box(len, h * 0.62, t, 1), x, h * 0.31 + 0.04, z, ry));
  P.add('hedge', place(box(len - 0.12, h * 0.28, t * 0.88, 1), x, h * 0.76 + 0.04, z, ry));
  P.add('hedge', place(box(len - 0.34, h * 0.14, t * 0.62, 1), x, h * 0.95 + 0.04, z, ry));
  P.add('dirt', place(box(len + 0.2, 0.1, t + 0.3, 2), x, 0.05, z, ry));
}
export function bollards(P, x0, z0, x1, z1, n = 4) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    P.add('dark_metal', place(cylinder(0.09, 0.1, 0.95, 1, 10), x, 0.5, z));
    P.add('paint_white', place(cylinder(0.095, 0.095, 0.08, 1, 10), x, 0.85, z));
  }
}
export function bench(P, x, z, ry = 0) {
  P.add('wood', place(box(1.8, 0.06, 0.42, 1), x, 0.46, z, ry));
  P.add('wood', place(box(1.8, 0.36, 0.05, 1), x - Math.sin(ry) * 0.2, 0.7, z - Math.cos(ry) * 0.2, ry));
  for (const s of [-0.75, 0.75]) P.add('dark_metal', place(box(0.06, 0.44, 0.4, 1), x + Math.cos(ry) * s, 0.22, z - Math.sin(ry) * s, ry));
}
export function lampPost(P, x, z, h = 5.5, ry = 0, poolR = 5.5) {
  P.add('dark_metal', place(cylinder(0.06, 0.1, h, 1, 10), x, h / 2, z));
  const ax = Math.sin(ry), az = Math.cos(ry);
  P.add('dark_metal', place(box(0.08, 0.08, 1.1, 1), x + ax * 0.55, h - 0.1, z + az * 0.55, ry));
  P.add('dark_metal', place(box(0.32, 0.14, 0.7, 1), x + ax * 1.0, h - 0.1, z + az * 1.0, ry));
  P.add('lamp', place(box(0.26, 0.03, 0.6, 1), x + ax * 1.0, h - 0.18, z + az * 1.0, ry));
  P.pool(x + ax * 1.2, z + az * 1.2, poolR);
}
export function floodlight(P, x, z, ry = 0, h = 9) {
  P.add('dark_metal', place(cylinder(0.09, 0.15, h, 1, 8), x, h / 2, z));
  P.add('dark_metal', place(box(1.4, 0.12, 0.12, 1), x, h - 0.2, z, ry));
  const ax = -Math.sin(ry), az = Math.cos(ry); // aim direction (local +z rotated)
  for (const s of [-0.45, 0.45]) {
    P.add('dark_metal', place(box(0.56, 0.34, 0.42, 1), x + Math.cos(ry) * s, h - 0.42, z - Math.sin(ry) * s, ry, 0.55));
    P.add('flood', place(quad(0.44, 0.26), x + Math.cos(ry) * s + ax * 0.22, h - 0.42 - 0.1, z - Math.sin(ry) * s + az * 0.22, ry, -0.55 + 0.0));
  }
  P.pool(x + ax * h * 0.75, z + az * h * 0.75, h * 0.9, { sx: 1.5, ry });
}
export function flag(P, x, z, h = 9) {
  P.add('plates', place(cylinder(0.05, 0.09, h, 1, 8), x, h / 2, z));
  P.add('dark_metal', place(new THREE.SphereGeometry(0.1, 8, 6).translate(x, h + 0.05, z), 0, 0, 0));
  const g = new THREE.PlaneGeometry(1.9, 1.15, 14, 6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) + 0.95) / 1.9;
    pos.setZ(i, Math.sin(u * 5.2) * 0.14 * u + Math.sin(u * 2.3 + 1) * 0.05 * u);
  }
  g.computeVertexNormals();
  P.add('flag', place(g, x + 1.0, h - 0.7, z + 0.02, Math.PI / 2));
}

// ---------------------------------------------------------------------------------------------
// architecture
// ---------------------------------------------------------------------------------------------
/** Recessed ribbon glazing around a block, pane-snapped so day panes == night panes. */
export function glassBand(P, w, bh, d, x, y, z, inset, rng, faces = {}) {
  const face = (len, cx, cz, ry) => {
    const L = len - inset * 2;
    const n = Math.max(1, Math.round(L / PANE_W));
    const k = rng.int(0, PANES - 1), r = rng.int(0, WINDOW_ROWS - 1);
    P.add('glass', place(quad(L, bh, k / PANES, (k + n) / PANES, r / WINDOW_ROWS, (r + 1) / WINDOW_ROWS), cx, y + bh / 2, cz, ry));
    // mullions standing proud of the glass give the band its reveal depth
    const c = Math.cos(ry), s = Math.sin(ry);
    for (let i = 1; i < n; i++) {
      const o = -L / 2 + i * (L / n);
      P.add('dark_metal', place(box(0.09, bh, 0.16, 1), cx + o * c, y + bh / 2, cz - o * s, ry));
    }
  };
  if (faces.front !== false) face(w, x, z + d / 2 - inset, 0);
  if (faces.back !== false) face(w, x, z - d / 2 + inset, Math.PI);
  if (faces.right !== false) face(d, x + w / 2 - inset, z, Math.PI / 2);
  if (faces.left !== false) face(d, x - w / 2 + inset, z, -Math.PI / 2);
  // dark interior so nothing is see-through at grazing angles
  P.add('dark', place(box(w - inset * 2 - 0.05, bh - 0.02, d - inset * 2 - 0.05, 4), x, y + bh / 2, z));
}
/**
 * Wall block sliced into solid courses and glazed bands. bands: [{ y, h?, faces? }].
 * opts: { scale (texture metres), inset, pier, trim, uOff }
 */
export function slicedWall(P, wallKey, w, h, d, x, z, bands, rng, opts = {}) {
  const scale = opts.scale ?? 2, inset = opts.inset ?? 0.28, pier = opts.pier ?? 0.6, trim = opts.trim || 'trim';
  const sorted = bands.slice().sort((a, b) => a.y - b.y);
  let y = 0;
  const wallBox = (y0, hh) => { if (hh > 0.01) P.add(wallKey, place(box(w, hh, d, scale, scale, opts.uOff || 0, y0 / scale), x, y0 + hh / 2, z)); };
  for (const b of sorted) {
    const bh = b.h ?? BAND_H;
    wallBox(y, b.y - y);
    glassBand(P, w, bh, d, x, b.y, z, inset, rng, b.faces || {});
    // solid corner piers keep the corners architectural (and kill corner slivers)
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      P.add(wallKey, place(box(pier, bh, pier, scale, scale, 0, b.y / scale), x + sx * (w / 2 - pier / 2), b.y + bh / 2, z + sz * (d / 2 - pier / 2)));
    }
    // faces without glazing get wall instead
    const f = b.faces || {};
    if (f.front === false) P.add(wallKey, place(box(w - pier * 2, bh, inset, scale, scale, 0, b.y / scale), x, b.y + bh / 2, z + d / 2 - inset / 2));
    if (f.back === false) P.add(wallKey, place(box(w - pier * 2, bh, inset, scale, scale, 0, b.y / scale), x, b.y + bh / 2, z - d / 2 + inset / 2));
    if (f.left === false) P.add(wallKey, place(box(inset, bh, d - pier * 2, scale, scale, 0, b.y / scale), x - w / 2 + inset / 2, b.y + bh / 2, z));
    if (f.right === false) P.add(wallKey, place(box(inset, bh, d - pier * 2, scale, scale, 0, b.y / scale), x + w / 2 - inset / 2, b.y + bh / 2, z));
    // sill & head trims (light precast) give the recess its shadow line
    P.add(trim, place(box(w + 0.18, 0.16, d + 0.18, 4), x, b.y - 0.08, z));
    P.add(trim, place(box(w + 0.18, 0.16, d + 0.18, 4), x, b.y + bh + 0.08, z));
    y = b.y + bh;
  }
  wallBox(y, h - y);
}
/** Plinth course at the base of a wall block. */
export function plinth(P, w, d, x = 0, z = 0, h = 0.9) {
  P.add('concrete', place(box(w + 0.26, h, d + 0.26, 4), x, h / 2, z));
}
export function roofDeck(P, w, h, d, x = 0, z = 0, parapet = 0.7) {
  P.add('membrane', place(box(w - 0.6, 0.22, d - 0.6, 2), x, h + 0.09, z));
  P.add('gravel', place(box(w - 0.6, 0.02, 0.9, 2), x, h + 0.21, z + d / 2 - 0.75)); // ballast strip at the parapet
  P.add('gravel', place(box(w - 0.6, 0.02, 0.9, 2), x, h + 0.21, z - d / 2 + 0.75));
  const t = 0.3;
  P.add('concrete', place(box(w, parapet, t, 4), x, h + parapet / 2, z + d / 2 - t / 2));
  P.add('concrete', place(box(w, parapet, t, 4), x, h + parapet / 2, z - d / 2 + t / 2));
  P.add('concrete', place(box(t, parapet, d, 4), x + w / 2 - t / 2, h + parapet / 2, z));
  P.add('concrete', place(box(t, parapet, d, 4), x - w / 2 + t / 2, h + parapet / 2, z));
  // metal coping
  P.add('plates', place(box(w + 0.1, 0.07, t + 0.14, 1), x, h + parapet + 0.03, z + d / 2 - t / 2));
  P.add('plates', place(box(w + 0.1, 0.07, t + 0.14, 1), x, h + parapet + 0.03, z - d / 2 + t / 2));
  P.add('plates', place(box(t + 0.14, 0.07, d + 0.1, 1), x + w / 2 - t / 2, h + parapet + 0.03, z));
  P.add('plates', place(box(t + 0.14, 0.07, d + 0.1, 1), x - w / 2 + t / 2, h + parapet + 0.03, z));
  // roof access hatch
  P.add('plates', place(box(1.6, 0.9, 1.2, 1), x - w / 2 + 2.2, h + 0.55, z - d / 2 + 2.0));
}
export function hvac(P, x, y, z, rng, n = 3) {
  for (let i = 0; i < n; i++) {
    const w = rng.range(1.8, 3.0), h = rng.range(1.2, 1.9), d = rng.range(1.5, 2.4);
    const cx = x + i * 3.6 - (n - 1) * 1.8, cz = z + rng.range(-0.8, 0.8);
    P.add('plates', place(box(w, h, d, 1), cx, y + h / 2 + 0.2, cz));
    P.add('dark_metal', place(box(w + 0.1, 0.2, d + 0.1, 1), cx, y + 0.1, cz)); // base rail
    P.add('louvre', place(quad(d - 0.3, h - 0.4, 0, (d - 0.3) / 1, 0, (h - 0.4) / 1), cx + w / 2 + 0.01, y + h / 2 + 0.2, cz, Math.PI / 2));
    P.add('louvre', place(quad(d - 0.3, h - 0.4, 0, (d - 0.3) / 1, 0, (h - 0.4) / 1), cx - w / 2 - 0.01, y + h / 2 + 0.2, cz, -Math.PI / 2));
    // fan on top
    P.add('plates', place(cylinder(0.55, 0.55, 0.16, 1, 16), cx, y + h + 0.28, cz));
    P.add('dark', place(cylinder(0.46, 0.46, 0.06, 1, 16), cx, y + h + 0.4, cz));
    // duct to the parapet
    if (i === 0) P.add('plates', place(box(0.5, 0.5, 2.6, 1), cx - w / 2 - 1.3, y + 0.45, cz));
  }
}
/** Street fire hydrant: barrel, bonnet, two side ports and a chain — reads from ~40 m. */
export function hydrant(P, x, z, ry = 0) {
  P.add('concrete', place(box(0.62, 0.1, 0.62, 1), x, 0.05, z));
  P.add('paint_fire', place(cylinder(0.115, 0.145, 0.62, 1, 12), x, 0.36, z, ry));
  P.add('paint_fire', place(cylinder(0.17, 0.17, 0.09, 1, 12), x, 0.71, z, ry));
  P.add('paint_fire', place(cylinder(0.09, 0.13, 0.16, 1, 10), x, 0.81, z, ry));
  P.add('paint_yellow', place(cylinder(0.055, 0.055, 0.1, 1, 8), x, 0.9, z, ry));
  const c = Math.cos(ry), sn = Math.sin(ry);
  for (const sd of [-1, 1]) {
    const g = cylinder(0.075, 0.075, 0.2, 1, 10).rotateZ(Math.PI / 2);
    P.add('paint_fire', place(g, x + sd * 0.16 * c, 0.5, z - sd * 0.16 * sn, ry));
  }
}

/**
 * Roof plant: a stair/lift penthouse with a door, vent pipes, a dish and a drain outlet —
 * the silhouette detail that separates a modelled roof from a flat lid.
 */
export function roofKit(P, x, y, z, rng, opts = {}) {
  const pw = opts.pw || 3.2, pd = opts.pd || 2.6, ph = opts.ph || 2.7;
  P.add('concrete_white', place(box(pw, ph, pd, 2), x, y + ph / 2, z));
  P.add('membrane', place(box(pw + 0.24, 0.16, pd + 0.24, 1), x, y + ph + 0.08, z));
  P.add('dark_metal', place(quad(0.95, 2.05), x, y + 1.05, z + pd / 2 + 0.015));
  P.add('plates', place(box(0.7, 0.35, 0.5, 1), x + pw / 2 - 0.55, y + ph + 0.3, z)); // vent cowl
  // vent pipes
  for (let i = 0; i < 3; i++) {
    const px = x - pw / 2 - 1.1 - i * 0.75, hgt = 0.9 + rng.range(0, 0.7);
    P.add('plates', place(cylinder(0.09, 0.09, hgt, 1, 8), px, y + hgt / 2, z + rng.range(-1.2, 1.2)));
  }
  // satellite dish on a short mast
  if (opts.dish !== false) {
    const dx = x + pw / 2 + 1.9, dz = z - 1.1;
    P.add('dark_metal', place(cylinder(0.07, 0.07, 1.3, 1, 8), dx, y + 0.65, dz));
    P.add('white', place(cylinder(0.62, 0.05, 0.24, 1, 16).rotateX(-1.0), dx, y + 1.42, dz));
  }
  // roof drain outlet + ponding stain
  P.add('dark_metal', place(cylinder(0.22, 0.22, 0.1, 1, 10), x - pw / 2 - 2.6, y + 0.05, z + 1.9));
}

export function canopy(P, key, x, y, z, w, depth, opts = {}) {
  const t = 0.22;
  P.add(key, place(box(w, t, depth, 2), x, y, z + depth / 2));
  const fh = 0.42;
  P.add(key, place(box(w, fh, 0.14, 2), x, y, z + depth - 0.07));
  P.add(key, place(box(0.14, fh, depth, 2), x + w / 2 - 0.07, y, z + depth / 2));
  P.add(key, place(box(0.14, fh, depth, 2), x - w / 2 + 0.07, y, z + depth / 2));
  if (opts.posts !== false) {
    P.add('dark_metal', place(cylinder(0.11, 0.11, y, 1, 10), x - w / 2 + 0.6, y / 2, z + depth - 0.6));
    P.add('dark_metal', place(cylinder(0.11, 0.11, y, 1, 10), x + w / 2 - 0.6, y / 2, z + depth - 0.6));
  }
  // recessed downlights + pools
  for (const s of [-0.28, 0.28]) {
    P.add('lamp', place(box(0.36, 0.03, 0.36, 1), x + w * s, y - t / 2 - 0.01, z + depth * 0.55));
    P.pool(x + w * s, z + depth * 0.6, 4.2);
  }
}
export function signBoard(P, signKey, x, y, z, w, h, ry = 0) {
  const back = box(w + 0.12, h + 0.12, 0.14, 2); back.translate(0, 0, -0.08);
  const face = quad(w, h); face.translate(0, 0, 0.005);
  P.add('dark_metal', place(back, x, y, z, ry));
  P.add(signKey, place(face, x, y, z, ry));
}
export function rollerDoor(P, x, y0, z, w, h, ry = 0) {
  const door = quad(w, h, 0, w / 1, 0, h / 1);
  P.add('roller', place(door, x, y0 + h / 2, z, ry));
  const c = Math.cos(ry), s = Math.sin(ry);
  P.add('dark_metal', place(box(0.2, h + 0.2, 0.3, 1), x - (w / 2 + 0.1) * c, y0 + h / 2 + 0.1, z + (w / 2 + 0.1) * s, ry));
  P.add('dark_metal', place(box(0.2, h + 0.2, 0.3, 1), x + (w / 2 + 0.1) * c, y0 + h / 2 + 0.1, z - (w / 2 + 0.1) * s, ry));
  P.add('dark_metal', place(box(w + 0.4, 0.3, 0.3, 1), x, y0 + h + 0.15, z, ry));
}
export function door(P, x, y0, z, w = 1.9, h = 2.4, ry = 0) {
  P.add('dark_metal', place(box(w, h, 0.12, 2), x, y0 + h / 2, z, ry));
  P.add('paint_white', place(box(0.05, h * 0.8, 0.13, 1), x, y0 + h / 2, z, ry));
  P.add('dark_metal', place(box(w + 0.3, 0.2, 0.2, 1), x, y0 + h + 0.1, z, ry));
}
export function downpipes(P, w, h, d, x = 0, z = 0) {
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const px = x + sx * (w / 2 - 0.5), pz = z + sz * (d / 2 + 0.09);
    P.add('dark_metal', place(cylinder(0.065, 0.065, h - 0.4, 1, 8), px, (h - 0.4) / 2, pz));
    P.add('dark_metal', place(box(0.14, 0.14, 0.3, 1), px, h - 0.5, pz - sz * 0.1));
    P.add('streak', place(quad(0.7, h * 0.5, 0, 1, 0, 1), px + 0.05, h * 0.32, z + sz * (d / 2 + 0.015), sz > 0 ? 0 : Math.PI));
    P.add('streak', place(quad(1.3, 0.5, 0, 1, 0, 1), px, 0.42, z + sz * (d / 2 + 0.015), sz > 0 ? 0 : Math.PI));
  }
}
export function doorLamp(P, x, y, z, ry = 0) {
  P.add('dark_metal', place(box(0.5, 0.12, 0.3, 1), x, y, z, ry));
  P.add('lamp', place(box(0.42, 0.03, 0.24, 1), x, y - 0.07, z, ry));
  P.pool(x + Math.sin(ry) * 1.6, z + Math.cos(ry) * 1.6, 3.6);
}
export function antenna(P, x, y, z, h = 7) {
  P.add('plates', place(cylinder(0.06, 0.12, h, 1, 8), x, y + h / 2, z));
  for (const yy of [0.35, 0.7]) P.add('dark_metal', place(box(0.9, 0.04, 0.04, 1), x, y + h * yy, z));
  P.add('warning', place(new THREE.SphereGeometry(0.2, 8, 6).translate(x, y + h + 0.15, z), 0, 0, 0));
}

// ---------------------------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------------------------
export const RECIPES = {
  police(P, def, rng) {
    const { w, d, height: h } = def;
    lot(P, w, d, 14);
    const D = d + 14;
    const bz = -1;
    plinth(P, w, d, 0, bz, 0.9);
    slicedWall(P, 'brick_buff', w, h - 0.7, d, 0, bz, [{ y: 1.2 }, { y: 1.2 + FLOOR + 0.5 }], rng, { scale: 1.6 });
    roofDeck(P, w, h - 0.7, d, 0, bz);
    hvac(P, -4, h - 0.7 + 0.2, bz - 3, rng, 3);
    downpipes(P, w, h - 0.7, d, 0, bz);
    antenna(P, w / 2 - 2.2, h - 0.7 + 0.7, bz - d / 2 + 2.2, 7);
    // entrance: glazed lobby, canopy, sign
    const fz = bz + d / 2;
    P.add('glass', place(quad(6, 3.0, 0, 4 / PANES, 0, 1 / WINDOW_ROWS), 0, 1.5 + 0.02, fz + 0.02));
    door(P, 0, 0.02, fz + 0.09, 2.0, 2.4);
    canopy(P, 'paint_police', 0, 3.7, fz, 8.5, 3.4);
    signBoard(P, 'sign_police', 0, h - 0.7 - 1.35, fz + 0.09, 7.5, 1.15);
    doorLamp(P, -3.9, 3.3, fz + 0.2); doorLamp(P, 3.9, 3.3, fz + 0.2);
    // front path, hedges, seating, flag
    path(P, 0, fz + (d / 2 + 6 - fz) / 2 + 1, 4.2, d / 2 + 6 - fz + 2);
    hedge(P, -8, fz + 3.5, 10.5, 0); hedge(P, 8, fz + 3.5, 10.5, 0);
    bench(P, -4.6, fz + 6.2, Math.PI); bench(P, 4.6, fz + 6.2, Math.PI);
    bollards(P, -3.2, fz + 1.6, 3.2, fz + 1.6, 4);
    flag(P, -w / 2 - 3, fz + 3);
    lampPost(P, -w / 2 - 4.5, fz + 8, 5.5, Math.PI / 2); lampPost(P, w / 2 + 4.5, fz + 8, 5.5, -Math.PI / 2);
    bin(P, -2.9, fz + 6.6); bin(P, 2.9, fz + 6.6);
    bikeRack(P, -7.5, fz + 1.2, 0, 4);
    corners(P, w, d, 12, rng, [1, 3]);   // east corners carry the side lane
    // patrol-car yard at the back, reached by the side lane; both open onto the streets
    const bays = parking(P, 0, bz - d / 2 - 4.4, 6, 0);
    P.vehicle('police', bays[1].x, bays[1].z + 0.1, Math.PI);
    P.vehicle('police', bays[2].x, bays[2].z + 0.1, Math.PI);
    P.vehicle('police', bays[4].x, bays[4].z + 0.1, Math.PI);
    P.vehicle('sedan', bays[5].x, bays[5].z + 0.1, Math.PI);
    lampPost(P, -w / 2 - 2, bz - d / 2 - 4, 6, Math.PI / 2, 7);
    apron(P, w / 2 + 4.2, 0, 5.6, D); // side access lane, kerb to kerb
    P.drive(w / 2 + 4.2, D / 2, 5.6);
    P.drive(w / 2 + 4.2, -D / 2, 5.6, 0, -1);
    bin(P, w / 2 + 1.3, bz - d / 2 - 1.5);
  },

  fire(P, def, rng) {
    const { w, d, height: h } = def;
    lot(P, w, d, 12);
    const bz = -2;
    plinth(P, w, d, 0, bz, 0.7);
    slicedWall(P, 'brick_red', w, h - 0.7, d, 0, bz, [{ y: 1.4, faces: { front: false } }, { y: 1.4 + FLOOR + 0.6 }], rng, { scale: 1.6 });
    roofDeck(P, w, h - 0.7, d, 0, bz);
    hvac(P, 5, h - 0.7 + 0.2, bz - 4, rng, 2);
    roofKit(P, -3.5, h - 0.7 + 0.2, bz - 4.5, rng, { pw: 3.0, pd: 2.4 });
    downpipes(P, w, h - 0.7, d, 0, bz);
    const fz = bz + d / 2;
    // three apparatus bays
    for (let i = -1; i <= 1; i++) rollerDoor(P, i * 7.2, 0.02, fz + 0.03, 5.0, 4.3);
    for (let i = -1; i <= 1; i++) doorLamp(P, i * 7.2, 5.15, fz + 0.2);
    signBoard(P, 'sign_fire', 0, h - 0.7 - 1.35, fz + 0.09, 10, 1.15);
    // hose tower at the back-left corner
    const tw = 5, th = h + 7.5, tx = -w / 2 + 3, tz = bz - d / 2 + 3;
    P.add('brick_red', place(box(tw, th, tw, 1.6), tx, th / 2, tz));
    roofDeck(P, tw, th, tw, tx, tz, 0.5);
    P.add('glass', place(quad(1.4, 3.2, 0, 1 / PANES, 0, 1 / WINDOW_ROWS), tx, th - 2.6, tz + tw / 2 + 0.02));
    P.add('glass', place(quad(1.4, 3.2, 3 / PANES, 4 / PANES, 0, 1 / WINDOW_ROWS), tx - tw / 2 - 0.02, th - 2.6, tz, -Math.PI / 2));
    P.add('warning', place(new THREE.SphereGeometry(0.26, 8, 6).translate(tx, th + 0.9, tz), 0, 0, 0));
    // apron with engines (nose to the street), driveway to the road
    const D = d + 12;
    apron(P, 0, fz + 5, w + 8, 10);
    for (let i = -1; i <= 1; i++) P.add('paint_yellow', place(box(0.14, 0.012, 9.6, 1), i * 7.2 + 3.6, 0.135, fz + 5));
    P.vehicle('firetruck', -7.2, fz + 5.2, 0);
    P.vehicle('firetruck', 0.2, fz + 4.6, 0);
    P.drive(0, fz + 10, 24);
    // staff parking down the side, out of the way of the engines
    apron(P, w / 2 + 4.6, (bz - 6 + fz + 10) / 2, 5.6, fz + 16 - bz);
    P.vehicle('sedan', w / 2 + 4.6, bz - 3, 0);
    P.vehicle('suv', w / 2 + 4.6, bz + 3.4, 0);
    hedge(P, -w / 2 - 3.5, bz, d - 4, Math.PI / 2); hedge(P, w / 2 + 8.4, bz - 2, d - 8, Math.PI / 2);
    hedge(P, -w / 2 - 5.2, fz + 3.0, 8, Math.PI / 2);        // planting strip beside the apron
    hedge(P, 4, bz - d / 2 - 4.2, 16, 0);                     // rear boundary planting
    corners(P, w, d, 12, rng, [1, 3]);                        // east corners carry the staff park
    hydrant(P, -w / 2 - 4.0, fz + 8.4);
    flag(P, -w / 2 - 3.5, fz + 3.5);
    lampPost(P, -w / 2 - 4.6, fz + 8.5, 6, Math.PI / 2, 7); lampPost(P, w / 2 + 8.6, fz + 8.5, 6, -Math.PI / 2, 7);
    bench(P, -w / 2 - 4.5, fz + 2.2, Math.PI);
    bin(P, -w / 2 - 6.5, fz + 2.2);
    door(P, w / 2 - 2.6, 0.02, fz + 0.09, 1.2, 2.3);
    void D;
  },

  health(P, def, rng) {
    const { w, d, height: h } = def;
    lot(P, w, d, 12);
    const bz = -1.5;
    plinth(P, w, d, 0, bz, 0.8);
    const bands = [];
    for (let f = 0; f < 4; f++) bands.push({ y: 0.9 + f * FLOOR, h: f === 0 ? 2.4 : BAND_H });
    slicedWall(P, 'concrete_white', w, h - 0.4, d, 0, bz, bands, rng, { scale: 4, inset: 0.32, pier: 0.7 });
    roofDeck(P, w, h - 0.4, d, 0, bz);
    downpipes(P, w, h - 0.4, d, 0, bz);
    const fz = bz + d / 2, top = h - 0.4;
    // shading fins on the street facade
    for (let x = -w / 2 + 3; x < w / 2 - 1; x += 6) P.add('trim', place(box(0.28, top - 1.4, 0.55, 2), x, top / 2 + 0.5, fz + 0.28));
    // entrance
    P.add('glass', place(quad(9, 3.2, 0, 6 / PANES, 0, 1 / WINDOW_ROWS), 0, 1.62, fz + 0.03));
    door(P, -1.1, 0.02, fz + 0.1, 1.6, 2.5); door(P, 1.1, 0.02, fz + 0.1, 1.6, 2.5);
    canopy(P, 'trim', 0, 3.9, fz, 11, 4.4);
    corners(P, w, d, 12, rng, [2, 3]);   // street corners carry the ambulance bay
    signBoard(P, 'sign_health', 0, top - 1.5, fz + 0.1, 9, 1.3);
    signBoard(P, 'sign_emergency', w / 2 + 0.1, 4.6, bz + 2, 6.5, 0.9, Math.PI / 2);
    // ambulance bay on the right side, straight out to the side street
    apron(P, w / 2 + 6.5, bz + 1, 9, 16);
    P.vehicle('ambulance', w / 2 + 4.6, bz - 1.5, Math.PI / 2);
    P.vehicle('ambulance', w / 2 + 4.6, bz + 4.5, Math.PI / 2);
    rollerDoor(P, w / 2 + 0.03, 0.02, bz - 1, 3.6, 3.4, Math.PI / 2);
    P.drive(w / 2 + 11, bz + 1, 12, 1, 0);
    // visitor parking at the back with its own exit
    const bays = parking(P, -4, bz - d / 2 - 5.4, 7, 0);
    P.vehicle('sedan', bays[0].x, bays[0].z, Math.PI); P.vehicle('suv', bays[2].x, bays[2].z, Math.PI);
    P.vehicle('sedan', bays[3].x, bays[3].z, Math.PI); P.vehicle('van', bays[6].x, bays[6].z, Math.PI);
    apron(P, 9.5, bz - d / 2 - 5.4, 6, 6.4);
    P.drive(9.5, bz - d / 2 - 8.6, 6, 0, -1);
    // landscaping
    path(P, 0, fz + 4.7, 6, d / 2 + 6 - fz + 3);
    hedge(P, -11, fz + 2.6, 12, 0); hedge(P, 11, fz + 2.6, 8, 0);
    bench(P, -5.5, fz + 6.5, Math.PI); bench(P, 5.5, fz + 6.5, Math.PI);
    bin(P, -4.2, fz + 8.2); bin(P, 4.2, fz + 8.2);
    bikeRack(P, -8.5, fz + 5.2, Math.PI / 2, 4);
    bollards(P, -4.2, fz + 1.6, 4.2, fz + 1.6, 5);
    lampPost(P, -w / 2 - 4.5, fz + 7, 5.5, Math.PI / 2); lampPost(P, -w / 2 - 4.5, bz - d / 2 - 2, 6, Math.PI / 2, 7);
    flag(P, -w / 2 - 2.5, fz + 3);
    // roof: helipad + plant
    P.add('dark', place(cylinder(5.2, 5.2, 0.18, 2, 36), w / 4 - 1, top + 0.3, bz));
    P.add('paint_white', place(new THREE.RingGeometry(4.4, 4.9, 36).rotateX(-Math.PI / 2).translate(w / 4 - 1, top + 0.41, bz), 0, 0, 0));
    P.add('paint_white', place(box(0.5, 0.02, 3.2, 1), w / 4 - 2.2, top + 0.41, bz));
    P.add('paint_white', place(box(0.5, 0.02, 3.2, 1), w / 4 + 0.2, top + 0.41, bz));
    P.add('paint_white', place(box(2.0, 0.02, 0.5, 1), w / 4 - 1, top + 0.41, bz));
    hvac(P, -w / 4, top + 0.2, bz + 2, rng, 3);
    P.smokeSource('steam', -w / 4, top + 2.2, bz + 2, { scale: 0.45, density: 0.3, opacity: 0.25 });
  },

  education(P, def, rng) {
    const { w, d, height: h } = def;
    lot(P, w, d, 12);
    // brick classroom wing along the back
    const aw = w, ad = 14, az = -7;
    plinth(P, aw, ad, 0, az, 0.7);
    slicedWall(P, 'brick', aw, h - 0.3, ad, 0, az, [{ y: 1.2 }, { y: 1.2 + FLOOR + 0.5 }], rng, { scale: 1.6 });
    roofDeck(P, aw, h - 0.3, ad, 0, az);
    hvac(P, -8, h - 0.3 + 0.2, az, rng, 3);
    downpipes(P, aw, h - 0.3, ad, 0, az);
    // concrete gym / hall wing on the right, in front
    const bw = 16, bd = 14, bx = w / 2 - bw / 2, bz = 7, bh = h - 1.1;
    plinth(P, bw, bd, bx, bz, 0.7);
    slicedWall(P, 'concrete_white', bw, bh, bd, bx, bz, [{ y: 1.2, faces: { back: false } }, { y: 1.2 + FLOOR + 0.5, faces: { back: false } }], rng, { scale: 4 });
    roofDeck(P, bw, bh, bd, bx, bz, 0.5);
    downpipes(P, bw, bh, bd, bx, bz);
    // entrance between the wings
    const ex = 2, ez = az + ad / 2;
    P.add('glass', place(quad(6, 3.0, 0, 4 / PANES, 0, 1 / WINDOW_ROWS), ex, 1.52, ez + 0.03));
    door(P, ex, 0.02, ez + 0.1, 2.0, 2.5);
    canopy(P, 'paint_education', ex, 3.5, ez, 8, 3.2);
    signBoard(P, 'sign_education', -6, h - 0.3 - 1.25, ez + 0.09, 12, 1.1);
    doorLamp(P, ex - 3.6, 3.1, ez + 0.2); doorLamp(P, ex + 3.6, 3.1, ez + 0.2);
    // playground: sports court on the left
    const cx = -w / 2 + 12, cz = 8;
    apron(P, cx, cz, 22, 13, 0, 'court');
    for (const [x, z, ww, dd] of [[cx, cz + 6.3, 22, 0.12], [cx, cz - 6.3, 22, 0.12], [cx - 10.9, cz, 0.12, 12.6], [cx + 10.9, cz, 0.12, 12.6], [cx, cz, 0.12, 12.6]]) P.add('paint_white', place(box(ww, 0.012, dd, 1), x, 0.135, z));
    P.add('paint_white', place(new THREE.RingGeometry(1.7, 1.82, 32).rotateX(-Math.PI / 2).translate(cx, 0.135, cz), 0, 0, 0));
    for (const s of [-1, 1]) {
      P.add('dark_metal', place(cylinder(0.08, 0.1, 3.6, 1, 8), cx + s * 10.2, 1.8, cz));
      P.add('paint_white', place(box(0.06, 1.05, 1.8, 1), cx + s * 9.7, 3.2, cz));
      P.add('dark_metal', place(new THREE.TorusGeometry(0.23, 0.02, 6, 16).rotateX(Math.PI / 2).translate(cx + s * 9.2, 2.85, cz), 0, 0, 0));
    }
    fence(P, 23.5, 14.5, cx, cz, 2.6, 5.8);
    // paths, drop-off, landscaping
    path(P, ex, ez + 5.5, 5, 11);
    path(P, -w / 2 + 12, ez + 9.5, 26, 2.4);
    // drop-off loop: in at one end, out at the other
    apron(P, 0, d / 2 + 4.2, w + 4, 5.2);
    for (let x = -w / 2 + 6; x < w / 2 - 4; x += 6) P.add('paint_yellow', place(box(3.2, 0.012, 0.14, 1), x, 0.135, d / 2 + 1.75));
    P.vehicle('van', -9, d / 2 + 4.4, Math.PI / 2); P.vehicle('sedan', 9, d / 2 + 4.4, -Math.PI / 2);
    P.drive(-w / 2 + 3.5, d / 2 + 6.8, 6.5);
    P.drive(w / 2 - 3.5, d / 2 + 6.8, 6.5);
    hedge(P, -w / 2 - 4.5, -2, d - 4, Math.PI / 2);
    hedge(P, 12, ez + 3, 7, 0);
    bench(P, ex - 4.5, ez + 3.2, 0); bench(P, ex + 5.0, ez + 3.2, 0);
    bikeRack(P, ex + 9.5, ez + 1.6, 0, 5);
    corners(P, w, d, 12, rng, [2, 3]);   // street corners carry the drop-off loop
    bin(P, ex - 3.4, ez + 4.6); bin(P, ex + 7.4, ez + 4.6);
    bollards(P, ex - 3, ez + 1.4, ex + 3, ez + 1.4, 4);
    flag(P, w / 2 + 3, 2);
    lampPost(P, -w / 2 - 4.5, d / 2 + 2, 5.5, Math.PI / 2); lampPost(P, w / 2 + 4.5, d / 2 + 2, 5.5, -Math.PI / 2);
    lampPost(P, cx - 12.5, cz - 8, 6, 0.4, 7);
  },

  water(P, def, rng) {
    const { w, d } = def;
    lot(P, w, d, 8);
    P.add('gravel', place(box(w + 2, 0.1, d + 2, 2), 0, 0.05, 0)); // service yard
    // pump house
    const pw = 8, ph = 4.4, pd = 5.6, px = 4.5, pz = 5;
    plinth(P, pw, pd, px, pz, 0.5);
    slicedWall(P, 'concrete', pw, ph, pd, px, pz, [{ y: 1.6, h: 1.4, faces: { front: false } }], rng, { scale: 4, pier: 0.5 });
    roofDeck(P, pw, ph, pd, px, pz, 0.4);
    rollerDoor(P, px + 1.2, 0.02, pz + pd / 2 + 0.03, 3.0, 3.0);
    door(P, px - 2.6, 0.02, pz + pd / 2 + 0.08, 1.1, 2.3);
    doorLamp(P, px - 2.6, 2.9, pz + pd / 2 + 0.2);
    P.add('plates', place(box(1.2, 0.9, 0.8, 1), px - 3.2, ph + 0.45, pz - 1.5));
    // tower legs (splayed) + bracing
    const legH = 18, spread = 4.6, top = 3.4;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const g = cylinder(0.32, 0.36, legH + 0.4, 1, 10);
      const dx = (sx * (spread - top)) / legH, dz = (sz * (spread - top)) / legH;
      const ang = Math.atan(Math.hypot(dx, dz)), yaw = Math.atan2(dx, dz);
      const rot = new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(ang, 0, 0)));
      g.applyMatrix4(rot);
      g.translate(sx * (spread + top) / 2, legH / 2, sz * (spread + top) / 2);
      P.add('plates', g);
      P.add('concrete', place(box(1.4, 0.6, 1.4, 2), sx * spread, 0.3, sz * spread)); // footing
    }
    for (const y of [6, 12]) {
      const s = spread - (spread - top) * (y / legH);
      P.add('plates', place(box(s * 2, 0.16, 0.16, 1), 0, y, s));
      P.add('plates', place(box(s * 2, 0.16, 0.16, 1), 0, y, -s));
      P.add('plates', place(box(0.16, 0.16, s * 2, 1), s, y, 0));
      P.add('plates', place(box(0.16, 0.16, s * 2, 1), -s, y, 0));
      // diagonal braces
      for (const [sx, sz] of [[1, 1], [-1, -1]]) P.add('plates', place(box(0.1, 0.1, s * 2.8, 1), sx * s, y - 3, sz * 0, 0, 0.72 * sx * sz, 0));
    }
    P.add('plates', place(cylinder(0.5, 0.5, legH, 1, 12), 0, legH / 2, 0)); // riser
    // ladder cage
    P.add('dark_metal', place(box(0.5, legH + 5, 0.06, 1), 0.8, (legH + 5) / 2, 0.55));
    // tank
    const tr = 6.6, th = 6.2, ty = legH;
    P.add('paint_water', place(cylinder(tr, tr, th, 3, 48), 0, ty + th / 2, 0));
    P.add('paint_water', place(new THREE.ConeGeometry(tr, 3.4, 48, 1, true).rotateX(Math.PI).translate(0, ty - 1.7, 0), 0, 0, 0));
    P.add('paint_water', place(new THREE.ConeGeometry(tr + 0.25, 2.8, 48).translate(0, ty + th + 1.4, 0), 0, 0, 0));
    for (const yy of [ty + 0.6, ty + th / 2, ty + th - 0.5]) P.add('plates', place(cylinder(tr + 0.1, tr + 0.1, 0.3, 1, 48), 0, yy, 0));
    // catwalk
    P.add('plates', place(cylinder(tr + 1.0, tr + 1.0, 0.12, 1, 48, true), 0, ty + 0.2, 0));
    P.add('plates', place(new THREE.RingGeometry(tr, tr + 1.0, 48).rotateX(-Math.PI / 2).translate(0, ty + 0.26, 0), 0, 0, 0));
    P.add('dark_metal', place(cylinder(tr + 1.0, tr + 1.0, 1.1, 1, 48, true), 0, ty + 0.8, 0));
    signBoard(P, 'sign_water', 0, ty + th / 2, tr + 0.02, 6.4, 1.5);
    P.add('warning', place(new THREE.SphereGeometry(0.35, 10, 8).translate(0, ty + th + 3.1, 0), 0, 0, 0));
    // yard: van, fence, lamp
    P.vehicle('van', -5, 7, 0.2);
    fence(P, w + 6, d + 6, 0, 0, 2.0, 6, { x: 0, w: 7 });
    lampPost(P, -w / 2 - 1.5, d / 2 + 1.5, 6, 0.8, 7);
    floodlight(P, w / 2 + 1.5, -d / 2 - 1.5, Math.PI * 0.75, 8);
    apron(P, 0, d / 2 + 4, 6, 8);
    P.drive(0, d / 2 + 8, 6);
  },

  sewage(P, def, rng) {
    const { w, d } = def;
    lot(P, w, d, 8);
    apron(P, 0, 0, w, d);
    // clarifier tanks with lowered water and rotating scraper bridges
    const tanks = [[-13, -8, 8.4], [5, -8, 8.4], [-13, 10, 7.2]];
    for (const [x, z, r] of tanks) {
      P.add('concrete', place(cylinder(r, r, 3.4, 4, 48), x, 1.7, z));
      P.add('concrete', place(cylinder(r + 0.32, r + 0.32, 0.3, 4, 48), x, 3.4, z));
      P.add('sludge', place(cylinder(r - 0.4, r - 0.4, 0.08, 4, 48), x, 2.72, z));
      P.add('plates', place(cylinder(0.35, 0.35, 3.6, 1, 12), x, 3.3, z)); // centre pier
      P.add('plates', place(cylinder(0.9, 0.9, 0.5, 1, 16), x, 3.85, z)); // drive
      const a = rng.range(0, Math.PI);
      P.add('plates', place(box(r + 0.6, 0.22, 1.1, 1), x + Math.cos(a) * (r + 0.6) / 2, 3.75, z - Math.sin(a) * (r + 0.6) / 2, a)); // half bridge
      P.add('dark_metal', place(box(r + 0.6, 0.05, 0.05, 1), x + Math.cos(a) * (r + 0.6) / 2, 4.75, z - Math.sin(a) * (r + 0.6) / 2 + 0.5, a));
      P.add('dark_metal', place(box(r + 0.6, 0.05, 0.05, 1), x + Math.cos(a) * (r + 0.6) / 2, 4.75, z - Math.sin(a) * (r + 0.6) / 2 - 0.5, a));
      for (let i = 0; i < 4; i++) P.add('dark_metal', place(box(0.05, 1.0, 0.05, 1), x + Math.cos(a) * (i + 0.5) * (r / 4), 4.3, z - Math.sin(a) * (i + 0.5) * (r / 4)));
      P.add('sludge', place(box(r - 0.6, 0.06, 0.3, 1), x + Math.cos(a + 0.35) * (r - 0.6) / 2, 2.78, z - Math.sin(a + 0.35) * (r - 0.6) / 2, a + 0.35)); // scum arm wake
      // handrail around the rim
      P.add('dark_metal', place(cylinder(r + 0.3, r + 0.3, 0.05, 1, 48, true), x, 4.4, z));
    }
    // control building
    const bw = 14, bh = 6.6, bd = 10, bx = 13, bz = 10;
    plinth(P, bw, bd, bx, bz, 0.6);
    slicedWall(P, 'concrete', bw, bh, bd, bx, bz, [{ y: 3.2 }], rng, { scale: 4 });
    roofDeck(P, bw, bh, bd, bx, bz, 0.5);
    hvac(P, bx, bh + 0.2, bz, rng, 2);
    downpipes(P, bw, bh, bd, bx, bz);
    rollerDoor(P, bx + 3.5, 0.02, bz + bd / 2 + 0.03, 3.4, 2.6);
    door(P, bx - 4, 0.02, bz + bd / 2 + 0.08, 1.4, 2.3);
    doorLamp(P, bx - 4, 2.9, bz + bd / 2 + 0.2);
    signBoard(P, 'sign_sewage', bx, bh - 1.05, bz + bd / 2 + 0.09, 8.5, 0.95);
    // pipe runs
    P.add('plates', place(cylinder(0.4, 0.4, 18, 1, 12), -4, 1.0, -8, 0, 0, Math.PI / 2));
    P.add('plates', place(cylinder(0.4, 0.4, 18, 1, 12), -13, 1.0, 1, 0, Math.PI / 2, Math.PI / 2));
    P.add('plates', place(cylinder(0.4, 0.4, 10, 1, 12), 9, 1.0, 4, 0, Math.PI / 4, Math.PI / 2));
    for (const [x, z] of [[-4, -8], [-13, 1], [9, 4]]) P.add('dark_metal', place(cylinder(0.55, 0.55, 0.6, 1, 12), x, 1.0, z, 0, 0, Math.PI / 2));
    // digester
    P.add('plates', place(cylinder(3.2, 3.2, 6, 1.5, 32), 17, 3, -9));
    P.add('plates', place(new THREE.SphereGeometry(3.2, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2).translate(17, 6, -9), 0, 0, 0));
    P.add('dark_metal', place(cylinder(0.25, 0.25, 4, 1, 10), 17, 10, -9));
    P.smokeSource('steam', 17, 12.2, -9, { scale: 0.7, density: 0.5, opacity: 0.35 });
    P.vehicle('van', 6, 16, Math.PI / 2); P.vehicle('sedan', 14, 20, Math.PI);
    fence(P, w + 6, d + 6, 0, 0, 2.1, 6, { x: 10, w: 9 });
    floodlight(P, -w / 2 + 1, -d / 2 - 1, Math.PI * 0.75, 8); floodlight(P, w / 2 - 1, d / 2 + 1, -Math.PI * 0.25, 8);
    lampPost(P, w / 2 - 6, d / 2 - 1.5, 6, 0, 7);
    apron(P, 10, d / 2 + 4.5, 8, 9);
    P.drive(10, d / 2 + 9, 8);
  },

  garbage(P, def, rng) {
    const { w, d } = def;
    lot(P, w, d, 6, { ground: 'gravel_dark' });
    P.add('dirt', place(box(w - 2, 0.3, d - 2, 4), 0, 0.2, 0));
    // waste mounds: displaced hemispheres with a litter albedo, ringed by compacted dirt
    const mounds = [[-14, -6, 16, 3.6, 12], [10, -10, 12, 2.8, 10], [-4, 12, 13, 3.0, 9], [16, 8, 9, 2.1, 8], [-22, 12, 8, 1.8, 7], [4, 2, 7, 1.5, 6], [-24, -14, 6, 1.3, 6]];
    for (const [x, z, rx, ry, rz] of mounds) {
      let g = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2);
      // planar UVs so the seam merges away
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * rx / 8, pos.getZ(i) * rz / 8);
      g = mergeVertices(g, 1e-4);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
        const n = 1 + 0.16 * Math.sin(px * 3.1 + 1.7) * Math.cos(pz * 2.3 - 0.4) + 0.10 * Math.sin(px * 6.7 - pz * 4.1 + 2.2) + 0.06 * Math.cos(px * 11.3 + pz * 9.7);
        const flat = Math.pow(Math.max(0, py), 0.62);
        p.setXYZ(i, px * (1 + (n - 1) * 0.6), flat * n * (0.85 + 0.15 * (1 - flat)), pz * (1 + (n - 1) * 0.6));
      }
      g.scale(rx, ry, rz);
      g.computeVertexNormals();
      P.add('garbage', place(g, x, 0.36, z, rng.range(0, Math.PI)));
      // tyre-track ring of compacted dirt
      P.add('dirt', place(new THREE.RingGeometry(Math.max(rx, rz) * 0.95, Math.max(rx, rz) * 1.35, 32).rotateX(-Math.PI / 2).translate(x, 0.37, z), 0, 0, 0));
    }
    // haul tracks
    P.add('dark', place(box(4.5, 0.06, d - 6, 3), 2, 0.38, 0));
    P.add('dark', place(box(w - 8, 0.06, 4.5, 3), 0, 0.38, -20));
    // site office (steel cabin) + weighbridge
    const ox = 24, oz = -18, ow = 12, oh = 3.8, od = 7;
    P.add('concrete', place(box(ow + 0.3, 0.5, od + 0.3, 4), ox, 0.25, oz));
    slicedWall(P, 'steel', ow, oh, od, ox, oz, [{ y: 1.4, h: 1.5, faces: { back: false } }], rng, { scale: 2.4, pier: 0.4, inset: 0.2 });
    P.add('plates', place(box(ow + 0.5, 0.25, od + 0.5, 2), ox, oh + 0.12, oz));
    door(P, ox - 4, 0.5, oz + od / 2 + 0.08, 1.1, 2.2);
    doorLamp(P, ox - 4, 3.2, oz + od / 2 + 0.2);
    signBoard(P, 'sign_garbage', ox + 1.5, oh + 1.0, oz + od / 2 - 0.5, 8, 1.0);
    P.add('plates', place(box(0.5, 1.4, 0.5, 1), ox + ow / 2 + 0.6, oh + 0.7, oz - 2));
    P.add('plates', place(box(1.6, 1.6, 0.4, 1), ox + ow / 2 + 0.6, oh + 1.9, oz - 2)); // satellite/aircon box
    apron(P, 22, 14, 14, 20);
    P.add('dark', place(box(3.6, 0.2, 10, 2), 24, 0.36, 16)); // weighbridge plate
    P.add('paint_garbage', place(box(0.3, 2.6, 0.3, 1), 19, 1.5, 21.6));
    P.add('paint_garbage', place(box(9, 0.22, 0.22, 1), 23.5, 2.85, 21.6));
    P.add('paint_white', place(box(0.9, 0.24, 0.24, 1), 21, 2.85, 21.6)); P.add('paint_white', place(box(0.9, 0.24, 0.24, 1), 25, 2.85, 21.6));
    // vehicles
    P.vehicle('garbage-truck', 24, 14.5, Math.PI);
    P.vehicle('garbage-truck', -2, -21, Math.PI / 2 + 0.15);
    P.vehicle('tractor-shovel', 4.5, -5, -0.9);
    P.vehicle('truck', 26, 6, Math.PI);
    for (let i = 0; i < 3; i++) P.add('paint_garbage', place(box(2.2, 1.4, 1.4, 1), 12 + i * 3, 1.05, 21 + rng.range(-0.4, 0.4)));
    fence(P, w + 4, d + 4, 0, 0, 2.2, 6, { x: 24, w: 9 });
    floodlight(P, -w / 2 + 2, d / 2 - 1, 0.8, 10); floodlight(P, w / 2 - 2, -d / 2 + 1, -2.3, 10); floodlight(P, -w / 2 + 2, -d / 2 + 1, 2.4, 10);
    lampPost(P, 16, 24, 6, 0, 7);
    apron(P, 24, d / 2 + 4.5, 8, 9);
    P.drive(24, d / 2 + 9, 8);
  },

  power(P, def, rng) {
    const { w, d } = def;
    lot(P, w, d, 12, { ground: 'gravel' });
    apron(P, 0, 0, w + 4, d + 4);
    // turbine hall (corrugated steel, concrete plinth, ridge vents)
    const hw = 38, hh = 15, hd = 20, hx = -9, hz = -8;
    P.add('concrete', place(box(hw + 0.3, 1.6, hd + 0.3, 4), hx, 0.8, hz));
    slicedWall(P, 'steel', hw, hh, hd, hx, hz, [{ y: 9.5, h: 2.6 }], rng, { scale: 2.4, pier: 0.5, inset: 0.2 });
    P.add('plates', place(box(hw + 0.5, 0.35, hd + 0.5, 2), hx, hh + 0.17, hz));
    P.add('plates', place(box(hw - 4, 1.6, 4.5, 2), hx, hh + 1.1, hz));
    for (let i = 0; i < 6; i++) P.add('louvre', place(quad(5, 1.2, 0, 5, 0, 1.2), hx - 15 + i * 6, hh + 1.1, hz + 2.26));
    for (let i = -1; i <= 1; i++) rollerDoor(P, hx + i * 12, 0.02, hz + hd / 2 + 0.03, 6.0, 6.0);
    doorLamp(P, hx - 6, 7.2, hz + hd / 2 + 0.2); doorLamp(P, hx + 6, 7.2, hz + hd / 2 + 0.2);
    signBoard(P, 'sign_power', hx, hh - 1.6, hz + hd / 2 + 0.09, 14, 1.6);
    // boiler house (concrete, taller) with window bands
    const bw = 18, bh = 22, bd = 24, bx = 16, bz = -2;
    plinth(P, bw, bd, bx, bz, 1.2);
    slicedWall(P, 'concrete', bw, bh, bd, bx, bz, [{ y: 6.5 }, { y: 14.5 }], rng, { scale: 4, pier: 0.8 });
    roofDeck(P, bw, bh, bd, bx, bz);
    hvac(P, bx, bh + 0.2, bz + 6, rng, 3);
    downpipes(P, bw, bh, bd, bx, bz);
    // stair tower
    P.add('plates', place(box(3, bh + 3, 3, 1), bx + bw / 2 + 1.5, (bh + 3) / 2, bz - 6));
    // chimneys with painted bands and aviation lights
    for (const cz of [-10, 8]) {
      const cx = bx + 3;
      P.add('concrete', place(cylinder(1.9, 2.7, 46, 3, 32), cx, 23, cz));
      P.add('paint_fire', place(cylinder(1.93, 2.0, 2.2, 2, 32), cx, 44.5, cz));
      P.add('paint_white', place(cylinder(1.97, 2.05, 2.0, 2, 32), cx, 42.3, cz));
      P.add('paint_fire', place(cylinder(2.02, 2.1, 2.0, 2, 32), cx, 40.2, cz));
      P.add('dark_metal', place(cylinder(1.95, 1.95, 0.6, 1, 32), cx, 46.0, cz));
      P.add('warning', place(new THREE.SphereGeometry(0.45, 10, 8).translate(cx, 46.7, cz), 0, 0, 0));
      P.add('dark_metal', place(box(0.5, 44, 0.06, 1), cx + 2.3, 22.5, cz)); // ladder
      P.smokeSource('industrial', cx, 46.6, cz, { scale: 1.7, density: 1.0 });
    }
    // cooling tower (hyperboloid); seam turned to the back
    const prof = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r = 8.6 - 3.0 * Math.sin(t * Math.PI * 0.72) + 0.6 * t;
      prof.push(new THREE.Vector2(r, t * 34));
    }
    const ct = new THREE.LatheGeometry(prof, 48);
    { const uv = ct.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 12, uv.getY(i) * 34 / 4); }
    P.add('concrete', place(ct, -20, 0, 12, Math.PI));
    P.add('concrete', place(cylinder(8.8, 9.2, 1.2, 4, 48), -20, 0.6, 12));
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; P.add('concrete', place(box(0.7, 3.2, 0.7, 2), -20 + Math.cos(a) * 8.9, 1.6, 12 + Math.sin(a) * 8.9)); }
    // cooling-tower plume: three emitters across the 12 m throat instead of one fat puff, so the
    // steam leaves the rim as a broad column and shears with the wind rather than hanging as a ball
    for (const [dx, dz, sc, dy] of [[0, 0, 2.0, 0], [-3.4, 2.2, 1.35, 1.6], [3.0, -2.6, 1.35, 2.6]]) {
      P.smokeSource('steam', -20 + dx, 33.6 + dy, 12 + dz, { scale: sc, density: 0.62, opacity: 0.34 });
    }
    // coal yard + conveyor
    P.add('coal', place(new THREE.ConeGeometry(7.5, 4.4, 28, 1).translate(-22, 2.2, -13), 0, 0, 0));
    P.add('coal', place(new THREE.ConeGeometry(4.5, 2.6, 20, 1).translate(-14, 1.3, -17), 0, 0, 0));
    P.add('plates', place(box(20, 0.9, 1.4, 2), -10, 8, -13, 0, 0, -0.32));
    P.add('plates', place(box(20, 0.06, 1.6, 2), -10, 8.5, -13, 0, 0, -0.32));
    P.add('plates', place(cylinder(0.18, 0.18, 7, 1, 8), -6, 3.5, -13));
    P.add('plates', place(cylinder(0.18, 0.18, 3, 1, 8), -16, 1.5, -13));
    P.vehicle('tractor-shovel', -16, -6, 2.3);
    P.vehicle('truck', -28, -2, 0.1);
    // transformer yard (fenced switchgear)
    for (let i = 0; i < 6; i++) {
      const tx = 22 + (i % 3) * 3.4, tz = 14 + Math.floor(i / 3) * 3.6;
      P.add('plates', place(box(2.0, 2.4, 1.6, 1), tx, 1.35, tz));
      P.add('dark_metal', place(box(2.3, 0.25, 0.4, 1), tx, 2.7, tz));
      for (const s of [-0.6, 0, 0.6]) P.add('paint_white', place(cylinder(0.1, 0.1, 1.4, 1, 8), tx + s, 3.4, tz));
      P.add('dark_metal', place(box(2.2, 0.05, 0.05, 1), tx, 4.1, tz));
    }
    fence(P, 12, 9, 25.4, 15.8, 2.2, 4);
    P.add('plates', place(cylinder(0.55, 0.55, 12, 1, 12), 8, 6.5, -5, 0, 0, Math.PI / 2));
    P.add('plates', place(cylinder(0.55, 0.55, 12, 1, 12), 8, 9.5, -1, 0, 0, Math.PI / 2));
    // staff parking, lighting, fence
    const bays = parking(P, 10, d / 2 + 2, 4, 0);
    P.vehicle('sedan', bays[0].x, bays[0].z, Math.PI); P.vehicle('suv', bays[2].x, bays[2].z, Math.PI);
    floodlight(P, -w / 2 - 3, d / 2 + 3, 0.8); floodlight(P, w / 2 + 3, d / 2 + 3, -0.8);
    floodlight(P, -w / 2 - 3, -d / 2 - 3, 2.3); floodlight(P, w / 2 + 3, -d / 2 - 3, -2.3);
    fence(P, w + 10, d + 10, 0, 0, 2.2, 8, { x: -10, w: 11 });
    apron(P, -10, d / 2 + 6.5, 10, 9);
    P.drive(-10, d / 2 + 11, 10);
  },
};
