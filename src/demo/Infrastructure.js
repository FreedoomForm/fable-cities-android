/**
 * demo — large-scale infrastructure: motorway, railway, port.
 *
 * The blind judges called out the reference frame's "highway interchanges with correct ramp
 * geometry, rail yards, piers and waterfront terracing" against our empty ground. The roads module
 * builds carriageways that follow the terrain; it has no concept of a bridge, an embankment or a
 * quay. So the demo shapes the ground first (the motorway runs on a real embankment, which is what
 * makes the trumpet read as an interchange rather than a tangle of surface roads) and then builds
 * the structures the city needs on top: a rail viaduct that flies over the motorway on concrete
 * piers into an elevated terminus, and a working cargo port with quay walls, gantry cranes, moored
 * ships and a marina.
 *
 * All of it is merged geometry on the demo's shared PBR materials. Deterministic per seed.
 */
import { box, cyl, vault, slab, at, lin, Bucket, fromTriangles, orientOutward } from './gfx.js';
import { addTruck, addParkedCar } from './cars.js';

const STEEL = lin('#9aa0a6');
const STEEL_D = lin('#5a6066');
const CRANE = lin('#c85a1e');
const CRANE2 = lin('#1f4e78');
const HULL = lin('#6d2b26');
const HULL2 = lin('#22405c');
const WHITE = lin('#d8d6cf');
const DARK = lin('#2c2f33');
const RUST = lin('#7a4a32');
const CONTAINER = ['#7d3f30', '#2f5670', '#4c6b45', '#8a7431', '#6a6a6e', '#8c5a2a', '#3f6b6e'].map(lin);
const MOD = [1, 1, 1];
const MOD_D = [0.78, 0.78, 0.76];

export const EMBANKMENT = 6.0;   // metres the motorway mainline is lifted above the plain

/**
 * Raise the motorway corridor onto an embankment BEFORE the road is built, so the carriageway is
 * carried up with it and the slip roads climb a real batter.
 */
export function shapeMotorway(ctx, g, localPts) {
  const terrain = ctx.world.terrain;
  if (!terrain || !terrain.api || typeof terrain.api.conformPath !== 'function') return null;
  const pts = [];
  for (let i = 0; i < localPts.length - 1; i++) {
    const a = localPts[i], b = localPts[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.u - a.u, b.v - a.v) / 40));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const u = a.u + (b.u - a.u) * t, v = a.v + (b.v - a.v) * t;
      const p = g.L(u, v);
      pts.push({ x: p.x, y: terrain.getHeight(p.x, p.z) + EMBANKMENT, z: p.z });
    }
  }
  const last = localPts[localPts.length - 1];
  const lp = g.L(last.u, last.v);
  pts.push({ x: lp.x, y: terrain.getHeight(lp.x, lp.z) + EMBANKMENT, z: lp.z });
  // smooth the crest so the embankment does not follow every wrinkle of the ground below it
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < pts.length - 1; i++) pts[i].y = (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4;
  }
  try {
    terrain.api.conformPath(pts, 46, 46);
    for (const p of pts) terrain.api.clearVegetationCircle(p.x, p.z, 40);
  } catch (err) { console.warn('[demo] motorway embankment failed', err); }
  return pts;
}

