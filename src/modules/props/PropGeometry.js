/**
 * props — procedural geometry for the street furniture that has no CC0 model:
 * street trees, tree grates, traffic signals, sign posts/panels, bus shelters,
 * hedges, picket and chain-link fences, bollards and the lamp halo billboard.
 *
 * Local space convention: origin sits on the ground under the object, +Y up, +Z is the
 * "facing" direction (toward the road for street furniture, the nose for vehicles).
 * Every builder returns { matKey: BufferGeometry } — one merged geometry per material.
 *
 * Foliage is built the way the terrain module builds its forests: an envelope of blobs covered
 * with alpha-cut leaf *cards* carrying baked ambient occlusion in their vertex colour. Smooth
 * displaced spheres read as plastic balloons at street level; cards keep a broken silhouette,
 * let daylight through and cast dappled shadows.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplexNoise } from '../../shared/noise.js';
import { makeRng } from '../../shared/random.js';

const nid = (g) => (g.index ? g.toNonIndexed() : g);
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Parts {
  constructor() { this.map = new Map(); }
  add(mat, geo) {
    if (!this.map.has(mat)) this.map.set(mat, []);
    this.map.get(mat).push(nid(geo));
    return this;
  }
  finish() {
    const out = {};
    for (const [mat, geos] of this.map) {
      const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      g.computeBoundingSphere();
      out[mat] = g;
    }
    return out;
  }
}

export const box = (w, h, d, seg = 1) => new THREE.BoxGeometry(w, h, d, seg, seg, seg);
export const cyl = (r0, r1, h, seg = 8, open = false) => new THREE.CylinderGeometry(r0, r1, h, seg, 1, open);
export const plane = (w, h) => new THREE.PlaneGeometry(w, h);
/** translate + optional rotation (yaw about Y, then pitch about X). */
export function at(g, x, y, z, ry = 0, rx = 0, rz = 0) {
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Flat white vertex colour so a geometry can be merged into a vertexColors material. */
export function white(g, shade = 1) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** One foliage card: a quad of w×h at `pos`, oriented by `q`, with a forced shading normal + baked AO. */
export function card(w, h, pos, q, normal, shade) {
  const g = plane(w, h);
  g.applyQuaternion(q);
  g.translate(pos.x, pos.y, pos.z);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, normal.x, normal.y, normal.z);
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) { col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Quaternion turning the card (facing +Z) toward `dir` with a random roll. */
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v1 = new THREE.Vector3();
export function faceQuat(dir, roll) {
  _v1.copy(dir).normalize();
  _q1.setFromUnitVectors(FWD, _v1);
  _q2.setFromAxisAngle(_v1, roll);
  return _q2.clone().multiply(_q1);
}

/** Tapered trunk/branch section from `base` along `dir`, with baked AO darkening toward the base. */
function limb(r0, r1, len, seg, base, dir, shade = 0.85) {
  const g = cyl(r1, r0, len, seg);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate(base.x, base.y, base.z);
  return white(g, shade);
}

/* ------------------------------------------------------------------- trees */

const TREE_SPEC = [
  // 0 — broad street tree (plane/maple): short clear trunk, wide asymmetric crown
  { trunk: 2.75, r0: 0.20, r1: 0.115, rx: 2.55, ry: 1.95, rz: 2.35, blobs: 4, sat: 3, up: 1.5, cardK: 1.95, branches: 4 },
  // 1 — narrow upright (hornbeam/ash): tall, columnar
  { trunk: 2.95, r0: 0.175, r1: 0.095, rx: 1.95, ry: 2.55, rz: 1.85, blobs: 3, sat: 3, up: 1.25, cardK: 1.75, branches: 4 },
  // 2 — small ornamental (flowering cherry): low round crown
  { trunk: 1.85, r0: 0.13, r1: 0.075, rx: 1.7, ry: 1.3, rz: 1.6, blobs: 3, sat: 3, up: 1.75, cardK: 1.7, branches: 4 },
  // 3 — conifer (spruce): short clear trunk under a stack of rings narrowing to a spire. The p4
  // critic's "every crown is the same rounded broadleaf blob" needs a silhouette that is not an
  // ellipsoid at all, so this one builds its blobs up the axis instead of around a centre.
  { trunk: 1.30, r0: 0.20, r1: 0.10, rx: 1.55, ry: 2.85, rz: 1.55, blobs: 6, sat: 0, up: 0.55, cardK: 1.45, branches: 5, cone: true },
];

/**
 * Street tree. `style` 0 broad · 1 upright · 2 small ornamental. `lod` 1 = far LOD (a third of the
 * cards, no branches). Returns { bark, leaves } (style 2 returns { bark, blossom }).
 */
export function makeTree(seed, style = 0, lod = 0) {
  const S = TREE_SPEC[style];
  const rng = makeRng(seed * 31 + 7);
  const noise = new SimplexNoise(seed);
  const leafKey = style === 2 ? 'blossom' : 'leaves';
  const P = new Parts();
  const R = (a, b) => a + rng() * (b - a);

  // --- trunk: two leaning sections so no two instances read as the same stamp
  const lean = new THREE.Vector3(R(-0.06, 0.06), 1, R(-0.06, 0.06)).normalize();
  const trunkH = S.trunk * R(0.95, 1.08);
  P.add('bark', limb(S.r0, S.r0 * 0.82, trunkH * 0.55, lod ? 4 : 7, new THREE.Vector3(0, -0.12, 0), lean, 0.62));
  const mid = lean.clone().multiplyScalar(trunkH * 0.55);
  P.add('bark', limb(S.r0 * 0.82, S.r1, trunkH * 0.5, lod ? 4 : 7, mid, lean, 0.9));

  const top = lean.clone().multiplyScalar(trunkH);
  const nb = lod ? 0 : S.branches;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + R(-0.5, 0.5);
    const d = new THREE.Vector3(Math.cos(a) * 0.8, S.up * R(0.55, 0.95), Math.sin(a) * 0.8).normalize();
    const base = lean.clone().multiplyScalar(trunkH * R(0.72, 0.98));
    P.add('bark', limb(S.r1 * 0.85, S.r1 * 0.28, R(1.1, 1.9) * (style === 1 ? 1.35 : 1), 4, base, d, 0.8));
  }

  // --- crown envelope: one core blob + lobes + satellites
  const rx = S.rx * R(0.9, 1.1), ry = S.ry * R(0.92, 1.08), rz = S.rz * R(0.9, 1.1);
  const centre = top.clone().add(new THREE.Vector3(R(-0.35, 0.35), ry * 0.82, R(-0.35, 0.35)));
  const blobs = S.cone ? [] : [{ c: centre.clone(), r: Math.min(rx, ry) * 0.66 }];
  const nLobe = lod ? Math.max(1, S.blobs - 2) : S.blobs;
  if (S.cone) {
    // rings up the axis, radius falling to a point: a cone silhouette, not an ellipsoid
    const n = lod ? 4 : 7;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const rr = Math.max(0.22, Math.min(rx, rz) * (1.05 - 0.88 * t * t));
      blobs.push({
        c: top.clone().add(new THREE.Vector3(R(-0.14, 0.14), ry * (-0.72 + 1.62 * t), R(-0.14, 0.14))),
        r: rr,
      });
    }
  } else for (let i = 0; i < nLobe; i++) {
    const a = (i / nLobe) * Math.PI * 2 + R(-0.55, 0.55);
    const el = style === 1 ? R(-0.7, 0.9) : R(0.0, 0.6);
    const sp = R(0.42, 0.62);
    blobs.push({
      c: new THREE.Vector3(Math.cos(a) * Math.cos(el) * rx * sp, Math.sin(el) * ry * 0.72, Math.sin(a) * Math.cos(el) * rz * sp).add(centre),
      r: Math.min(rx, ry) * R(0.5, 0.72),
    });
  }
  const nSat = lod || S.cone ? 0 : S.sat;
  for (let i = 0; i < nSat; i++) {
    const a = R(0, Math.PI * 2), el = R(-0.4, 0.5), sp = R(0.5, 0.8);
    blobs.push({
      c: new THREE.Vector3(Math.cos(a) * Math.cos(el) * rx * sp, Math.sin(el) * ry * 0.66, Math.sin(a) * Math.cos(el) * rz * sp).add(centre),
      r: Math.min(rx, ry) * R(0.3, 0.46),
    });
  }

  // --- leaf cards over every blob, outward-facing, AO baked from height + distance from the core
  const cards = [];
  const rel = new THREE.Vector3();
  for (const b of blobs) {
    const per = Math.max(3, Math.round((lod ? 3.0 : 6.3) * (b.r / (Math.min(rx, ry) * 0.6))));
    for (let i = 0; i < per; i++) {
      const u = rng(), v = rng();
      const theta = Math.acos(1 - 1.55 * u), phi = 2 * Math.PI * v;      // biased to the upper hemisphere
      const dir = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      const p = b.c.clone().addScaledVector(dir, b.r * 0.55);
      rel.subVectors(p, centre);
      const en = new THREE.Vector3(rel.x / (rx * rx), rel.y / (ry * ry), rel.z / (rz * rz)).normalize();
      const n = en.multiplyScalar(0.52).addScaledVector(dir, 0.28).add(new THREE.Vector3(0, 0.42, 0)).normalize();
      const size = b.r * S.cardK * R(0.85, 1.12) * (lod ? 1.35 : 1);
      const hF = clamp01((p.y - (centre.y - ry)) / (2 * ry));
      const oF = clamp01(rel.length() / Math.max(rx, rz));
      const nz = 0.5 + 0.5 * noise.noise3D(p.x * 0.9, p.y * 0.9, p.z * 0.9);
      const shade = 0.54 + 0.46 * (0.5 * hF + 0.36 * oF + 0.14 * nz);
      cards.push(card(size, size * R(0.86, 1.1), p, faceQuat(dir, R(0, Math.PI * 2)), n, shade));
    }
  }
  P.add(leafKey, mergeGeometries(cards, false));
  return P.finish();
}

