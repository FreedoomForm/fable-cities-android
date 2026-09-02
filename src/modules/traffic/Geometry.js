/**
 * traffic — mesh building helpers.
 *
 * Every vehicle / pedestrian part is baked into ONE geometry per model so a whole fleet renders
 * from a single InstancedMesh. Per-vertex "surface" attributes carry what would normally need
 * separate materials:
 *
 *   color  vec3   base albedo (linear-sRGB)
 *   aSurf  vec4   (paintMask, paint2Mask, metalness, roughness)  — paint masks blend in the
 *                 per-instance paint colours so every car gets its own body colour
 *   aLight float  emissive kind: 0 none · 1 headlight · 2 tail/brake · 3 brake-only · 4 interior
 *   aClass float  surface class, read `flat` in the fragment shader so a glass triangle is never
 *                 smeared into the paint next to it: 0 generic · 1 body paint · 2 glass ·
 *                 3 bus glazing · 4 chrome/metal · 5 rubber · 6 lamp lens
 *   aLimb  float  pedestrians: 0 body · 1 L-arm · 2 R-arm · 3 L-leg · 4 R-leg
 *   aPivot vec3   pedestrians: rotation pivot of that limb
 */
import * as THREE from 'three';

const _c = new THREE.Color();
/** sRGB hex → linear working-space triple. */
export function lin(hex) {
  _c.setHex(hex, THREE.SRGBColorSpace);
  return [_c.r, _c.g, _c.b];
}

const WHITE = [1, 1, 1];

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export class MeshBuilder {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.s = []; this.e = []; this.k = [];
    this.lm = []; this.pv = []; this.idx = [];
    this.hasLimbs = false;
  }

  vert(x, y, z, nx, ny, nz, st) {
    const id = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    const col = st.color || WHITE;
    this.c.push(col[0], col[1], col[2]);
    this.s.push(st.paint || 0, st.paint2 || 0, st.metal || 0, st.rough === undefined ? 0.55 : st.rough);
    this.e.push(st.light || 0);
    this.k.push(st.cls === undefined ? (st.paint || st.paint2 ? 1 : 0) : st.cls);
    if (st.limb) { this.hasLimbs = true; this.lm.push(st.limb); const q = st.pivot || [0, 0, 0]; this.pv.push(q[0], q[1], q[2]); }
    else { this.lm.push(0); this.pv.push(0, 0, 0); }
    return id;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /** Axis-aligned box with flat normals. `st` may be a style or a fn(faceIndex) → style. */
  box(cx, cy, cz, sx, sy, sz, st) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const faces = [
      { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
      { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
      { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
      { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
      { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
      { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    ];
    for (let f = 0; f < 6; f++) {
      const face = faces[f];
      const style = typeof st === 'function' ? st(f) : st;
      if (!style) continue;
      const ids = face.v.map((v) => this.vert(cx + v[0], cy + v[1], cz + v[2], face.n[0], face.n[1], face.n[2], style));
      this.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  }

  /** Cylinder along the local X axis (radius 1 in YZ, length 1) — the wheel primitive. */
  tube(x0, x1, r0, r1, sides, st, capStyle) {
    const ring0 = [], ring1 = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const cy = Math.cos(a), sz = Math.sin(a);
      ring0.push(this.vert(x0, cy * r0, sz * r0, 0, cy, sz, st));
      ring1.push(this.vert(x1, cy * r1, sz * r1, 0, cy, sz, st));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.quad(ring0[i], ring1[i], ring1[j], ring0[j]);
    }
    if (capStyle) {
      const c1 = this.vert(x1, 0, 0, 1, 0, 0, capStyle);
      const c0 = this.vert(x0, 0, 0, -1, 0, 0, capStyle);
      const r1o = [], r0o = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        r1o.push(this.vert(x1, Math.cos(a) * r1, Math.sin(a) * r1, 1, 0, 0, capStyle));
        r0o.push(this.vert(x0, Math.cos(a) * r0, Math.sin(a) * r0, -1, 0, 0, capStyle));
      }
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        this.tri(c1, r1o[i], r1o[j]);
        this.tri(c0, r0o[j], r0o[i]);
      }
    }
  }

  /**
   * Loft a chain of rounded-rectangle cross sections along +Z.
   * sections: [{ z, hw, y0, y1, rt, rb }] ordered by increasing z.
   * style(x,y,z, nx,ny,nz, u, k) → per-vertex style.
   */
  loft(sections, opts = {}) {
    const N = opts.res || { nb: 2, ns: 2, nt: 3 };
    const styleFn = opts.style;
    const M = sections.length;
    const outs = sections.map((s) => outline(s, N));
    const P = outs[0].length;
    const pts = [];
    for (let i = 0; i < M; i++) {
      const row = [];
      for (let k = 0; k < P; k++) row.push([outs[i][k][0], outs[i][k][1], sections[i].z]);
      pts.push(row);
    }
    const grid = [];
    for (let i = 0; i < M; i++) {
      const row = [];
      const cy = (sections[i].y0 + sections[i].y1) * 0.5;
      for (let k = 0; k < P; k++) {
        const p = pts[i][k];
        const du = sub(pts[Math.min(M - 1, i + 1)][k], pts[Math.max(0, i - 1)][k]);
        const dk = sub(pts[i][(k + 1) % P], pts[i][(k - 1 + P) % P]);
        let n = cross(du, dk);
        if (n[0] * p[0] + n[1] * (p[1] - cy) < 0) n = [-n[0], -n[1], -n[2]];
        if (!n[0] && !n[1] && !n[2]) n = [p[0] || 0.001, p[1] - cy, 0];
        n = norm(n);
        const u = M > 1 ? i / (M - 1) : 0;
        row.push(this.vert(p[0], p[1], p[2], n[0], n[1], n[2], styleFn(p[0], p[1], p[2], n[0], n[1], n[2], u, k / P, sections[i])));
      }
      grid.push(row);
    }
    for (let i = 0; i < M - 1; i++) {
      for (let k = 0; k < P; k++) {
        const k2 = (k + 1) % P;
        this.quad(grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]);
      }
    }
    if (opts.caps !== false) {
      for (const end of [0, M - 1]) {
        const front = end === M - 1;
        const nz = front ? 1 : -1;
        const sec = sections[end];
        const cy = (sec.y0 + sec.y1) * 0.5;
        const cst = (opts.capStyle || styleFn)(0, cy, sec.z, 0, 0, nz, front ? 1 : 0, -1, sec);
        const centre = this.vert(0, cy, sec.z, 0, 0, nz, cst);
        const ring = [];
        for (let k = 0; k < P; k++) {
          const p = pts[end][k];
          ring.push(this.vert(p[0], p[1], p[2], 0, 0, nz, (opts.capStyle || styleFn)(p[0], p[1], p[2], 0, 0, nz, front ? 1 : 0, k / P, sec)));
        }
        for (let k = 0; k < P; k++) {
          const j = (k + 1) % P;
          if (front) this.tri(centre, ring[k], ring[j]);
          else this.tri(centre, ring[j], ring[k]);
        }
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 4));
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.e, 1));
    g.setAttribute('aClass', new THREE.Float32BufferAttribute(this.k, 1));
    if (this.hasLimbs) {
      g.setAttribute('aLimb', new THREE.Float32BufferAttribute(this.lm, 1));
      g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.pv, 3));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }

  get triangles() { return this.idx.length / 3; }
}