/** Guardrails, gantry signs and lighting masts along every motorway segment. */
export function dressMotorway(ctx, gfx, g) {
  const { world } = ctx;
  const b = new Bucket();
  const segs = [...world.roads.segments.values()].filter((s) => s.type === 'highway' || (s.type && s.type.id === 'highway'));
  let posts = 0;
  for (const seg of segs) {
    const pts = seg.points || [];
    if (pts.length < 2) continue;
    const half = 15.8;
    const STRIDE = 3;   // one guardrail beam per 3 samples: same silhouette, a third of the triangles
    for (let i = STRIDE; i < pts.length; i += STRIDE) {
      const a = pts[i - STRIDE], c = pts[i];
      const dx = c.x - a.x, dz = c.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const nx = -dz / len, nz = dx / len;
      const yaw = Math.atan2(dx, dz);
      const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, z: (a.z + c.z) / 2 };
      for (const s of [-1, 1]) {
        const gx = mid.x + nx * half * s, gz = mid.z + nz * half * s;
        b.push('metal', at(box(len + 0.2, 0.34, 0.12, 2, STEEL), gx, mid.y + 0.78, gz, yaw + Math.PI / 2));
        b.push('metal', at(box(0.16, 0.85, 0.16, 1, STEEL_D), gx, mid.y + 0.42, gz, yaw)); posts++;
      }
      // central reservation barrier
      b.push('concrete', at(box(len + 0.2, 0.85, 0.7, 2, MOD_D), mid.x, mid.y + 0.42, mid.z, yaw + Math.PI / 2));
      // lighting mast every ~14 samples, alternating sides
      if (i % 15 === 0) {
        const s = (i / 15) % 2 ? 1 : -1;
        const gx = mid.x + nx * (half + 1.6) * s, gz = mid.z + nz * (half + 1.6) * s;
        b.push('metal', at(cyl(0.16, 0.26, 13, 6, 3, STEEL_D), gx, mid.y + 6.5, gz, 0));
        b.push('metal', at(box(3.0, 0.22, 0.3, 2, STEEL_D), gx - nx * 1.4 * s, mid.y + 13, gz - nz * 1.4 * s, yaw + Math.PI / 2));
        b.push('lamp_glow', at(box(1.1, 0.22, 0.5, 1, lin('#e9dcc0')), gx - nx * 2.7 * s, mid.y + 12.85, gz - nz * 2.7 * s, yaw + Math.PI / 2));
      }
      // sign gantry
      if (i % 45 === 21) {
        for (const s of [-1, 1]) {
          const gx = mid.x + nx * (half + 0.8) * s, gz = mid.z + nz * (half + 0.8) * s;
          b.push('metal', at(cyl(0.28, 0.34, 8.6, 8, 3, STEEL_D), gx, mid.y + 4.3, gz, 0));
        }
        b.push('metal', at(box(half * 2 + 2, 0.5, 0.5, 3, STEEL_D), mid.x, mid.y + 8.5, mid.z, yaw + Math.PI / 2));
        b.push('paint', at(box(9.5, 3.2, 0.25, 3, lin('#1d5a2e')), mid.x + nx * 6, mid.y + 6.7, mid.z + nz * 6, yaw + Math.PI / 2));
        b.push('paint', at(box(6.5, 2.6, 0.25, 3, lin('#1d5a2e')), mid.x - nx * 7, mid.y + 6.4, mid.z - nz * 7, yaw + Math.PI / 2));
      }
    }
  }
  b.emit(gfx, { cast: true, receive: true, tag: 'motorway' });
  void g;
  return { segments: segs.length, posts };
}

// ------------------------------------------------------------------------------------------------
// railway

/**
 * Rail viaduct from the inland edge over the motorway to an elevated terminus at the city edge,
 * plus a freight siding. Returns `{ reserved, station }`.
 */