/**
 * Garden / park shrub: a squat dome of leaf cards over two woody stems. Built from the same cards as
 * the trees so a hedge, a shrub and a street tree all catch the light the same way.
 * `style` 0 = round bushy, 1 = wider and lower.
 */
export function makeShrub(seed, style = 0) {
  const rng = makeRng(seed * 13 + 5);
  const P = new Parts();
  const R = (a, b) => a + rng() * (b - a);
  const h = style ? R(0.62, 0.82) : R(0.82, 1.05);
  const rx = style ? R(0.72, 0.92) : R(0.58, 0.74);
  const ry = h * 0.52;
  const centre = new THREE.Vector3(0, h * 0.56, 0);
  for (let i = 0; i < 2; i++) {
    const a = R(0, 6.283);
    P.add('bark', limb(0.045, 0.02, h * 0.7, 4, new THREE.Vector3(0, -0.05, 0),
      new THREE.Vector3(Math.cos(a) * 0.22, 1, Math.sin(a) * 0.22).normalize(), 0.6));
  }
  const cards = [];
  const n = style ? 11 : 10;
  for (let i = 0; i < n; i++) {
    const u = rng(), v = (i + rng() * 0.7) / n;
    const theta = Math.acos(1 - 1.5 * u), phi = 2 * Math.PI * v;
    const dir = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    const p = new THREE.Vector3(dir.x * rx * 0.5, centre.y + dir.y * ry * 0.55, dir.z * rx * 0.5);
    const nrm = new THREE.Vector3(dir.x, dir.y * 0.8 + 0.5, dir.z).normalize();
    const size = R(0.78, 1.02) * (rx + ry);
    const shade = 0.58 + 0.42 * clamp01((p.y / (h || 1)) * 0.7 + 0.3);
    cards.push(card(size, size * R(0.8, 1.0), p, faceQuat(dir, R(0, 6.283)), nrm, shade));
  }
  P.add('hedge_leaf', mergeGeometries(cards, false));
  return P.finish();
}

