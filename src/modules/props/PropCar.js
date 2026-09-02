/**
 * props — parked-car bodies.
 *
 * A car is a *lofted* shell: rounded-rectangle cross sections (superellipse, flatter at the sills,
 * rounder at the shoulder) swept along the length, with a second loft for the greenhouse whose top
 * band is paint (roof) and whose flanks are glass. Vertex normals are computed on the full quad
 * grid before the triangles are split per material, so the body stays smoothly shaded across the
 * paint/glass seam. Wheels get a dark arch liner so the wheel openings read as openings.
 *
 * Local frame: origin on the road between the wheels, +Z = nose, +Y up, +X right.
 * Returns { matKey: BufferGeometry } like every other builder in PropGeometry.js.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const K = 14;                       // ring resolution (points around a cross section)
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6))); return t * t * (3 - 2 * t); };

/** Superellipse point: exponent `n` low = rounder, high = boxier. Angle 0 = right, π/2 = top. */
function se(a, n) {
  const c = Math.cos(a), s = Math.sin(a);
  const p = 2 / n;
  return [Math.sign(c) * Math.pow(Math.abs(c), p), Math.sign(s) * Math.pow(Math.abs(s), p)];
}

/**
 * Loft a closed tube through `rings` (each = { z, hw, y0, y1, nLow, nUp }) and emit triangles into
 * per-material buckets chosen by `matOf(ringAngleIndex)`. Caps are fanned into `capMat`.
 */
function loft(rings, matOf, capMat) {
  const S = rings.length;
  const pos = new Float32Array(S * K * 3);
  const idx = (i, k) => (i * K + k) * 3;
  for (let i = 0; i < S; i++) {
    const r = rings[i];
    const cy = (r.y0 + r.y1) / 2, ry = (r.y1 - r.y0) / 2;
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const n = Math.sin(a) >= 0 ? r.nUp : r.nLow;
      const [ux, uy] = se(a, n);
      const o = idx(i, k);
      pos[o] = ux * r.hw; pos[o + 1] = cy + uy * ry; pos[o + 2] = r.z;
    }
  }
  // smooth normals over the whole grid (before the material split)
  const nrm = new Float32Array(pos.length);
  const addN = (o, x, y, z) => { nrm[o] += x; nrm[o + 1] += y; nrm[o + 2] += z; };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), U = new THREE.Vector3(), V = new THREE.Vector3(), N = new THREE.Vector3();
  const get = (o, v) => v.set(pos[o], pos[o + 1], pos[o + 2]);
  for (let i = 0; i < S - 1; i++) {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const a = idx(i, k), b = idx(i, k1), c = idx(i + 1, k1), d = idx(i + 1, k);
      get(a, A); get(b, B); get(c, C);
      U.subVectors(B, A); V.subVectors(C, A); N.crossVectors(U, V).normalize();
      for (const o of [a, b, c, d]) addN(o, N.x, N.y, N.z);
    }
  }
  for (let o = 0; o < nrm.length; o += 3) {
    const l = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]) || 1;
    nrm[o] /= l; nrm[o + 1] /= l; nrm[o + 2] /= l;
  }

  const buckets = new Map();
  const push = (mat, o) => {
    if (!buckets.has(mat)) buckets.set(mat, { p: [], n: [] });
    const b = buckets.get(mat);
    b.p.push(pos[o], pos[o + 1], pos[o + 2]);
    b.n.push(nrm[o], nrm[o + 1], nrm[o + 2]);
  };
  for (let i = 0; i < S - 1; i++) {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const mat = matOf(k, i);
      if (!mat) continue;
      const a = idx(i, k), b = idx(i, k1), c = idx(i + 1, k1), d = idx(i + 1, k);
      // (a,b,c) matches the outward normal accumulated above — reversing it turns the shell inside out
      push(mat, a); push(mat, b); push(mat, c);
      push(mat, a); push(mat, c); push(mat, d);
    }
  }
  if (capMat) {
    for (const [i, dir] of [[0, -1], [S - 1, 1]]) {
      const r = rings[i];
      const cy = (r.y0 + r.y1) / 2;
      for (let k = 0; k < K; k++) {
        const k1 = (k + 1) % K;
        const a = idx(i, k), b = idx(i, k1);
        if (!buckets.has(capMat)) buckets.set(capMat, { p: [], n: [] });
        const bk = buckets.get(capMat);
        const tri = dir > 0 ? [[0, 0], [a, 1], [b, 1]] : [[0, 0], [b, 1], [a, 1]];
        for (const [o, real] of tri) {
          if (real) { bk.p.push(pos[o], pos[o + 1], pos[o + 2]); } else { bk.p.push(0, cy, r.z); }
          bk.n.push(0, 0, dir);
        }
      }
    }
  }
  const out = {};
  for (const [mat, b] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((b.p.length / 3) * 2), 2));
    out[mat] = g;
  }
  return out;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
