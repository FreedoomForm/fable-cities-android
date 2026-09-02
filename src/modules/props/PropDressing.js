/**
 * props — ground cover and lot dressing geometry.
 *
 * The pieces a Cities: Skylines II frame is full of and ours was missing: grass tufts and
 * undergrowth (four species, so a lawn is never one flat green), ground decals (contact occlusion,
 * night light pools, garden paths, planting beds), and the small yard/street furniture that makes a
 * suburb read as lived-in — mailboxes, wheelie bins, utility cabinets, shop A-boards, stones.
 *
 * Same conventions as PropGeometry: origin on the ground under the object, +Y up, +Z facing,
 * one merged BufferGeometry per material key.
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';
import { Parts, box, cyl, plane, at } from './PropGeometry.js';

/** A ground-aligned unit quad (scaled per instance). Used by every decal kind. */
export function makeGroundQuad(matKey) {
  const g = plane(1, 1);
  g.rotateX(-Math.PI / 2);
  const P = new Parts();
  P.add(matKey, g);
  return P.finish();
}

/** Card tuft of grass/undergrowth: crossed alpha planes, splayed and tilted so no two read alike. */
export function makeGrassTuft(seed, style = 0, matKey = 'tuft_a') {
  const rng = makeRng(seed * 29 + 11);
  const R = (a, b) => a + rng() * (b - a);
  const P = new Parts();
  const spec = [
    // Cards are wide and low: one instance has to cover ~1 m2 of ground, because a whole district's
    // worth of ground cover has to fit in a placement list the culling pass can walk every frame.
    { n: 3, w: [1.00, 1.45], h: [0.34, 0.50], spread: 0.26, tilt: 0.09 },   // fine lawn
    { n: 3, w: [0.85, 1.25], h: [0.55, 0.80], spread: 0.30, tilt: 0.12 },   // tall meadow
    { n: 3, w: [0.95, 1.35], h: [0.28, 0.44], spread: 0.32, tilt: 0.16 },   // dry weedy
    { n: 3, w: [0.90, 1.30], h: [0.40, 0.60], spread: 0.28, tilt: 0.11 },   // flowering
  ][style];
  for (let i = 0; i < spec.n; i++) {
    const w = R(spec.w[0], spec.w[1]), h = R(spec.h[0], spec.h[1]);
    const yaw = (i / spec.n) * Math.PI + R(-0.25, 0.25);
    const g = plane(w, h);
    g.translate(0, h * 0.5, 0);
    g.rotateZ(R(-spec.tilt, spec.tilt));
    g.rotateY(yaw);
    g.translate(R(-spec.spread, spec.spread), -0.02, R(-spec.spread, spec.spread));
    // shading normal tipped toward the sky: a blade card lit purely edge-on goes black in shadow,
    // which is what makes cheap grass cards read as flat cut-outs
    const n = new THREE.Vector3(Math.sin(yaw) * 0.42, 1, Math.cos(yaw) * 0.42).normalize();
    const na = g.attributes.normal;
    for (let k = 0; k < na.count; k++) na.setXYZ(k, n.x, n.y, n.z);
    P.add(matKey, g);
  }
  return P.finish();
}

/** Field stone: a jittered low icosahedron, half-buried. */
export function makeRock(seed) {
  const rng = makeRng(seed * 7 + 5);
  const g = new THREE.IcosahedronGeometry(0.30, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const s = 0.72 + rng() * 0.55;
    pos.setXYZ(i, pos.getX(i) * s * 1.25, Math.max(-0.06, pos.getY(i) * s * 0.62), pos.getZ(i) * s * 1.1);
  }
  g.computeVertexNormals();
  g.translate(0, 0.11, 0);
  const P = new Parts();
  P.add('stone', g);
  return P.finish();
}

/** Kerbside mailbox: a painted box on a timber post. */
export function makeMailbox() {
  const P = new Parts();
  P.add('fence_wood', at(box(0.09, 1.05, 0.09), 0, 0.52, 0));
  P.add('mail_body', at(box(0.28, 0.24, 0.44), 0, 1.15, 0.03));
  P.add('mail_body', at(cyl(0.14, 0.14, 0.28, 10), 0, 1.27, 0.03, 0, 0, Math.PI / 2));
  P.add('post_metal', at(box(0.03, 0.16, 0.03), 0.16, 1.34, 0.03));
  return P.finish();
}

/** Wheelie bin: tapered body, hinged lid, two wheels. */
export function makeWheelieBin() {
  const P = new Parts();
  const body = new THREE.CylinderGeometry(0.30, 0.255, 0.92, 4, 1);
  body.rotateY(Math.PI / 4);
  P.add('bin_plastic', at(body, 0, 0.50, 0));
  const lid = new THREE.CylinderGeometry(0.315, 0.30, 0.07, 4, 1);
  lid.rotateY(Math.PI / 4);
  P.add('bin_plastic', at(lid, 0, 0.99, 0, 0, -0.10));
  P.add('bin_plastic', at(box(0.30, 0.045, 0.05), 0, 1.02, -0.30));
  for (const sx of [-1, 1]) {
    const w = cyl(0.075, 0.075, 0.05, 8);
    w.rotateZ(Math.PI / 2);
    P.add('car_dark', at(w, sx * 0.21, 0.075, 0.17));
  }
  return P.finish();
}

/** Street utility cabinet on a concrete plinth (telecom / signal control). */
export function makeUtilityBox() {
  const P = new Parts();
  P.add('signal_metal', at(box(0.86, 0.09, 0.48), 0, 0.045, 0));
  P.add('signal_metal', at(box(0.74, 1.18, 0.38), 0, 0.68, 0));
  P.add('signal_metal', at(box(0.79, 0.06, 0.43), 0, 1.30, 0));
  P.add('post_metal', at(box(0.03, 0.13, 0.02), 0.24, 0.72, 0.20));   // lock hasp
  return P.finish();
}

/** Shopfront A-board: two chalk panels hinged at the top. */
export function makeAboard() {
  const P = new Parts();
  for (const s2 of [-1, 1]) {
    P.add('signal_board', at(box(0.62, 0.88, 0.035), 0, 0.46, s2 * 0.17, 0, s2 * 0.19));
    P.add('wood_slat', at(box(0.66, 0.05, 0.05), 0, 0.055, s2 * 0.30));
  }
  P.add('wood_slat', at(box(0.66, 0.06, 0.10), 0, 0.90, 0));
  return P.finish();
}

/** Trellis / garden arch panel used to break up long rear boundaries. */
export function makeGardenShed() {
  const P = new Parts();
  P.add('wood_slat', at(box(2.10, 1.80, 1.60), 0, 0.90, 0));
  const roof = box(2.30, 0.10, 1.80);
  P.add('shelter_roof', at(roof, 0, 1.88, 0, 0, 0, 0.06));
  P.add('fence_wood', at(box(0.62, 1.30, 0.04), 0, 0.66, 0.81));
  return P.finish();
}