/** Cast-iron tree grate + the soil ring under it (sits flush in the sidewalk). */
export function makeTreePit(r = 0.78) {
  const P = new Parts();
  P.add('soil', at(cyl(r * 0.94, r * 0.94, 0.05, 12), 0, 0.015, 0));
  const grate = new THREE.CircleGeometry(r, 20);
  grate.rotateX(-Math.PI / 2);
  P.add('grate', at(grate, 0, 0.055, 0));
  P.add('curb_ring', at(cyl(r + 0.075, r + 0.075, 0.13, 14, true), 0, 0.065, 0));
  return P.finish();
}

/* ---------------------------------------------------------------- signals */

/**
 * Traffic signal facing +Z. `kind` 'post' = kerbside pole with a primary head at 3.2 m and a
 * repeater at 1.75 m; 'mast' = a pole with a 5.4 m arm carrying two heads over the carriageway
 * (the CS2 look at avenue junctions) plus a near-side head on the pole.
 * Lens quads carry an `aLens` attribute (0 red, 1 amber, 2 green) so the material can light the
 * right aspect from the instance's phase.
 */
export function makeTrafficSignal(kind = 'post') {
  const P = new Parts();
  const lensGeos = [];
  const head = (x, y, s, hang = false) => {
    // dark-yellow backboard with a light border reads as a signal from 60 m
    P.add('signal_board', at(box(0.50 * s, 1.30 * s, 0.045 * s), x, y, -0.06 * s));
    P.add('signal_metal', at(box(0.34 * s, 1.06 * s, 0.24 * s), x, y, 0.06 * s));
    P.add('signal_metal', at(box(0.40 * s, 0.055 * s, 0.30 * s), x, y + 0.55 * s, 0.06 * s));
    P.add('signal_metal', at(box(0.40 * s, 0.055 * s, 0.30 * s), x, y - 0.55 * s, 0.06 * s));
    if (hang) P.add('signal_metal', at(box(0.09 * s, 0.16 * s, 0.09 * s), x, y + 0.63 * s, 0.06 * s));
    for (let i = 0; i < 3; i++) {
      const ly = y + (0.33 - i * 0.33) * s;
      const lens = new THREE.CircleGeometry(0.115 * s, 14);
      at(lens, x, ly, 0.185 * s);
      const g = nid(lens);
      const cnt = g.attributes.position.count;
      g.setAttribute('aLens', new THREE.BufferAttribute(new Float32Array(cnt).fill(i), 1));
      lensGeos.push(g);
      const hood = new THREE.CylinderGeometry(0.150 * s, 0.150 * s, 0.15 * s, 12, 1, true, Math.PI, Math.PI);
      hood.rotateX(Math.PI / 2);
      at(hood, x, ly + 0.012 * s, 0.25 * s);
      P.add('signal_metal', hood);
    }
  };

  P.add('signal_metal', at(cyl(0.17, 0.20, 0.16, 12), 0, 0.08, 0));
  if (kind === 'mast') {
    P.add('signal_metal', at(cyl(0.075, 0.115, 6.4, 10), 0, 3.2, 0));
    // arm reaches out along −X (the yaw puts it over the carriageway) with a gusset
    const arm = cyl(0.055, 0.075, 5.6, 8);
    arm.rotateZ(Math.PI / 2);
    P.add('signal_metal', at(arm, -2.7, 5.95, 0));
    P.add('signal_metal', at(box(0.9, 0.06, 0.06).rotateZ(-0.42), -0.5, 5.55, 0));
    head(-2.0, 5.15, 1.0, true);
    head(-4.4, 5.15, 1.0, true);
    head(0.0, 3.05, 0.82);
  } else {
    P.add('signal_metal', at(cyl(0.058, 0.078, 3.85, 10), 0, 1.93, 0));
    head(0, 3.20, 1.0);
    head(0, 1.72, 0.72);
  }
  const parts = P.finish();
  const lens = mergeGeometries(lensGeos, false);
  lens.computeBoundingSphere();
  parts.signal_lens = lens;
  return parts;
}