function at(g, x, y, z, ry = 0, rx = 0, rz = 0) {
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Body/greenhouse/wheel proportions per style, in metres. */
export const CAR_SPECS = {
  sedan: { len: 4.56, wid: 1.80, wheelR: 0.325, sill: 0.255, belt: 1.06, roof: 1.46, cab: [-1.46, 0.34], nose: 0.90, tail: 0.98, hood: 0.86, deck: 1.00, box: 0 },
  hatch: { len: 4.02, wid: 1.74, wheelR: 0.305, sill: 0.250, belt: 1.05, roof: 1.51, cab: [-1.62, 0.30], nose: 0.86, tail: 0.62, hood: 0.86, deck: 1.10, box: 0 },
  estate: { len: 4.78, wid: 1.90, wheelR: 0.355, sill: 0.290, belt: 1.17, roof: 1.72, cab: [-1.86, 0.40], nose: 0.92, tail: 0.86, hood: 0.99, deck: 1.22, box: 0 },
  van: { len: 5.05, wid: 1.94, wheelR: 0.335, sill: 0.300, belt: 1.22, roof: 2.18, cab: [-1.05, 0.66], nose: 0.86, tail: 1.02, hood: 1.06, deck: 1.30, box: 1 },
};

/** Build one parked car. `style` ∈ keys of CAR_SPECS. */
export function makeCar(style = 'sedan') {
  const S = CAR_SPECS[style];
  const L = S.len, hw = S.wid / 2;
  const z0 = -L / 2, z1 = L / 2;
  const parts = [];

  /* ------------------------------------------------------------ lower body */
  const rings = [];
  const NS = 16;
  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1);
    const z = z0 + t * L;
    const zn = (z - z0) / L;                                   // 0 tail … 1 nose
    // width tapers into both ends, fullest across the doors, then rounds off over the last 10 %
    const tuckF = smooth(1.0, 0.86, zn), tuckR = smooth(0.0, 0.13, zn);
    const round = Math.min(smooth(0.0, 0.10, zn), smooth(1.0, 0.90, zn));
    const w = hw * (0.90 + 0.10 * Math.min(tuckR, tuckF)) * (0.88 + 0.12 * round);
    // top line: boot deck → belt → bonnet, dropping at the nose
    const deck = S.deck, hood = S.hood;
    let top = S.belt;
    if (zn > 0.56) top = S.belt + (hood - S.belt) * smooth(0.56, 0.92, zn);
    if (zn < 0.30) top = S.belt + (deck - S.belt) * smooth(0.30, 0.03, zn);
    let bottom = S.sill * (1 - 0.32 * smooth(0.14, 0.0, zn)) * (1 - 0.32 * smooth(0.86, 1.0, zn));
    // pull the nose/tail faces in vertically as well, so the end cap is a small rounded face
    const h = top - bottom;
    top -= h * 0.12 * (1 - round);
    bottom += h * 0.05 * (1 - round);
    rings.push({ z, hw: Math.max(0.16, w), y0: bottom, y1: top, nLow: 5.0, nUp: 3.2 });
  }
  const body = loft(rings, () => 'car_paint', 'car_paint');
  for (const [m, g] of Object.entries(body)) parts.push([m, g]);

  /* ------------------------------------------------------------ greenhouse */
  const [cz0, cz1] = S.cab;
  const cabL = cz1 - cz0;
  const gh = [];
  const NG = 12;
  for (let i = 0; i < NG; i++) {
    const t = i / (NG - 1);
    const z = cz0 + t * cabL;
    // roof height: rises fast off the windscreen base, falls into the rear screen
    const rise = S.box ? smooth(0.0, 0.16, t) : smooth(0.0, 0.30, t);
    const fall = S.box ? smooth(1.0, 0.88, t) : smooth(1.0, 0.72, t);
    const h = S.belt + (S.roof - S.belt) * Math.min(rise, fall);
    const wf = 0.84 + 0.11 * Math.min(smooth(0.0, 0.22, t), smooth(1.0, 0.80, t));
    gh.push({ z, hw: hw * wf, y0: S.belt - 0.17, y1: Math.max(S.belt - 0.13, h), nLow: 3.4, nUp: 2.15 });
  }
  // ring angles: the top band is painted roof, the flanks/ends are glass. The band is decided from
  // the *midpoint* angle of each quad — using the corner angle puts the roof off-centre by half a
  // segment, which reads as a slab bolted on crooked.
  const ghParts = loft(gh, (k, i) => {
    const a = ((k + 0.5) / K) * Math.PI * 2;
    if (Math.sin(a) < -0.35) return null;                       // underside of the cab: hidden
    // The first and last rows of the greenhouse ARE the backlight and the windscreen: they must be
    // glass all the way over the crown, or the car has no glazing at all from three-quarter front —
    // the classic toy-car tell. Between them only the crown of the ring is roof paint.
    const end = i === 0 || i >= NG - 3;
    return !end && Math.sin(a) > 0.90 ? 'car_paint' : 'car_glass';
  }, null);
  for (const [m, g] of Object.entries(ghParts)) parts.push([m, g]);

  // B-pillar: a narrow painted strip across the middle of the greenhouse
  if (!S.box) {
    const bz = cz0 + cabL * 0.46;
    for (const sx of [-1, 1]) parts.push(['car_paint', at(box(0.05, S.roof - S.belt + 0.1, 0.10), sx * hw * 0.895, (S.belt + S.roof) / 2 - 0.02, bz)]);
  }

  /* ---------------------------------------------------------------- wheels */
  const axF = z1 - S.nose - 0.02, axR = z0 + S.tail + 0.02;
  for (const sx of [-1, 1]) {
    for (const az of [axF, axR]) {
      const r = S.wheelR;
      const tyre = new THREE.CylinderGeometry(r, r, 0.215, 16, 1);
      tyre.rotateZ(Math.PI / 2);
      parts.push(['car_tyre', at(tyre, sx * (hw - 0.10), r, az)]);
      const rim = new THREE.CylinderGeometry(r * 0.66, r * 0.66, 0.26, 12, 1);
      rim.rotateZ(Math.PI / 2);
      parts.push(['car_trim', at(rim, sx * (hw - 0.082), r, az)]);
      const hub = new THREE.CylinderGeometry(r * 0.26, r * 0.26, 0.28, 8, 1);
      hub.rotateZ(Math.PI / 2);
      parts.push(['car_dark', at(hub, sx * (hw - 0.075), r, az)]);
      // arch liner: a dark half-ring just inside the body skin
      const arch = new THREE.TorusGeometry(r * 1.07, 0.05, 5, 12, Math.PI);
      arch.rotateY(Math.PI / 2);
      parts.push(['car_tyre', at(arch, sx * (hw - 0.045), r, az)]);
    }
  }

  /* ------------------------------------------------- lamps, grille, plates */
  // lamps/grille/plates sit just proud of the end faces so they read as bumper hardware.
  // Plates share the lamp material and arch liners share the tyre material: one draw call each per
  // cascade is saved for every car style, and the shading difference is invisible at street scale.
  const lampY = S.sill + (S.belt - S.sill) * 0.56;
  for (const sx of [-1, 1]) {
    parts.push(['car_lamp', at(box(0.28, 0.115, 0.07), sx * (hw - 0.37), lampY + 0.06, z1 - 0.02)]);
    parts.push(['car_tail', at(box(0.24, 0.13, 0.07), sx * (hw - 0.35), lampY + 0.10, z0 + 0.02)]);
    // mirror on a short stalk
    if (!S.box) parts.push(['car_dark', at(box(0.15, 0.075, 0.09), sx * (hw + 0.03), S.belt - 0.06, cz1 - 0.22)]);
    else parts.push(['car_dark', at(box(0.17, 0.09, 0.10), sx * (hw + 0.04), S.belt + 0.24, cz1 - 0.10)]);
  }
  parts.push(['car_dark', at(box(S.wid * 0.50, 0.11, 0.05), 0, S.sill + 0.13, z1 - 0.005)]);       // lower grille
  parts.push(['car_dark', at(box(S.wid * 0.34, 0.08, 0.05), 0, lampY + 0.10, z1 - 0.005)]);        // upper grille
  parts.push(['car_dark', at(box(S.wid * 0.46, 0.09, 0.05), 0, S.sill + 0.13, z0 + 0.005)]);       // rear bumper trim
  parts.push(['car_lamp', at(box(0.40, 0.10, 0.04), 0, S.sill + 0.30, z1 + 0.005)]);
  parts.push(['car_lamp', at(box(0.40, 0.10, 0.04), 0, S.sill + 0.30, z0 - 0.005)]);
  // sill/bumper rub strips ground the body visually
  for (const sx of [-1, 1]) parts.push(['car_dark', at(box(0.045, 0.075, L * 0.60), sx * (hw - 0.035), S.sill + 0.02, 0)]);

  /* ------------------------------------------------------------- assemble */
  const byMat = new Map();
  for (const [m, g] of parts) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    for (const key of Object.keys(geo.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') geo.deleteAttribute(key);
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(geo);
  }
  const out = {};
  for (const [m, list] of byMat) {
    const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
    g.computeBoundingSphere();
    out[m] = g;
  }
  return out;
}
