/**
 * Tiny indexed vertex-buffer accumulator with a fixed attribute layout, plus a merge that turns a
 * list of raw pieces into one BufferGeometry. Used so per-segment / per-junction geometry can be
 * cached as plain typed arrays and re-batched per tile without re-tessellating anything.
 */
import * as THREE from 'three';

export const LAYOUT_BASIC = { position: 3, normal: 3, uv: 2 };
/** `aDark` = baked AO darkening (0 = none) for kerb faces / gutters. */
export const LAYOUT_ROAD = { position: 3, normal: 3, uv: 2, aRoad: 4, aTurns: 2, aSeg: 1, aDark: 1 };
/** Skirts carry a vertex colour with alpha so the embankment fades into the terrain. */
export const LAYOUT_SKIRT = { position: 3, normal: 3, uv: 2, color: 4 };

export class GeomBuilder {
  constructor(layout = LAYOUT_BASIC) {
    this.layout = layout;
    this.arrays = {};
    for (const k in layout) this.arrays[k] = [];
    this.index = [];
    this.count = 0;
    /** [vertexIndex, nx, ny, nz, weight] — blended into the computed normal (skirt toes lean into the terrain). */
    this.normalHints = [];
  }
  hintNormal(i, nx, ny, nz, w) { this.normalHints.push(i, nx, ny, nz, w); }
  /** Push one vertex; `data` maps attribute name → array of numbers. Returns the vertex index. */
  vertex(data) {
    for (const k in this.layout) {
      const n = this.layout[k], arr = this.arrays[k], v = data[k];
      if (v == null) for (let i = 0; i < n; i++) arr.push(0);
      else for (let i = 0; i < n; i++) arr.push(v[i] || 0);
    }
    return this.count++;
  }
  tri(a, b, c) { this.index.push(a, b, c); }
  quad(a, b, c, d) { this.index.push(a, b, c, a, c, d); }
  /** Connect two vertex rows of equal length with quads (row0[k], row0[k+1], row1[k+1], row1[k]). */
  bridge(row0, row1) {
    for (let k = 0; k < row0.length - 1; k++) this.quad(row0[k], row0[k + 1], row1[k + 1], row1[k]);
  }
  /** Fan-triangulate a vertex ring around `centre`. */
  fan(centre, ring, closed = true) {
    const n = ring.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) this.tri(centre, ring[k], ring[(k + 1) % n]);
  }
  /** Flip the winding of all triangles whose normal points against `hint` (per triangle). */
  orient(hx, hy, hz, fromTri = 0) {
    const p = this.arrays.position, idx = this.index;
    for (let i = fromTri * 3; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      if (nx * hx + ny * hy + nz * hz < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
  }
  get triCount() { return this.index.length / 3; }
  /** Area-weighted vertex normals from the current triangle list (overwrites `normal`). */
  computeNormals() {
    const p = this.arrays.position, idx = this.index;
    const n = new Float64Array(this.count * 3);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    const out = this.arrays.normal;
    out.length = this.count * 3;
    for (let i = 0; i < this.count; i++) {
      const x = n[i * 3], y = n[i * 3 + 1], z = n[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
    const h = this.normalHints;
    for (let k = 0; k < h.length; k += 5) {
      const i = h[k] * 3, w = h[k + 4];
      const x = out[i] * (1 - w) + h[k + 1] * w, y = out[i + 1] * (1 - w) + h[k + 2] * w, z = out[i + 2] * (1 - w) + h[k + 3] * w;
      const l = Math.hypot(x, y, z) || 1;
      out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l;
    }
  }
  /** Freeze into typed arrays. Returns null if empty. */
  toRaw() {
    if (this.count === 0 || this.index.length === 0) return null;
    const arrays = {};
    for (const k in this.layout) arrays[k] = Float32Array.from(this.arrays[k]);
    const index = this.count > 65535 ? Uint32Array.from(this.index) : Uint16Array.from(this.index);
    const p = arrays.position;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    return { layout: this.layout, arrays, index, count: this.count, bbox: { minX, minY, minZ, maxX, maxY, maxZ } };
  }
}

/** Merge raw pieces (same layout) into one BufferGeometry. Returns null when nothing to merge. */
export function mergeRaw(pieces, layout) {
  let vcount = 0, icount = 0;
  for (const r of pieces) { vcount += r.count; icount += r.index.length; }
  if (vcount === 0) return null;
  const geo = new THREE.BufferGeometry();
  for (const k in layout) {
    const n = layout[k];
    const arr = new Float32Array(vcount * n);
    let off = 0;
    for (const r of pieces) { arr.set(r.arrays[k], off); off += r.arrays[k].length; }
    geo.setAttribute(k, new THREE.BufferAttribute(arr, n));
  }
  const index = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
  let io = 0, vo = 0;
  for (const r of pieces) {
    const src = r.index;
    for (let i = 0; i < src.length; i++) index[io + i] = src[i] + vo;
    io += src.length; vo += r.count;
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