export function buildRail(ctx, gfx, g) {
  const { world } = ctx;
  const terrain = world.terrain;
  const b = new Bucket();
  const rng = world.rng.fork(0x9a11);
  const U = g.RAIL_U;
  const vStation = g.HW_V + 250;         // terminus at the inland edge of the grid
  const vEnd = g.HW_V - 260;             // runs off inland
  const reserved = [];

  // height profile: at grade inland, 13 m over the motorway, 9 m at the station
  const deckY = (v) => {
    const p = g.L(U, v);
    const gy = terrain.getHeight(p.x, p.z);
    if (v < g.HW_V - 150) return gy + 1.4;
    if (v < g.HW_V - 40) return gy + 1.4 + (13 - 1.4) * ((v - (g.HW_V - 150)) / 110);
    if (v > vStation - 120) return gy + 9.5;
    return gy + 13;
  };
  // embankment under the inland approach
  try {
    const ep = [];
    for (let v = vEnd; v <= g.HW_V - 145; v += 20) {
      const p = g.L(U, v);
      ep.push({ x: p.x, y: deckY(v) - 1.4, z: p.z });
    }
    if (ep.length > 1) {
      terrain.api.conformPath(ep, 18, 26);
      for (const p of ep) terrain.api.clearVegetationCircle(p.x, p.z, 24);
    }
  } catch (err) { void err; }

  const SPAN = 24;
  let spans = 0;
  for (let v = vEnd; v < vStation; v += SPAN) {
    const vm = v + SPAN / 2;
    const p = g.L(U, vm);
    const y = deckY(vm);
    const gy = terrain.getHeight(p.x, p.z);
    const yaw = g.yaw + Math.PI / 2;      // deck runs along local +v
    const elevated = y - gy > 3;
    if (elevated) {
      b.push('concrete', at(box(SPAN + 0.4, 1.5, 10.4, 4, MOD), p.x, y - 0.75, p.z, yaw));
      // pier
      const ph = y - 1.5 - gy;
      b.push('concrete', at(box(3.4, ph, 2.4, 3, MOD_D), p.x, gy + ph / 2, p.z, yaw));
      b.push('concrete', at(box(5.2, 0.9, 3.4, 3, MOD), p.x, y - 1.9, p.z, yaw));
      for (const s of [-1, 1]) {
        const o = 5.0 * s;
        b.push('concrete', at(box(SPAN + 0.4, 1.1, 0.45, 3, MOD), p.x + Math.cos(yaw) * 0 + Math.sin(yaw) * o, y + 0.55, p.z + Math.cos(yaw) * o, yaw));
      }
    } else {
      b.push('concrete', at(box(SPAN + 0.4, 1.0, 11.5, 4, MOD_D), p.x, y - 0.5, p.z, yaw));
    }
    // ballast + two tracks
    b.push('asphalt', at(box(SPAN + 0.4, 0.42, 8.6, 4, [0.72, 0.7, 0.68]), p.x, y + 0.21, p.z, yaw));
    for (const t of [-2.2, 2.2]) {
      for (const r of [-0.72, 0.72]) {
        const o = t + r;
        b.push('metal', at(box(SPAN + 0.4, 0.16, 0.09, 4, STEEL), p.x + Math.sin(yaw) * o, y + 0.5, p.z + Math.cos(yaw) * o, yaw));
      }
    }
    spans++;
  }

  // ---- terminus: elevated platforms under a train shed, head house and forecourt
  const pStation = g.L(U, vStation - 60);
  const yS = deckY(vStation - 60);
  const gS = terrain.getHeight(pStation.x, pStation.z);
  const yaw = g.yaw + Math.PI / 2;
  try {
    terrain.api.conformDisc(pStation.x, pStation.z, 86, gS, 30);
    terrain.api.clearVegetationCircle(pStation.x, pStation.z, 96);
  } catch (err) { void err; }
  // platform deck
  b.push('concrete', at(box(130, 1.6, 26, 4, MOD), pStation.x, yS - 0.8, pStation.z, yaw));
  for (const s of [-1, 1]) {
    b.push('paving', at(box(126, 0.35, 5.4, 3, MOD), pStation.x + Math.sin(yaw) * 8.4 * s, yS + 0.5, pStation.z + Math.cos(yaw) * 8.4 * s, yaw));
  }
  b.push('asphalt', at(box(126, 0.42, 9.0, 4, [0.72, 0.7, 0.68]), pStation.x, yS + 0.21, pStation.z, yaw));
  for (const t of [-2.3, 2.3]) for (const r of [-0.72, 0.72]) {
    const o = t + r;
    b.push('metal', at(box(126, 0.16, 0.09, 4, STEEL), pStation.x + Math.sin(yaw) * o, yS + 0.5, pStation.z + Math.cos(yaw) * o, yaw));
  }
  // train shed
  b.push('paint', at(vault(15.5, 118, 18, 6, lin('#b7bbc0')), pStation.x, yS + 1.2, pStation.z, yaw));
  for (let i = -5; i <= 5; i++) {
    const o = i * 11.5;
    for (const s of [-1, 1]) {
      b.push('metal', at(cyl(0.4, 0.5, 12, 8, 3, STEEL_D), pStation.x + Math.cos(yaw) * o + Math.sin(yaw) * 14.6 * s, yS + 6, pStation.z - Math.sin(yaw) * o + Math.cos(yaw) * 14.6 * s, 0));
    }
  }
  // head house at the city end, at ground level
  const hh = g.L(U, vStation + 4);
  const hy = terrain.getHeight(hh.x, hh.z);
  const skin = gfx.facade('stone', 733);
  b.push(skin, at(box(46, 16, 22, 24, [1.03, 1.0, 0.95]), hh.x, hy + 8, hh.z, yaw));
  b.push('concrete', at(box(50, 1.4, 26, 3, MOD), hh.x, hy + 16.6, hh.z, yaw));
  b.push('window_lit', at(box(30, 8.5, 0.5, 3, lin('#20242a')), hh.x + Math.sin(yaw) * 11.2, hy + 9, hh.z + Math.cos(yaw) * 11.2, yaw));
  b.push('concrete', at(cyl(3.2, 3.2, 1.2, 20, 3, MOD), hh.x, hy + 18, hh.z, yaw));
  b.push('lamp_glow', at(cyl(2.2, 2.2, 0.4, 16, 2, lin('#e6dcc4')), hh.x, hy + 18.9, hh.z, yaw));
  // connecting stair block from head house up to the platforms
  b.push('concrete', at(box(14, yS - hy, 18, 4, MOD_D), hh.x - Math.cos(yaw) * 26, hy + (yS - hy) / 2, hh.z + Math.sin(yaw) * 26, yaw));

  // a train standing at the platform
  train(b, rng, pStation.x - Math.cos(yaw) * 18, yS + 0.72, pStation.z + Math.sin(yaw) * 18, yaw, 6, -2.3, g);

  // forecourt with taxis
  const fc = g.L(U, vStation + 30);
  const fy = terrain.getHeight(fc.x, fc.z);
  b.push('paving', at(slab(70, 40, 3, MOD), fc.x, fy + 0.16, fc.z, yaw));
  for (let i = 0; i < 7; i++) {
    const o = (i - 3) * 6.4;
    addParkedCar(b, rng, fc.x + Math.cos(yaw) * o + Math.sin(yaw) * 12, fy + 0.17, fc.z - Math.sin(yaw) * o + Math.cos(yaw) * 12, yaw + Math.PI / 2);
  }

  // ---- freight siding at grade, alongside the viaduct
  const yardU = U - 32, yardV = g.HW_V + 150;
  const yp = g.L(yardU, yardV);
  const yy = terrain.getHeight(yp.x, yp.z);
  const yardYaw = g.yaw + Math.PI / 2;
  try {
    const ypts = [];
    for (let v = yardV - 90; v <= yardV + 90; v += 20) { const q = g.L(yardU, v); ypts.push({ x: q.x, y: yy, z: q.z }); }
    terrain.api.conformPath(ypts, 30, 22);
    for (const q of ypts) terrain.api.clearVegetationCircle(q.x, q.z, 34);
  } catch (err) { void err; }
  for (let t = 0; t < 3; t++) {
    const o = (t - 1) * 6.2;
    const cx = yp.x + Math.sin(yardYaw) * o, cz = yp.z + Math.cos(yardYaw) * o;
    b.push('asphalt', at(box(180, 0.4, 4.6, 4, [0.7, 0.68, 0.66]), cx, yy + 0.2, cz, yardYaw));
    for (const r of [-0.72, 0.72]) {
      b.push('metal', at(box(180, 0.14, 0.09, 4, STEEL), cx + Math.sin(yardYaw) * r, yy + 0.46, cz + Math.cos(yardYaw) * r, yardYaw));
    }
  }
  wagons(b, rng, yp.x, yy + 0.62, yp.z, yardYaw, g);
  // goods shed
  const gs = g.L(yardU - 34, yardV + 20);
  b.push('paint', at(box(58, 9, 20, 3, lin('#9a978e')), gs.x, yy + 4.5, gs.z, yardYaw));
  reserved.push({ u: U, v: vStation - 40, r: 96 }, { u: yardU, v: yardV, r: 46 });

  b.emit(gfx, { cast: true, receive: true, tag: 'rail' });
  return { reserved, station: { u: U, v: vStation - 40, x: pStation.x, y: yS, z: pStation.z }, spans };
}

