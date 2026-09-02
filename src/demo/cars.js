/**
 * demo — parked vehicles.
 *
 * The traffic module owns everything that moves; this is the static population that fills off-street
 * car parks, loading bays and the port apron, so a downtown block reads as used rather than empty.
 * Three silhouettes (hatch, estate, van) with a per-instance paint tint, all merged into the demo's
 * shared paint/glass/metal meshes, so a hundred cars cost no extra draw calls.
 */
import { box, cyl, at, lin } from './gfx.js';

const PAINT = [
  '#b9bcc0', '#8d9096', '#2f3338', '#6d2e2a', '#26405c', '#4a5a45',
  '#a89a86', '#d8d5cf', '#3c3f46', '#7a6a58', '#1f4a58', '#8a2f2f',
].map(lin);
const GLASS = lin('#171c22');
const TYRE = lin('#141416');
const TRIM = lin('#2a2c30');

/** local (along, across) offset → world delta for a body rotated by `yaw` (long axis = local +X). */
const off = (yaw, a, c) => ({ dx: Math.cos(yaw) * a + Math.sin(yaw) * c, dz: -Math.sin(yaw) * a + Math.cos(yaw) * c });

function wheel(b, x, y, z, yaw, a, c, r, w) {
  const g = cyl(r, r, w, 5, 1.2, TYRE);
  g.rotateX(Math.PI / 2);            // axle along local Z (across the body)
  const o = off(yaw, a, c);
  b.push('metal', at(g, x + o.dx, y + r, z + o.dz, yaw));
}

/**
 * @param {*} b     geometry bucket
 * @param {*} rng   seeded rng
 * @param {number} x,y,z ground contact point
 * @param {number} yaw   heading (long axis = local +X)
 */
export function addParkedCar(b, rng, x, y, z, yaw) {
  const kind = rng();
  const paint = PAINT[(rng() * PAINT.length) | 0];
  const L = kind < 0.4 ? 3.9 : kind < 0.75 ? 4.55 : 5.1;   // hatch / estate / van
  const W = kind < 0.75 ? 1.8 : 2.0;
  const bodyH = kind < 0.75 ? 0.72 : 0.95;
  const wheelR = 0.33;
  const sill = wheelR + 0.14;

  b.push('paint', at(box(L, bodyH, W, 2.2, paint), x, y + sill + bodyH / 2, z, yaw));
  const cabL = kind < 0.4 ? L * 0.46 : kind < 0.75 ? L * 0.52 : L * 0.72;
  const cabH = kind < 0.75 ? 0.62 : 0.98;
  const cabA = kind < 0.75 ? -L * 0.06 : L * 0.04;
  const o = off(yaw, cabA, 0);
  b.push('glass', at(box(cabL, cabH, W * 0.9, 2, GLASS), x + o.dx, y + sill + bodyH + cabH / 2, z + o.dz, yaw));
  b.push('paint', at(box(cabL * 0.94, 0.1, W * 0.88, 2, paint), x + o.dx, y + sill + bodyH + cabH, z + o.dz, yaw));
  for (const sa of [-1, 1]) for (const sc of [-1, 1]) wheel(b, x, y, z, yaw, L * 0.31 * sa, W * 0.46 * sc, wheelR, 0.22);
}

/** A box truck / lorry for the industrial estate and the port. */
export function addTruck(b, rng, x, y, z, yaw) {
  const paint = PAINT[(rng() * PAINT.length) | 0];
  const boxL = 7.5 + rng() * 3;
  const cab = off(yaw, 0, 0), win = off(yaw, 1.3, 0), body = off(yaw, -(boxL / 2 + 1.4), 0);
  b.push('paint', at(box(2.6, 1.9, 2.35, 2, paint), x + cab.dx, y + 1.35, z + cab.dz, yaw));
  b.push('glass', at(box(0.14, 0.85, 2.1, 2, GLASS), x + win.dx, y + 1.92, z + win.dz, yaw));
  b.push('paint', at(box(boxL, 2.7, 2.5, 2.4, lin('#c8c5bc')), x + body.dx, y + 1.95, z + body.dz, yaw));
  const chassis = off(yaw, -boxL * 0.45, 0);
  b.push('metal', at(box(boxL + 3.0, 0.34, 2.3, 2, TRIM), x + chassis.dx, y + 0.62, z + chassis.dz, yaw));
  for (const a of [1.15, -1.9, -boxL * 0.72]) for (const sc of [-1, 1]) wheel(b, x, y, z, yaw, a, 1.05 * sc, 0.5, 0.3);
}
