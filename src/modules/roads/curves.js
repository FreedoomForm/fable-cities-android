/**
 * Curve helpers for the road network.
 *
 * `RoadCurve` wraps a base THREE curve (line / quadratic / cubic Bézier / Catmull-Rom) and exposes
 * an *arc-length parametrised* sub-range [u0, u1] of it. Splitting a road at a crossing therefore
 * never changes the underlying shape — both halves keep sampling the same base curve.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class RoadCurve extends THREE.Curve {
  constructor(base, u0 = 0, u1 = 1) {
    super();
    this.isRoadCurve = true;
    this.base = base;
    this.u0 = u0;
    this.u1 = u1;
    this.arcLengthDivisions = 32;
  }
  getPoint(t, target = new THREE.Vector3()) {
    return this.base.getPointAt(this.u0 + (this.u1 - this.u0) * t, target);
  }
  getPointAt(u, target) { return this.getPoint(u, target); }
  getTangentAt(u, target) { return this.getTangent(u, target); }
  getLength() { return this.base.getLength() * (this.u1 - this.u0); }
  /** Split at arc-length fraction t ∈ (0,1) → [first, second]. */
  split(t) {
    const um = this.u0 + (this.u1 - this.u0) * t;
    return [new RoadCurve(this.base, this.u0, um), new RoadCurve(this.base, um, this.u1)];
  }
  /** Sub-range [ta, tb] (arc-length fractions of this curve). */
  slice(ta, tb) {
    const d = this.u1 - this.u0;
    return new RoadCurve(this.base, this.u0 + d * ta, this.u0 + d * tb);
  }
}

/** Give a base curve enough arc-length divisions for accurate getPointAt(). */
export function prepareBase(curve) {
  curve.arcLengthDivisions = 200;
  const len = curve.getLength();
  curve.arcLengthDivisions = Math.max(64, Math.min(4096, Math.ceil(len * 1.5)));
  curve.updateArcLengths();
  return curve;
}

const P = (p) => new THREE.Vector3(p.x, 0, p.z);

/**
 * Build road curve pieces from control points.
 * mode 'straight': one line per consecutive pair. 'bezier': 3 pts → quadratic, 4 pts → cubic (single
 * piece), otherwise Catmull-Rom. 'catmull': Catmull-Rom through all points, one piece per span.
 * Returns [{ curve: RoadCurve, ia, ib }] where ia/ib index the control points that become nodes.
 */
export function makeCurvePieces(pts, mode = 'straight') {
  const n = pts.length;
  const pieces = [];
  if (n < 2) return pieces;
  if (mode === 'bezier' && n === 3) {
    const base = prepareBase(new THREE.QuadraticBezierCurve3(P(pts[0]), P(pts[1]), P(pts[2])));
    pieces.push({ curve: new RoadCurve(base), ia: 0, ib: 2 });
    return pieces;
  }
  if (mode === 'bezier' && n === 4) {
    const base = prepareBase(new THREE.CubicBezierCurve3(P(pts[0]), P(pts[1]), P(pts[2]), P(pts[3])));
    pieces.push({ curve: new RoadCurve(base), ia: 0, ib: 3 });
    return pieces;
  }
  if ((mode === 'bezier' || mode === 'catmull') && n >= 3) {
    const base = new THREE.CatmullRomCurve3(pts.map(P), false, 'centripetal', 0.5);
    const spans = n - 1;
    const div = spans * 64;
    base.arcLengthDivisions = div;
    const lengths = base.getLengths(div);
    const total = lengths[div];
    for (let i = 0; i < spans; i++) {
      const u0 = lengths[i * 64] / total, u1 = lengths[(i + 1) * 64] / total;
      pieces.push({ curve: new RoadCurve(base, u0, u1), ia: i, ib: i + 1 });
    }
    return pieces;
  }
  for (let i = 0; i < n - 1; i++) {
    const base = prepareBase(new THREE.LineCurve3(P(pts[i]), P(pts[i + 1])));
    pieces.push({ curve: new RoadCurve(base), ia: i, ib: i + 1 });
  }
  return pieces;
}

/** Which control points of a build become nodes for the given mode. */
export function anchorIndices(n, mode) {
  if (mode === 'bezier' && (n === 3 || n === 4)) return [0, n - 1];
  const out = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

/** 2D segment intersection (XZ). Returns { t, u } params along (a→b) and (c→d) or null. */
export function segSegIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { t, u };
}

/**
 * Closest point on a sampled polyline. `xs`,`zs` are Float64Arrays of uniformly spaced samples
 * (spacing `ds`, total length `len`). Returns { d2, t, x, z, i } with t = arc-length fraction.
 */
export function closestOnPolyline(xs, zs, ds, len, px, pz) {
  let best = { d2: Infinity, t: 0, x: xs[0], z: zs[0], i: 0 };
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz;
    let f = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const x = ax + vx * f, z = az + vz * f;
    const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d2 < best.d2) best = { d2, t: Math.min(1, ((i + f) * ds) / len), x, z, i };
  }
  return best;
}

export function headingOf(dx, dz) { return Math.atan2(dx, -dz); } // 0 = north (−Z), clockwise positive
export function wrapPi(a) { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }
export function wrapTau(a) { a = a % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a; }
export { _v as tmpVec3 };