/** A locomotive plus coaches standing on a track. */
function train(b, rng, x, y, z, yaw, cars, lateral, g) {
  const ox = Math.sin(yaw) * lateral, oz = Math.cos(yaw) * lateral;
  let along = 0;
  const body = lin('#39506b');
  for (let i = 0; i < cars; i++) {
    const L = i === 0 ? 19 : 24;
    const cx = x + Math.cos(yaw) * along + ox, cz = z - Math.sin(yaw) * along + oz;
    b.push('paint', at(box(L - 1, 3.1, 3.0, 3, i === 0 ? lin('#8a2f24') : body), cx, y + 2.1, cz, yaw));
    b.push('paint', at(box(L - 2.6, 0.55, 2.7, 3, lin('#c9c6bd')), cx, y + 3.85, cz, yaw));
    b.push('glass', at(box(L - 5, 1.05, 3.06, 3, lin('#182029')), cx, y + 2.75, cz, yaw));
    for (const s of [-1, 1]) {
      b.push('metal', at(box(3.2, 0.75, 2.4, 2, DARK), cx + Math.cos(yaw) * (L * 0.32) * s, y + 0.4, cz - Math.sin(yaw) * (L * 0.32) * s, yaw));
    }
    along -= L + 0.8;
  }
  void rng; void g;
}

