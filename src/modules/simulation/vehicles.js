/**
 * Procedural service-fleet vehicles at real-world proportions (car 4.6 × 1.8 × 1.45 m, fire engine
 * 8.5 × 2.5 × 3.4 m …), built from the same PBR material keys as the buildings so they merge into
 * the per-material batches. Local space: origin on the ground under the vehicle centre, nose = +Z.
 * Replaces the Kenney cartoon kit (bulbous cabs, oversize wheels) that broke the material language.
 */
import * as THREE from 'three';
import { box, cylinder, quad, place } from './recipes.js';

/** Box whose top face is pulled inwards: sloped windscreen (+Z) and rear window (−Z). */
function cabin(len, h, w, frontSlope, backSlope, sideTuck = 0.06) {
  const g = new THREE.BoxGeometry(len === undefined ? 1 : w, h, len);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      const z = p.getZ(i);
      p.setZ(i, z > 0 ? z - frontSlope : z + backSlope);
      p.setX(i, p.getX(i) * (1 - sideTuck));
    }
  }
  g.computeVertexNormals();
  return g;
}
function wheel(P, x, z, r, tw = 0.24) {
  P.push('tyre', place(cylinder(r, r, tw, 1, 14).rotateZ(Math.PI / 2), x, r, z));
  P.push('plates', place(cylinder(r * 0.55, r * 0.55, tw + 0.02, 1, 12).rotateZ(Math.PI / 2), x, r, z));
}
function wheels(P, halfW, zs, r, tw) { for (const z of zs) { wheel(P, -halfW, z, r, tw); wheel(P, halfW, z, r, tw); } }
function lights(P, w, zFront, y, zBack) {
  for (const s of [-1, 1]) {
    P.push('lamp', place(box(0.34, 0.14, 0.04, 1), s * (w / 2 - 0.3), y, zFront + 0.005));
    P.push('warning', place(box(0.3, 0.12, 0.04, 1), s * (w / 2 - 0.28), y, zBack - 0.005));
  }
}
function lightBar(P, x, y, z, w = 1.1) {
  P.push('dark_metal', place(box(w, 0.1, 0.32, 1), x, y + 0.05, z));
  P.push('warning', place(box(w / 2 - 0.05, 0.14, 0.28, 1), x - w / 4, y + 0.17, z));
  P.push('siren', place(box(w / 2 - 0.05, 0.14, 0.28, 1), x + w / 4, y + 0.17, z));
}
/** Window band glued to a cabin: dark glass quads on the four faces, slightly inset. */
function glazing(P, x, y, z, len, h, w, ry = 0) {
  P.push('veh_glass', place(quad(w - 0.2, h), x, y, z + len / 2 + 0.01, ry));
  P.push('veh_glass', place(quad(w - 0.2, h), x, y, z - len / 2 - 0.01, ry + Math.PI));
  P.push('veh_glass', place(quad(len - 0.25, h), x + w / 2 + 0.01, y, z, ry + Math.PI / 2));
  P.push('veh_glass', place(quad(len - 0.25, h), x - w / 2 - 0.01, y, z, ry - Math.PI / 2));
}

