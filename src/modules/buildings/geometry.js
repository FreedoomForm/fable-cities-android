/**
 * Unit geometries for the instanced building parts. Every geometry has its base at y = 0 and spans
 * [-0.5, 0.5] on x/z so an instance matrix of scale (w, h, d) yields a w × h × d metre part.
 */
import * as THREE from 'three';

function tri(pos, nrm, uv, a, b, c, n, ua, ub, uc) {
  pos.push(...a, ...b, ...c);
  nrm.push(...n, ...n, ...n);
  uv.push(...ua, ...ub, ...uc);
}
function quad(pos, nrm, uv, a, b, c, d, n, ua, ub, uc, ud) {
  tri(pos, nrm, uv, a, b, c, n, ua, ub, uc);
  tri(pos, nrm, uv, a, c, d, n, ua, uc, ud);
}
function faceNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
function build(pos, nrm, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Gable roof: ridge along x at y = 1, eaves at z = ±0.5. u along the ridge, v from eave (0) to ridge (1). */
export function gableGeometry() {
  const pos = [], nrm = [], uv = [];
  const A = [-0.5, 0, 0.5], B = [0.5, 0, 0.5], C = [0.5, 1, 0], D = [-0.5, 1, 0];
  const E = [0.5, 0, -0.5], F = [-0.5, 0, -0.5];
  quad(pos, nrm, uv, A, B, C, D, faceNormal(A, B, C), [0, 0], [1, 0], [1, 1], [0, 1]);       // +z slope
  quad(pos, nrm, uv, E, F, D, C, faceNormal(E, F, D), [0, 0], [1, 0], [1, 1], [0, 1]);       // -z slope
  tri(pos, nrm, uv, B, E, C, [1, 0, 0], [0, 0], [1, 0], [0.5, 1]);                           // +x gable end
  tri(pos, nrm, uv, F, A, D, [-1, 0, 0], [0, 0], [1, 0], [0.5, 1]);                          // -x gable end
  quad(pos, nrm, uv, F, E, B, A, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);               // soffit
  return build(pos, nrm, uv);
}

/** Hip roof: ridge along x from -0.5+r to 0.5-r at y = 1 (r = 0.5 → pyramid). */
export function hipGeometry(r = 0.25) {
  const pos = [], nrm = [], uv = [];
  const A = [-0.5, 0, 0.5], B = [0.5, 0, 0.5], E = [0.5, 0, -0.5], F = [-0.5, 0, -0.5];
  const R1 = [-0.5 + r, 1, 0], R2 = [0.5 - r, 1, 0];
  if (r >= 0.499) {
    const T = [0, 1, 0];
    tri(pos, nrm, uv, A, B, T, faceNormal(A, B, T), [0, 0], [1, 0], [0.5, 1]);
    tri(pos, nrm, uv, E, F, T, faceNormal(E, F, T), [0, 0], [1, 0], [0.5, 1]);
    tri(pos, nrm, uv, B, E, T, faceNormal(B, E, T), [0, 0], [1, 0], [0.5, 1]);
    tri(pos, nrm, uv, F, A, T, faceNormal(F, A, T), [0, 0], [1, 0], [0.5, 1]);
  } else {
    quad(pos, nrm, uv, A, B, R2, R1, faceNormal(A, B, R2), [0, 0], [1, 0], [1 - r, 1], [r, 1]);
    quad(pos, nrm, uv, E, F, R1, R2, faceNormal(E, F, R1), [0, 0], [1, 0], [1 - r, 1], [r, 1]);
    tri(pos, nrm, uv, B, E, R2, faceNormal(B, E, R2), [0, 0], [1, 0], [0.5, 1]);
    tri(pos, nrm, uv, F, A, R1, faceNormal(F, A, R1), [0, 0], [1, 0], [0.5, 1]);
  }
  quad(pos, nrm, uv, F, E, B, A, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  return build(pos, nrm, uv);
}

/** Wedge (awning / shed roof): full height at z = -0.5 sloping to 0 at z = +0.5. */
export function wedgeGeometry() {
  const pos = [], nrm = [], uv = [];
  const A = [-0.5, 0, 0.5], B = [0.5, 0, 0.5], E = [0.5, 0, -0.5], F = [-0.5, 0, -0.5];
  const G = [0.5, 1, -0.5], H = [-0.5, 1, -0.5];
  quad(pos, nrm, uv, A, B, G, H, faceNormal(A, B, G), [0, 0], [1, 0], [1, 1], [0, 1]);   // slope
  quad(pos, nrm, uv, E, F, H, G, [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);            // back
  tri(pos, nrm, uv, B, E, G, [1, 0, 0], [0, 0], [1, 0], [1, 1]);
  tri(pos, nrm, uv, F, A, H, [-1, 0, 0], [0, 0], [1, 0], [0, 1]);
  quad(pos, nrm, uv, F, E, B, A, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  return build(pos, nrm, uv);
}

export function makeGeometries() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
  cyl.translate(0, 0.5, 0);
  const cylLow = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1);
  cylLow.translate(0, 0.5, 0);
  const cone = new THREE.ConeGeometry(0.5, 1, 10, 1);
  cone.translate(0, 0.5, 0);
  const dome = new THREE.SphereGeometry(0.5, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 2, 1); // unit height
  const blob = new THREE.SphereGeometry(0.5, 7, 3, 0, Math.PI * 2, 0, Math.PI * 0.62);
  blob.scale(1, 1 / 0.6, 1);
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2);
  const panel = new THREE.PlaneGeometry(1, 1); // vertical, facing +z, base at y = 0
  panel.translate(0, 0.5, 0);
  return {
    box, cyl, cylLow, cone, dome, blob, plane, panel,
    gable: gableGeometry(),
    hip50: hipGeometry(0.5), hip35: hipGeometry(0.35), hip25: hipGeometry(0.25),
    wedge: wedgeGeometry(),
  };
}