/* ------------------------------------------------------------------ signs */

/** Bare sign post (Ø 6 cm, 2.5 m) — panels are separate kinds so one atlas serves them all. */
export function makeSignPost(h = 2.5) {
  const P = new Parts();
  P.add('post_metal', at(cyl(0.032, 0.038, h, 8), 0, h / 2, 0));
  P.add('post_metal', at(cyl(0.07, 0.07, 0.06, 10), 0, 0.03, 0));
  return P.finish();
}

/**
 * One sign panel quad with UVs locked to a tile of the sign atlas. Faces +Z, mounted at `y`.
 * A thin aluminium backing plate sits behind it so the sign has real thickness in silhouette.
 */
export function makeSignPanel(tile, size = 0.66, y = 2.06) {
  const g = plane(size, size);
  const u0 = (tile % 4) / 4, v0 = 1 - Math.floor(tile / 4) / 4 - 0.25;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.25, v0 + uv.getY(i) * 0.25);
  at(g, 0, y, 0.052);
  const P = new Parts();
  P.add('sign_face', g);       // DoubleSide: the material greys the back face (plain aluminium)
  return P.finish();
}

/** Street-name blade (row `row` of the name atlas), mounted crosswise at the top of a post. */
export function makeNameBlade(row, len = 1.4, h = 2.98) {
  const g = plane(len, len / 4);
  const v0 = 1 - row / 8, dv = 1 / 8;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), v0 - dv + uv.getY(i) * dv);
  at(g, 0, h, 0.05);
  const P = new Parts();
  P.add('name_face', g);
  return P.finish();
}