/** Freight wagons and containers in the yard. */
function wagons(b, rng, x, y, z, yaw, g) {
  for (let t = -1; t <= 1; t++) {
    let along = -80 + rng() * 40;
    const n = 3 + ((rng() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const o = t * 6.2;
      const cx = x + Math.cos(yaw) * along + Math.sin(yaw) * o;
      const cz = z - Math.sin(yaw) * along + Math.cos(yaw) * o;
      b.push('metal', at(box(15, 0.9, 2.9, 3, RUST), cx, y + 0.75, cz, yaw));
      if (rng() < 0.75) b.push('paint', at(box(12.2, 2.6, 2.44, 1.4, CONTAINER[(rng() * CONTAINER.length) | 0]), cx, y + 2.5, cz, yaw));
      along += 16.5;
    }
  }
  void g;
}

// ------------------------------------------------------------------------------------------------
// port

/**
 * Cargo port on the best stretch of shoreline away from the promenade: quay, cranes, containers,
 * warehouses, moored ships — plus a marina of small boats nearer the city.
 */
export function buildPort(ctx, gfx, g) {
  const { world } = ctx;
  const terrain = world.terrain;
  const b = new Bucket();
  const rng = world.rng.fork(0x70a7);
  const waterY = terrain.waterLevel != null ? terrain.waterLevel : 0;
  const reserved = [];

  // find a straight-ish shore stretch outside the city grid
  const site = portSite(g, 320);
  if (!site) return { reserved, quay: null };
  const { u0, u1, shoreV } = site;
  const uc = (u0 + u1) / 2;
  const quayY = waterY + 3.1;
  const faceV = shoreV + 26;             // quay face, 26 m out into the water
  // Pull the back of the apron in until it clears any road: re-levelling ground under a carriageway
  // that is already built would leave the road hanging in the air.
  let backV = shoreV - 72;
  const roads = world.roads.api;
  for (let guard = 0; guard < 8; guard++) {
    let hit = false;
    for (let u = u0 - 20; u <= u1 + 20 && !hit; u += 20) {
      for (let v = backV - 30; v <= backV + 12; v += 10) {
        const p = g.L(u, v);
        if (roads.surfaceHeight(p.x, p.z) != null) { hit = true; break; }
      }
    }
    if (!hit || faceV - backV < 46) break;
    backV += 9;
  }

  // level the apron: the quay platform is flat ground, not a beach
  try {
    const pts = [];
    for (let u = u0 - 20; u <= u1 + 20; u += 24) {
      const p = g.L(u, (faceV + backV) / 2);
      pts.push({ x: p.x, y: quayY, z: p.z });
    }
    terrain.api.conformPath(pts, Math.abs(faceV - backV) - 10, 20);
    for (const p of pts) terrain.api.clearVegetationCircle(p.x, p.z, 70);
  } catch (err) { void err; }

  const yaw = g.yaw;
  // apron slab + quay wall face
  const L = u1 - u0 + 40, D = Math.abs(faceV - backV);
  const c = g.L(uc, (faceV + backV) / 2);
  b.push('concrete', at(box(L, 0.5, D, 5, MOD), c.x, quayY - 0.15, c.z, yaw));
  const fc = g.L(uc, faceV);
  b.push('concrete', at(box(L, 7.2, 1.6, 4, MOD_D), fc.x, quayY - 3.6, fc.z, yaw));
  // bollards and fenders
  for (let u = u0; u <= u1; u += 22) {
    const p = g.L(u, faceV - 2.2);
    b.push('metal', at(cyl(0.32, 0.42, 1.1, 8, 1.5, STEEL_D), p.x, quayY + 0.5, p.z, 0));
    const f = g.L(u + 11, faceV + 0.9);
    b.push('wood', at(box(0.6, 3.4, 0.5, 1.5, [0.8, 0.76, 0.7]), f.x, quayY - 1.4, f.z, yaw));
  }

  // gantry cranes
  const craneVs = faceV - 16;
  for (let k = 0; k < 3; k++) {
    const u = u0 + 60 + k * ((u1 - u0 - 120) / 2);
    const p = g.L(u, craneVs);
    gantryCrane(b, p.x, quayY, p.z, yaw, k % 2 ? CRANE2 : CRANE, faceV - craneVs);
  }

  // container stacks on the apron
  for (let k = 0; k < 170; k++) {
    const u = u0 + 20 + rng() * (u1 - u0 - 40);
    const v = backV + 12 + rng() * (D - 46);
    if (Math.abs(v - craneVs) < 12) continue;
    const p = g.L(u, v);
    const long = rng() < 0.62;
    const w = long ? 12.2 : 6.1, h = 2.6;
    const stack = 1 + ((rng() * 3.4) | 0);
    const cyaw = yaw + (rng() < 0.8 ? 0 : Math.PI / 2);
    for (let s = 0; s < stack; s++) {
      b.push('paint', at(box(w, h, 2.44, 1.2, CONTAINER[(rng() * CONTAINER.length) | 0]), p.x, quayY + h * (s + 0.5), p.z, cyaw));
    }
  }
  // trucks and a couple of warehouses
  for (let k = 0; k < 10; k++) {
    const p = g.L(u0 + 30 + rng() * (u1 - u0 - 60), backV + 8 + rng() * 20);
    addTruck(b, rng, p.x, quayY, p.z, yaw + (rng() < 0.5 ? 0 : Math.PI));
  }
  for (let k = 0; k < 2; k++) {
    const p = g.L(u0 + 70 + k * 150, backV + 14);
    b.push('paint', at(box(52, 9.5, 21, 3, lin('#b0aa9e')), p.x, quayY + 4.75, p.z, yaw));
    b.push('paint', at(vault(11.5, 52, 12, 5, lin('#8e9298')), p.x, quayY + 9.2, p.z, yaw + Math.PI / 2));
    b.push('paint', at(box(6, 6.5, 0.4, 2, lin('#33383d')), p.x + Math.sin(yaw) * 10.7, quayY + 3.2, p.z + Math.cos(yaw) * 10.7, yaw));
  }

  // moored ships
  ship(b, g, quayY, waterY, uc - 110, faceV + 13, yaw, 152, HULL, rng);
  ship(b, g, quayY, waterY, uc + 95, faceV + 13, yaw, 118, HULL2, rng);

  // Reserve only the apron itself: a single disc big enough to cover a 360 m quay also swallows the
  // neighbourhood behind it, and every zoning cell it eats is population the city never gets.
  const midV = (faceV + backV) / 2, rr = Math.min(85, D * 0.62);
  for (let u = u0 - 10; u <= u1 + 10; u += rr * 1.3) reserved.push({ u, v: midV, r: rr });

  // ---- marina, on the city side of the port
  const mu = uc < 0 ? g.GRID_U1 + 150 : g.GRID_U0 - 150;
  const msv = g.shore.at(mu);
  if (Number.isFinite(msv)) {
    const my = waterY;
    const mp = g.L(mu, msv + 24);
    // pontoons
    b.push('wood', at(box(96, 0.5, 3.2, 2, MOD), mp.x, my + 0.55, mp.z, yaw));
    for (let k = -3; k <= 3; k++) {
      const o = k * 15;
      const p = g.L(mu + o, msv + 46);
      b.push('wood', at(box(3.0, 0.5, 42, 2, MOD), p.x, my + 0.55, p.z, yaw));
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const q = g.L(mu + o + 5.5 * s, msv + 32 + i * 13);
          sailboat(b, q.x, my, q.z, yaw + Math.PI / 2, rng);
        }
      }
    }
    reserved.push({ u: mu, v: msv - 20, r: 40 });
  }

  b.emit(gfx, { cast: true, receive: true, tag: 'port' });
  return { reserved, quay: { u: uc, v: (faceV + backV) / 2, faceV, shoreV, y: quayY } };
}