/** Closed rounded-rectangle outline: bottom centre → right → top centre → left → back. */
function outline(sec, N) {
  const hw = Math.max(0.01, sec.hw);
  const y0 = sec.y0;
  const y1 = Math.max(sec.y0 + 0.02, sec.y1);
  const h = y1 - y0;
  const rb = Math.max(0.001, Math.min(sec.rb === undefined ? 0.08 : sec.rb, hw * 0.85, h * 0.45));
  const rt = Math.max(0.001, Math.min(sec.rt === undefined ? 0.12 : sec.rt, hw * 0.85, h * 0.45));
  const H = [[0, y0]];
  for (let i = 0; i <= N.nb; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / N.nb);
    H.push([hw - rb + rb * Math.cos(a), y0 + rb + rb * Math.sin(a)]);
  }
  // Straight side rows. `sec.ys` lets the caller pin rows to feature heights (belt line, glass
  // top, …) so a style change lands on a crisp edge instead of being smeared across a long quad.
  // It must hold the same number of ascending values for every section of one loft; values are
  // clamped into the section, so short sections simply collapse rows together.
  const lo = y0 + rb, hi = y1 - rt;
  if (sec.ys) {
    let prev = lo;
    for (let j = 0; j < sec.ys.length; j++) {
      const y = Math.min(hi - 1e-4, Math.max(prev + 1e-4, sec.ys[j]));
      H.push([hw, y]);
      prev = y;
    }
  } else {
    for (let j = 1; j < N.ns; j++) H.push([hw, lo + (hi - lo) * (j / N.ns)]);
  }
  for (let i = 0; i <= N.nt; i++) {
    const a = (Math.PI / 2) * (i / N.nt);
    H.push([hw - rt + rt * Math.cos(a), y1 - rt + rt * Math.sin(a)]);
  }
  H.push([0, y1]);
  const P = H.slice();
  for (let i = H.length - 2; i >= 1; i--) P.push([-H[i][0], H[i][1]]);
  return P;
}