function car(P, paint, len = 4.6, w = 1.8, opts = {}) {
  const clear = 0.32, bodyH = opts.bodyH ?? 0.56, cabLen = opts.cabLen ?? len * 0.5, cabH = opts.cabH ?? 0.52, cabZ = opts.cabZ ?? -0.15;
  P.push(paint, place(box(w, bodyH, len, 2), 0, clear + bodyH / 2, 0));
  P.push('dark_metal', place(box(w - 0.1, 0.16, len + 0.08, 1), 0, clear + 0.06, 0)); // sills / bumpers
  P.push(paint, place(cabin(cabLen, cabH, w - 0.14, 0.62, 0.4), 0, clear + bodyH + cabH / 2, cabZ));
  glazing(P, 0, clear + bodyH + cabH * 0.55, cabZ, cabLen - 0.5, cabH * 0.62, w - 0.22);
  P.push('veh_glass', place(quad(w - 0.4, cabH * 0.8).rotateX(-0.55), 0, clear + bodyH + cabH * 0.5, cabZ + cabLen / 2 - 0.28));
  P.push('veh_glass', place(quad(w - 0.4, cabH * 0.7).rotateX(0.5), 0, clear + bodyH + cabH * 0.5, cabZ - cabLen / 2 + 0.2, Math.PI));
  lights(P, w, len / 2, clear + bodyH * 0.6, -len / 2);
  P.push('dark', place(box(w * 0.6, 0.12, 0.05, 1), 0, clear + bodyH * 0.25, len / 2 + 0.01)); // grille
  wheels(P, w / 2 - 0.08, [len * 0.32, -len * 0.32], opts.r ?? 0.33);
  P.push('plates', place(box(0.16, 0.02, 0.9, 1), -w / 2 + 0.04, clear + bodyH * 0.55, 0.3)); // door trim
  P.push('plates', place(box(0.16, 0.02, 0.9, 1), w / 2 - 0.04, clear + bodyH * 0.55, 0.3));
}
function van(P, paint, len, w, h, opts = {}) {
  const clear = 0.36, cabLen = opts.cabLen ?? 1.9;
  P.push('dark_metal', place(box(w - 0.2, 0.3, len - 0.4, 1), 0, clear + 0.12, 0)); // chassis
  P.push(paint, place(box(w, h - clear - 0.2, len - cabLen, 2), 0, clear + (h - clear - 0.2) / 2 + 0.2, -cabLen / 2)); // body
  P.push(paint, place(cabin(cabLen, h - clear - 0.6, w, 0.55, 0.0, 0.03), 0, clear + (h - clear - 0.6) / 2 + 0.2, len / 2 - cabLen / 2));
  P.push(paint, place(box(w, 0.7, cabLen, 2), 0, clear + 0.55, len / 2 - cabLen / 2)); // bonnet block
  const gy = clear + 0.2 + (h - clear - 0.6) * 0.62;
  P.push('veh_glass', place(quad(w - 0.3, 0.9).rotateX(-0.5), 0, gy + 0.15, len / 2 - 0.36));
  for (const s of [-1, 1]) P.push('veh_glass', place(quad(1.1, 0.8), s * (w / 2 + 0.01), gy + 0.1, len / 2 - cabLen / 2 - 0.1, s * Math.PI / 2));
  if (opts.sideWindows) for (const s of [-1, 1]) P.push('veh_glass', place(quad(len - cabLen - 1.2, 0.7), s * (w / 2 + 0.01), h - 0.85, -cabLen / 2 - 0.1, s * Math.PI / 2));
  P.push('veh_glass', place(quad(w - 0.5, 0.7), 0, h - 0.8, -len / 2 - 0.01, Math.PI)); // rear window
  lights(P, w, len / 2, clear + 0.55, -len / 2);
  P.push('dark', place(box(w * 0.55, 0.16, 0.05, 1), 0, clear + 0.35, len / 2 + 0.01));
  wheels(P, w / 2 - 0.1, [len / 2 - 1.1, -len / 2 + 1.3], opts.r ?? 0.37, 0.26);
  return { clear, cabLen };
}
/** Heavy truck: separate cab + body, six wheels. Returns body extents for decoration. */
function truck(P, cabPaint, bodyPaint, len, w, h, bodyH, opts = {}) {
  const clear = 0.55, cabLen = 2.3, cabH = opts.cabH ?? 2.1, fl = clear + 0.35;
  P.push('dark_metal', place(box(w - 0.5, 0.35, len - 0.6, 1), 0, clear + 0.15, 0)); // frame
  P.push(cabPaint, place(cabin(cabLen, cabH, w, 0.45, 0.0, 0.02), 0, fl + cabH / 2, len / 2 - cabLen / 2));
  P.push('dark_metal', place(box(w, 0.3, 0.3, 1), 0, fl + 0.05, len / 2 + 0.05)); // bumper
  P.push('veh_glass', place(quad(w - 0.4, 1.0).rotateX(-0.42), 0, fl + cabH * 0.66, len / 2 - 0.28));
  for (const s of [-1, 1]) P.push('veh_glass', place(quad(1.2, 0.85), s * (w / 2 + 0.01), fl + cabH * 0.66, len / 2 - cabLen / 2, s * Math.PI / 2));
  P.push('dark', place(box(w * 0.6, 0.35, 0.05, 1), 0, fl + 0.6, len / 2 + 0.01)); // grille
  lights(P, w, len / 2, fl + 0.32, -len / 2);
  const bodyLen = len - cabLen - 0.3, bz = -cabLen / 2 - 0.15;
  P.push(bodyPaint, place(box(w, bodyH, bodyLen, 2), 0, fl + bodyH / 2, bz));
  wheels(P, w / 2 - 0.15, [len / 2 - 1.3, -len / 2 + 1.1, -len / 2 + 2.3], opts.r ?? 0.5, 0.34);
  // mirrors, exhaust
  for (const s of [-1, 1]) P.push('dark_metal', place(box(0.1, 0.4, 0.2, 1), s * (w / 2 + 0.2), fl + cabH * 0.7, len / 2 - 0.4));
  P.push('plates', place(cylinder(0.06, 0.06, cabH + 0.6, 1, 8), -w / 2 - 0.1, fl + (cabH + 0.6) / 2 + 0.1, len / 2 - cabLen - 0.05));
  return { fl, bodyLen, bz, bodyH, cabLen, cabH };
}