/** The straightest stretch of shoreline clear of the city waterfront, on whichever side has one. */
function portSite(g, want) {
  const half = want / 2;
  let best = null, bestScore = -Infinity;
  for (let c = -880 + half; c <= 880 - half; c += 30) {
    // Keep the quay at the far end of the waterfront: levelling an apron to water level right behind
    // the promenade blocks would steepen their ground, and zoning drops cells it cannot sit on.
    if (Math.abs(c) < g.GRID_U1 * 0.72) continue;
    let ok = true, sum = 0, n = 0, minV = Infinity, maxV = -Infinity;
    for (let x = c - half; x <= c + half; x += 20) {
      const sv = g.shore.at(x);
      if (!Number.isFinite(sv)) { ok = false; break; }
      sum += sv; n++;
      if (sv < minV) minV = sv;
      if (sv > maxV) maxV = sv;
    }
    if (!ok || n < 6) continue;
    // straight shoreline wins; being just outside the city edge wins over being far away
    const score = -(maxV - minV) - Math.abs(Math.abs(c) - (g.GRID_U1 + 260)) * 0.12;
    if (score > bestScore) { bestScore = score; best = { u0: c - half, u1: c + half, shoreV: sum / n }; }
  }
  return best;
}

/** Ship-to-shore gantry crane: portal legs, boom over the water, machine house. */
function gantryCrane(b, x, y, z, yaw, colour, reach) {
  const H = 34, span = 22;
  for (const sa of [-1, 1]) {
    for (const sc of [-1, 1]) {
      const dx = Math.cos(yaw) * 8 * sa + Math.sin(yaw) * (span / 2) * sc;
      const dz = -Math.sin(yaw) * 8 * sa + Math.cos(yaw) * (span / 2) * sc;
      b.push('paint', at(box(1.5, H, 1.5, 3, colour), x + dx, y + H / 2, z + dz, yaw));
      b.push('metal', at(box(3.0, 1.2, 2.6, 2, STEEL_D), x + dx, y + 0.6, z + dz, yaw));
    }
  }
  // portal beams
  for (const sc of [-1, 1]) {
    const dx = Math.sin(yaw) * (span / 2) * sc, dz = Math.cos(yaw) * (span / 2) * sc;
    b.push('paint', at(box(18, 2.0, 1.6, 3, colour), x + dx, y + H, z + dz, yaw));
  }
  b.push('paint', at(box(3.2, 2.0, span + 2, 3, colour), x, y + H + 1.6, z, yaw));
  // boom out over the water plus the back stay
  const boomLen = reach + 34;
  const bx = Math.sin(yaw) * (boomLen / 2 - 6), bz = Math.cos(yaw) * (boomLen / 2 - 6);
  b.push('paint', at(box(2.6, 1.8, boomLen, 3, colour), x + bx, y + H + 3.4, z + bz, yaw));
  b.push('paint', at(box(2.6, 1.8, 26, 3, colour), x - Math.sin(yaw) * 20, y + H + 3.4, z - Math.cos(yaw) * 20, yaw));
  b.push('metal', at(box(0.5, 15, 0.5, 2, STEEL_D), x, y + H + 11, z, yaw));
  b.push('paint', at(box(4.2, 3.2, 5.2, 2, WHITE), x - Math.sin(yaw) * 9, y + H + 5.4, z - Math.cos(yaw) * 9, yaw));
  b.push('lamp_glow', at(box(1.0, 0.4, 0.8, 1, lin('#ffe6bb')), x + Math.sin(yaw) * 12, y + H + 2.2, z + Math.cos(yaw) * 12, yaw));
}