/* ------------------------------------------------------------- bus shelter */

/** Bus shelter, 3.4 × 1.6 m, open side facing +Z (the kerb). */
export function makeBusShelter() {
  const P = new Parts();
  const W = 3.4, D = 1.6, H = 2.42;
  for (const sx of [-1, 1]) {
    P.add('shelter_metal', at(box(0.08, H, 0.1), sx * (W / 2 - 0.05), H / 2, -D / 2 + 0.06));
    P.add('shelter_metal', at(box(0.08, H, 0.1), sx * (W / 2 - 0.05), H / 2, D / 2 - 0.06));
    P.add('shelter_metal', at(box(0.07, 0.07, D), sx * (W / 2 - 0.05), H - 0.06, 0));
  }
  // roof: slight forward overhang, thin fascia
  P.add('shelter_roof', at(box(W + 0.22, 0.14, D + 0.44), 0, H + 0.07, 0.14));
  P.add('shelter_metal', at(box(W + 0.24, 0.11, 0.06), 0, H + 0.02, D / 2 + 0.3));
  // glazing: back + one side (the other side carries the poster)
  P.add('shelter_glass', at(plane(W - 0.22, H - 0.34), 0, H / 2 + 0.1, -D / 2 + 0.02));
  P.add('shelter_glass', at(plane(D - 0.2, H - 0.34), W / 2 - 0.06, H / 2 + 0.1, 0, Math.PI / 2));
  // advertising case on the left side: frame + lit poster
  P.add('shelter_metal', at(box(0.1, H - 0.2, D - 0.16), -W / 2 + 0.02, H / 2 + 0.05, 0));
  P.add('shelter_ad', at(plane(D - 0.34, H - 0.5), -W / 2 + 0.08, H / 2 + 0.08, 0, Math.PI / 2));
  P.add('shelter_ad', at(plane(D - 0.34, H - 0.5), -W / 2 - 0.02, H / 2 + 0.08, 0, -Math.PI / 2));
  // bench: three slats on two steel brackets
  for (let i = 0; i < 3; i++) P.add('wood_slat', at(box(W - 0.9, 0.055, 0.13), 0, 0.47, -D / 2 + 0.3 + i * 0.17));
  for (const sx of [-1, 1]) P.add('shelter_metal', at(box(0.06, 0.44, 0.5), sx * (W / 2 - 0.7), 0.24, -D / 2 + 0.46));
  // ceiling light strip (emissive at night)
  P.add('lamp_glow', at(box(W - 1.0, 0.05, 0.18), 0, H - 0.11, 0.1));
  return P.finish();
}

/* ------------------------------------------------- hedges, fences, bollards */

/**
 * Trimmed hedge run, 2 m along X. A tapered core box gives the mass and the flush butt joints;
 * outward leaf cards on the top and both faces break the silhouette so a garden boundary does not
 * read as an extruded green brick.
 */
export function makeHedge(seed, h = 1.05, w = 0.72) {
  const noise = new SimplexNoise(seed);
  const rng = makeRng(seed + 17);
  const P = new Parts();
  const g = new THREE.BoxGeometry(2.0, h, w, 4, 3, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ty = (y + h / 2) / h;
    const taper = 1 - 0.3 * Math.pow(Math.max(0, (ty - 0.5) / 0.5), 1.4);
    const n = noise.noise3D(x * 2.2, y * 3.1, z * 2.2);
    const flush = Math.abs(x) > 0.995;
    p.setXYZ(i, flush ? x : x * (1 + 0.05 * n), y + (y > h / 2 - 1e-3 ? 0.03 * n : 0), z * taper * (1 + 0.07 * n));
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  P.add('hedge', white(g, 0.72));

  // leaf cards: a row along the top and a few on each face
  const cards = [];
  const push = (x, y, z, dir, size, shade) => {
    cards.push(card(size, size * (0.8 + rng() * 0.3), new THREE.Vector3(x, y, z), faceQuat(dir, rng() * 6.283), dir, shade));
  };
  for (let i = 0; i < 6; i++) {
    const x = -0.82 + (i / 5) * 1.64 + (rng() - 0.5) * 0.12;
    push(x, h - 0.03 + rng() * 0.07, (rng() - 0.5) * w * 0.5, new THREE.Vector3((rng() - 0.5) * 0.5, 1, (rng() - 0.5) * 0.5).normalize(), 0.5 + rng() * 0.16, 0.9 + rng() * 0.1);
  }
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x = -0.72 + (i / 3) * 1.44 + (rng() - 0.5) * 0.15;
      const y = h * (0.35 + rng() * 0.5);
      push(x, y, sz * (w * 0.44), new THREE.Vector3((rng() - 0.5) * 0.35, 0.42, sz).normalize(), 0.42 + rng() * 0.16, 0.6 + 0.35 * (y / h));
    }
  }
  P.add('hedge_leaf', mergeGeometries(cards, false));
  return P.finish();
}