export const VEHICLE_BUILDERS = {
  sedan(P, rng) { car(P, rng.pick(['veh_silver', 'veh_grey', 'veh_blue', 'veh_white', 'veh_red_dark'])); },
  suv(P, rng) { car(P, rng.pick(['veh_grey', 'veh_black', 'veh_silver']), 4.85, 1.9, { bodyH: 0.72, cabH: 0.6, cabLen: 2.7, cabZ: -0.3, r: 0.38 }); },
  police(P) {
    car(P, 'veh_white', 4.7, 1.85, { cabLen: 2.3 });
    for (const s of [-1, 1]) P.push('veh_police', place(box(0.02, 0.32, 2.2, 1), s * (1.85 / 2 + 0.005), 0.72, 0.1)); // livery stripe
    P.push('veh_police', place(box(1.0, 0.02, 0.6, 1), 0, 0.32 + 0.56 + 0.011, 1.75)); // bonnet
    lightBar(P, 0, 0.32 + 0.56 + 0.52, -0.15, 1.2);
  },
  ambulance(P) {
    van(P, 'veh_white', 6.4, 2.2, 2.65);
    for (const s of [-1, 1]) P.push('paint_fire', place(box(0.02, 0.34, 3.9, 1), s * (2.2 / 2 + 0.005), 1.35, -1.0)); // red band
    P.push('paint_fire', place(box(2.24, 0.16, 0.02, 1), 0, 1.35, -6.4 / 2 - 0.005));
    lightBar(P, 0, 2.65, 1.1, 1.6);
    P.push('warning', place(box(0.6, 0.12, 0.2, 1), 0, 2.6, -3.0));
    P.push('veh_reflect', place(quad(2.0, 1.15), 0, 1.05, -6.4 / 2 - 0.02, Math.PI));
    for (const s of [-1, 1]) P.push('veh_marker', place(box(0.14, 0.11, 0.05, 1), s * 0.9, 2.4, -6.4 / 2 - 0.03));
  },
  van(P, rng) { van(P, rng.pick(['veh_white', 'veh_silver', 'veh_blue']), 5.3, 2.0, 2.35, { sideWindows: rng.chance(0.4) }); },
  firetruck(P) {
    const t = truck(P, 'veh_fire', 'veh_fire', 8.5, 2.5, 3.4, 2.2, { cabH: 2.3, r: 0.52 });
    const top = t.fl + t.bodyH;
    // equipment lockers with roller doors, white belt line, ladder gantry, light bars
    for (const s of [-1, 1]) {
      P.push('roller', place(quad(t.bodyLen - 0.6, 1.6, 0, (t.bodyLen - 0.6) / 1, 0, 1.6), s * (2.5 / 2 + 0.01), t.fl + 1.15, t.bz, s * Math.PI / 2));
      P.push('paint_white', place(box(0.02, 0.28, t.bodyLen, 1), s * (2.5 / 2 + 0.005), t.fl + t.bodyH - 0.2, t.bz));
    }
    P.push('paint_white', place(box(2.52, 0.28, 0.02, 1), 0, t.fl + 1.1, 8.5 / 2 - t.cabLen + 0.01)); // cab stripe
    P.push('plates', place(box(2.3, 0.08, t.bodyLen - 0.4, 1), 0, top + 0.04, t.bz)); // deck
    for (const s of [-0.45, 0.45]) P.push('plates', place(box(0.08, 0.08, 6.4, 1), s, top + 0.5, t.bz - 0.2));
    for (let i = 0; i < 9; i++) P.push('plates', place(box(0.95, 0.06, 0.06, 1), 0, top + 0.5, t.bz - 3.2 + i * 0.75));
    for (const s of [-0.45, 0.45]) P.push('dark_metal', place(box(0.1, 0.42, 0.1, 1), s, top + 0.25, t.bz - 3.0));
    for (const s of [-0.45, 0.45]) P.push('dark_metal', place(box(0.1, 0.42, 0.1, 1), s, top + 0.25, t.bz + 2.8));
    lightBar(P, 0, t.fl + t.cabH + 0.05, 8.5 / 2 - t.cabLen / 2 - 0.2, 1.8);
    P.push('warning', place(box(1.4, 0.12, 0.14, 1), 0, top + 0.18, t.bz - t.bodyLen / 2 + 0.1));
    P.push('plates', place(cylinder(0.14, 0.14, 0.5, 1, 10), 0.9, top + 0.3, t.bz + 1.4)); // monitor
    P.push('dark_metal', place(box(2.5, 0.25, 0.6, 1), 0, t.fl - 0.1, -8.5 / 2 + 0.3)); // rear step
    // retro-reflective rear chevrons + roof marker lamps: the apparatus still reads at night
    P.push('veh_reflect', place(quad(2.3, t.bodyH - 0.55), 0, t.fl + t.bodyH / 2 - 0.1, -8.5 / 2 - 0.02, Math.PI));
    for (const s of [-1, 1]) P.push('veh_marker', place(box(0.16, 0.13, 0.05, 1), s * 1.0, t.fl + t.bodyH - 0.28, -8.5 / 2 - 0.03));
    for (const s of [-1, 1]) P.push('veh_marker', place(box(0.13, 0.1, 0.05, 1), s * 0.55, top + 0.16, -8.5 / 2 + 0.12));
  },
  'garbage-truck'(P) {
    const t = truck(P, 'veh_white', 'veh_green', 8.6, 2.5, 3.5, 2.5, { cabH: 2.2, r: 0.52 });
    const top = t.fl + t.bodyH;
    // rounded hopper crown, rear loader hopper, hydraulic arms
    P.push('veh_green', place(cylinder(1.22, 1.22, t.bodyLen - 0.2, 1, 20).rotateX(Math.PI / 2), 0, top - 0.7, t.bz));
    P.push('dark_metal', place(box(2.5, 1.7, 1.2, 1), 0, t.fl + 0.85, -8.6 / 2 + 0.6));
    P.push('veh_green', place(box(2.5, 0.9, 1.0, 1), 0, top - 0.45, -8.6 / 2 + 0.5));
    for (const s of [-1, 1]) P.push('dark_metal', place(box(0.14, 0.14, 4.2, 1), s * 1.15, top + 0.05, t.bz - 0.4));
    P.push('paint_white', place(box(0.02, 0.4, 3.0, 1), 1.26, t.fl + 1.2, t.bz + 0.4));
    P.push('paint_white', place(box(0.02, 0.4, 3.0, 1), -1.26, t.fl + 1.2, t.bz + 0.4));
    P.push('warning', place(box(0.7, 0.12, 0.2, 1), 0, t.fl + t.cabH + 0.1, 8.6 / 2 - 1.5));
    P.push('veh_reflect', place(quad(2.2, 0.8), 0, t.fl + 0.55, -8.6 / 2 - 0.02, Math.PI));
    for (const s of [-1, 1]) P.push('veh_marker', place(box(0.14, 0.11, 0.05, 1), s * 1.0, t.fl + 1.35, -8.6 / 2 - 0.03));
  },
  truck(P, rng) {
    const t = truck(P, rng.pick(['veh_blue', 'veh_white', 'veh_red_dark']), 'veh_white', 8.0, 2.45, 3.6, 2.6, { cabH: 2.3, r: 0.5 });
    P.push('dark_metal', place(box(2.47, 0.35, t.bodyLen + 0.02, 1), 0, t.fl + 0.17, t.bz)); // skirt
    P.push('veh_grey', place(box(0.02, 0.6, t.bodyLen - 0.6, 1), 2.45 / 2 + 0.005, t.fl + t.bodyH * 0.55, t.bz));
    P.push('veh_grey', place(box(0.02, 0.6, t.bodyLen - 0.6, 1), -2.45 / 2 - 0.005, t.fl + t.bodyH * 0.55, t.bz));
    P.push('roller', place(quad(2.2, t.bodyH - 0.3, 0, 2.2, 0, t.bodyH - 0.3), 0, t.fl + t.bodyH / 2, t.bz - t.bodyLen / 2 - 0.01, Math.PI));
  },
  'tractor-shovel'(P) {
    // wheel loader: articulated body, cab, lift arms, bucket
    const w = 2.4;
    P.push('veh_yellow', place(box(w - 0.3, 1.1, 2.4, 1), 0, 1.4, -1.2)); // rear engine bay
    P.push('dark_metal', place(box(w - 0.6, 0.6, 1.6, 1), 0, 0.95, 0.2)); // articulation
    P.push('veh_yellow', place(box(w - 0.5, 0.8, 1.6, 1), 0, 1.55, 0.9)); // front frame
    P.push('veh_yellow', place(cabin(1.6, 1.5, 1.6, 0.15, 0.1, 0.02), 0, 2.7, -0.3));
    glazing(P, 0, 2.85, -0.3, 1.5, 0.95, 1.6);
    P.push('dark_metal', place(box(0.3, 0.3, 1.2, 1), 0, 2.15, -2.1)); // counterweight / exhaust base
    P.push('plates', place(cylinder(0.07, 0.07, 1.0, 1, 8), -0.5, 2.5, -1.7));
    for (const s of [-1, 1]) P.push('veh_yellow', place(box(0.22, 0.3, 2.6, 1), s * 0.85, 1.75, 2.0, 0, -0.35));
    P.push('dark_metal', place(cylinder(0.1, 0.1, w - 0.3, 1, 8).rotateZ(Math.PI / 2), 0, 2.2, 1.0));
    P.push('dark_metal', place(box(2.5, 0.9, 0.9, 1), 0, 0.75, 3.35, 0, 0.35)); // bucket
    P.push('plates', place(box(2.5, 0.08, 0.6, 1), 0, 0.42, 3.75));
    wheels(P, w / 2 - 0.2, [1.2, -1.5], 0.68, 0.5);
    P.push('warning', place(box(0.25, 0.2, 0.25, 1), 0.6, 3.6, -0.3));
    P.push('lamp', place(box(1.2, 0.12, 0.06, 1), 0, 3.4, 0.5));
  },
};

/** Build one vehicle as a list of { key, geo } in local space (nose +Z, wheels on y = 0). */
export function buildVehicle(name, rng) {
  const fn = VEHICLE_BUILDERS[name] || VEHICLE_BUILDERS.sedan;
  const parts = [];
  const P = { push: (key, geo) => parts.push({ key, geo }) };
  fn(P, rng);
  return parts;
}