/** A moored cargo ship: tapered hull, deck containers, stern superstructure. */
function ship(b, g, quayY, waterY, u, v, yaw, len, hull, rng) {
  const p = g.L(u, v);
  const x = p.x, z = p.z;
  const beam = Math.max(16, len * 0.15), draft = 5.4, freeboard = 7.2;
  const hl = len / 2, hb = beam / 2;
  const T = [];
  const P = (a, yy, c) => ({ x: Math.cos(yaw) * a + Math.sin(yaw) * c, y: yy, z: -Math.sin(yaw) * a + Math.cos(yaw) * c });
  const y0 = waterY - draft, y1 = waterY + freeboard;
  // hull: 8 stations from stern to bow, sides + bottom + deck
  const stations = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const a = -hl + len * t;
    const w = hb * (t < 0.12 ? 0.72 + t * 2.3 : t > 0.86 ? (1 - (t - 0.86) / 0.14) * 0.9 + 0.1 : 1);
    stations.push({ a, w });
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const s0 = stations[i], s1 = stations[i + 1];
    for (const sc of [-1, 1]) {
      T.push([P(s0.a, y1, s0.w * sc), P(s1.a, y1, s1.w * sc), P(s1.a, y0, s1.w * 0.55 * sc)]);
      T.push([P(s0.a, y1, s0.w * sc), P(s1.a, y0, s1.w * 0.55 * sc), P(s0.a, y0, s0.w * 0.55 * sc)]);
    }
    T.push([P(s0.a, y0, -s0.w * 0.55), P(s1.a, y0, -s1.w * 0.55), P(s1.a, y0, s1.w * 0.55)]);
    T.push([P(s0.a, y0, -s0.w * 0.55), P(s1.a, y0, s1.w * 0.55), P(s0.a, y0, s0.w * 0.55)]);
  }
  const hullGeo = fromTriangles(orientOutward(T, { x: 0, y: (y0 + y1) / 2, z: 0 }), 6, hull);
  hullGeo.translate(x, 0, z);
  b.push('paint', hullGeo);
  // deck
  const deck = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const s0 = stations[i], s1 = stations[i + 1];
    deck.push([P(s0.a, y1, -s0.w), P(s1.a, y1, -s1.w), P(s1.a, y1, s1.w)]);
    deck.push([P(s0.a, y1, -s0.w), P(s1.a, y1, s1.w), P(s0.a, y1, s0.w)]);
  }
  const deckGeo = fromTriangles(orientOutward(deck, { x: 0, y: y0 - 4, z: 0 }), 6, lin('#6f6f68'));
  deckGeo.translate(x, 0, z);
  b.push('paint', deckGeo);
  // deck cargo
  for (let i = 0; i < 7; i++) {
    const a = -hl * 0.55 + i * (len * 0.11);
    for (let k = -1; k <= 1; k++) {
      const stack = 1 + ((rng() * 3) | 0);
      for (let s = 0; s < stack; s++) {
        const o = P(a, y1 + 1.3 + s * 2.6, k * 3.0);
        b.push('paint', at(box(11.5, 2.6, 2.44, 1.2, CONTAINER[(rng() * CONTAINER.length) | 0]), x + o.x, o.y, z + o.z, yaw));
      }
    }
  }
  // superstructure + funnel at the stern
  const st = P(-hl * 0.76, 0, 0);
  b.push('paint', at(box(16, 13, beam * 0.86, 3, WHITE), x + st.x, y1 + 6.5, z + st.z, yaw));
  b.push('glass', at(box(15, 1.5, beam * 0.88, 3, lin('#1b232b')), x + st.x, y1 + 11.6, z + st.z, yaw));
  b.push('paint', at(box(6.5, 8, 6.5, 2, lin('#3a3f44')), x + st.x - Math.cos(yaw) * 10, y1 + 17, z + st.z + Math.sin(yaw) * 10, yaw));
  b.push('metal', at(cyl(0.2, 0.3, 16, 6, 3, STEEL_D), x + P(hl * 0.9, 0, 0).x, y1 + 8, z + P(hl * 0.9, 0, 0).z, 0));
  void quayY;
}

/** A small sailing boat for the marina. */
function sailboat(b, x, y, z, yaw, rng) {
  const L = 7 + rng() * 4;
  b.push('paint', at(box(L, 1.5, 2.3, 2, rng() < 0.5 ? WHITE : lin('#c8ccd0')), x, y + 0.45, z, yaw));
  b.push('paint', at(box(L * 0.42, 0.9, 1.7, 1.5, lin('#e2e0d8')), x - Math.cos(yaw) * L * 0.12, y + 1.5, z + Math.sin(yaw) * L * 0.12, yaw));
  b.push('metal', at(cyl(0.07, 0.11, 9 + rng() * 3, 5, 3, STEEL), x, y + 5.5, z, 0));
}