/** Painted picket fence, 2 m along X. */
export function makePicketFence() {
  const P = new Parts();
  for (const sx of [-1, 1]) P.add('fence_wood', at(box(0.09, 1.12, 0.09), sx * 0.95, 0.56, 0));
  for (const y of [0.34, 0.82]) P.add('fence_wood', at(box(1.92, 0.07, 0.045), 0, y, 0));
  for (let i = 0; i < 9; i++) {
    const x = -0.86 + i * 0.215;
    P.add('fence_wood', at(box(0.075, 0.95, 0.028), x, 0.5, 0.01));
    P.add('fence_wood', at(box(0.075, 0.075, 0.028).rotateZ(Math.PI / 4), x, 0.98, 0.01));
  }
  return P.finish();
}

/** Chain-link fence panel, 2 m along X (alpha-cut fabric + posts + top rail). */
export function makeChainFence(h = 2.1) {
  const P = new Parts();
  for (const sx of [-1, 1]) P.add('fence_metal', at(cyl(0.035, 0.035, h, 8), sx * 0.98, h / 2, 0));
  P.add('fence_metal', at(cyl(0.028, 0.028, 1.96, 6).rotateZ(Math.PI / 2), 0, h - 0.06, 0));
  const fabric = plane(1.96, h - 0.12);
  const uv = fabric.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (h - 0.12) / 1.0);
  at(fabric, 0, (h - 0.12) / 2 + 0.02, 0);
  P.add('fence_chain', fabric);
  return P.finish();
}

/** Short steel bollard. */
export function makeBollard() {
  const P = new Parts();
  P.add('post_metal', at(cyl(0.075, 0.085, 0.95, 10), 0, 0.475, 0));
  P.add('post_metal', at(new THREE.SphereGeometry(0.076, 10, 6), 0, 0.95, 0));
  P.add('lamp_glow', at(cyl(0.079, 0.079, 0.05, 10), 0, 0.8, 0));
  return P.finish();
}

/** Cycle stand (Sheffield hoop) — two hoops on a shared plinth, 0.75 m tall. */
export function makeCycleStand() {
  const P = new Parts();
  const hoop = new THREE.TorusGeometry(0.33, 0.028, 6, 16, Math.PI);
  P.add('post_metal', at(hoop, 0, 0.42, 0));
  P.add('post_metal', at(cyl(0.028, 0.028, 0.44, 6), -0.33, 0.21, 0));
  P.add('post_metal', at(cyl(0.028, 0.028, 0.44, 6), 0.33, 0.21, 0));
  return P.finish();
}

/** Newspaper / recycling box pair — a bit of clutter for commercial kerbs. */
export function makeNewsBox() {
  const P = new Parts();
  P.add('news_body', at(box(0.42, 0.72, 0.36), 0, 0.44, 0));
  P.add('post_metal', at(box(0.06, 0.36, 0.06), -0.16, 0.18, 0));
  P.add('post_metal', at(box(0.06, 0.36, 0.06), 0.16, 0.18, 0));
  P.add('shelter_glass', at(plane(0.28, 0.3), 0, 0.58, 0.182));
  return P.finish();
}

/** Driveway / forecourt apron: a flat 2.7 × 5.4 m slab lying on the ground, ragged-edged by its map. */
export function makeApron(w = 2.7, d = 5.4) {
  const g = plane(w, d);
  g.rotateX(-Math.PI / 2);
  const P = new Parts();
  P.add('apron', g);
  return P.finish();
}

/** Camera-facing quad used for the lamp halo (billboarded in the vertex shader). */
export function makeHaloQuad() {
  return plane(1, 1);
}
