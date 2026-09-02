/**
 * Lot records built from the road network — used by the showcase and, while no zoning module writes
 * world.zones.lots, as the module's fallback "auto-zoning" so the growth logic has somewhere to build.
 * Records follow the zones.api contract: { id, cells, x, z, w, d, yaw, type, roadSegmentId,
 * frontage:{x,z,nx,nz}, buildingId }. Lots sit on the outer sidewalk edge (roads.api.sampleEdge),
 * are oriented to the road (+z of the lot frame points at the road), avoid water, steep ground,
 * crossing roads and each other.
 */
import { SimplexNoise } from '../../shared/noise.js';

const SIZES = {
  'res-low': { w: [16, 16, 24], d: [16, 24] },
  'res-high': { w: [24, 32], d: [24, 32] },
  'com-low': { w: [16, 24, 24], d: [16, 24] },
  'com-high': { w: [32], d: [32] },
  office: { w: [32, 32, 40], d: [32] },
  ind: { w: [32, 40], d: [32, 40] },
};

function obbCorners(l) {
  const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
  const ax = { x: c, z: -s }, az = { x: s, z: c };
  const hw = l.w / 2, hd = l.d / 2;
  return [
    { x: l.x + ax.x * hw + az.x * hd, z: l.z + ax.z * hw + az.z * hd },
    { x: l.x - ax.x * hw + az.x * hd, z: l.z - ax.z * hw + az.z * hd },
    { x: l.x - ax.x * hw - az.x * hd, z: l.z - ax.z * hw - az.z * hd },
    { x: l.x + ax.x * hw - az.x * hd, z: l.z + ax.z * hw - az.z * hd },
  ];
}
function project(corners, ax) {
  let lo = Infinity, hi = -Infinity;
  for (const c of corners) { const p = c.x * ax.x + c.z * ax.z; if (p < lo) lo = p; if (p > hi) hi = p; }
  return [lo, hi];
}
/** Separating-axis test for two oriented rectangles (with padding). */
export function lotsOverlap(a, b, pad = 0.4) {
  const ca = obbCorners(a), cb = obbCorners(b);
  for (const l of [a, b]) {
    const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
    for (const ax of [{ x: c, z: -s }, { x: s, z: c }]) {
      const [a0, a1] = project(ca, ax), [b0, b1] = project(cb, ax);
      if (a1 + pad < b0 || b1 + pad < a0) return false;
    }
  }
  return true;
}

class LotIndex {
  constructor(cell = 32) { this.cell = cell; this.map = new Map(); }
  _keys(l) {
    const r = Math.hypot(l.w, l.d) / 2;
    const x0 = Math.floor((l.x - r) / this.cell), x1 = Math.floor((l.x + r) / this.cell);
    const z0 = Math.floor((l.z - r) / this.cell), z1 = Math.floor((l.z + r) / this.cell);
    const out = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push(x + ':' + z);
    return out;
  }
  add(l) { for (const k of this._keys(l)) { if (!this.map.has(k)) this.map.set(k, []); this.map.get(k).push(l); } }
  collides(l, pad) {
    const seen = new Set();
    for (const k of this._keys(l)) {
      const arr = this.map.get(k);
      if (!arr) continue;
      for (const o of arr) { if (seen.has(o)) continue; seen.add(o); if (lotsOverlap(l, o, pad)) return true; }
    }
    return false;
  }
}

/** Default zone assignment when no zoning module exists: road class + low-frequency noise. */
export function defaultTypeFor(world, seed = 7) {
  const noise = new SimplexNoise(seed);
  return (seg, x, z) => {
    const n = noise.noise2D(x / 420, z / 420);
    const m = noise.noise2D(x / 150 + 31, z / 150 - 17);
    const dist = Math.hypot(x, z) / world.half;
    if (seg.type === 'avenue') return n > 0.3 ? 'office' : n > -0.15 ? 'com-high' : m > 0.2 ? 'com-low' : 'res-high';
    if (n < -0.5 && dist > 0.2) return 'ind';
    if (m > 0.55) return 'com-low';
    if (n > 0.2) return 'res-high';
    return 'res-low';
  };
}

/**
 * @param world
 * @param {{ rng, typeFor:(seg,x,z)=>string|null, existing?:object[], segments?:Iterable, idStart?:number }} opts
 */
export function generateLots(world, opts) {
  const roads = world.roads && world.roads.api;
  const out = [];
  if (!roads || typeof roads.sampleEdge !== 'function') return out;
  const { rng, typeFor } = opts;
  const index = new LotIndex();
  for (const l of opts.existing || []) index.add(l);
  let nextId = opts.idStart || 1;
  const terrain = world.terrain;
  const segments = opts.segments || world.roads.segments.values();
  const cellSize = world.cellSize || 8;
  const bound = world.half - 12;

  const tooCloseToRoad = (x, z, ownId) => {
    const hit = roads.nearest(x, z, 24);
    if (!hit) return false;
    if (hit.segment.id === ownId) return hit.distance < hit.segment.width * 0.5 + 0.6;
    return hit.distance < hit.segment.width * 0.5 + 2.0;
  };

  for (const seg of segments) {
    if (!seg || seg.type === 'highway' || seg.type === 'path') continue;
    const len = seg.length || 0;
    const margin = seg.type === 'avenue' ? 15 : 11;
    if (len < margin * 2 + 16) continue;
    for (const side of [-1, 1]) {
      let s = margin;
      let guard = 0;
      while (s + 16 <= len - margin && guard++ < 400) {
        const probe = roads.sampleEdge(seg.id, (s + 8) / len, side);
        if (!probe) break;
        const type = typeFor(seg, probe.x + probe.nx * 12, probe.z + probe.nz * 12);
        if (!type || !SIZES[type]) { s += cellSize; continue; }
        const w = rng.pick(SIZES[type].w), d = rng.pick(SIZES[type].d);
        if (s + w > len - margin) { if (w > 16) { s += 0; } break; }
        const e0 = roads.sampleEdge(seg.id, s / len, side), e1 = roads.sampleEdge(seg.id, (s + w) / len, side);
        if (!e0 || !e1) break;
        const chord = Math.hypot(e1.x - e0.x, e1.z - e0.z);
        const wEff = Math.min(w, Math.max(12, chord));
        const mx = (e0.x + e1.x) / 2, mz = (e0.z + e1.z) / 2, my = (e0.y + e1.y) / 2;
        let nx = (e0.nx + e1.nx), nz = (e0.nz + e1.nz);
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        const gap = 1.0;
        const lot = {
          id: nextId, cells: [], x: mx + nx * (d / 2 + gap), z: mz + nz * (d / 2 + gap), w: wEff, d,
          yaw: Math.atan2(-nx, -nz), type, roadSegmentId: seg.id,
          frontage: { x: mx, y: my, z: mz, nx, nz }, buildingId: null, avenue: seg.type === 'avenue',
        };
        let ok = Math.abs(lot.x) < bound && Math.abs(lot.z) < bound;
        if (ok) {
          const corners = obbCorners(lot);
          const hs = [];
          for (const c of corners) {
            if (Math.abs(c.x) > bound || Math.abs(c.z) > bound) { ok = false; break; }
            if (terrain.isWater && terrain.isWater(c.x, c.z)) { ok = false; break; }
            hs.push(terrain.getHeight(c.x, c.z));
            // inset check point against crossing roads
            const ix = c.x + (lot.x - c.x) * 0.18, iz = c.z + (lot.z - c.z) * 0.18;
            if (tooCloseToRoad(ix, iz, seg.id)) { ok = false; break; }
          }
          if (ok) {
            if (terrain.isWater && terrain.isWater(lot.x, lot.z)) ok = false;
            else if (Math.max(...hs) - Math.min(...hs) > 4.5 + d * 0.08) ok = false;
            else if (tooCloseToRoad(lot.x, lot.z, seg.id)) ok = false;
            else if (tooCloseToRoad(lot.x + nx * (d / 2 - 2), lot.z + nz * (d / 2 - 2), seg.id)) ok = false;
            else if (index.collides(lot, 0.3)) ok = false;
          }
        }
        if (ok) {
          const cc = world.toCell(lot.x, lot.z);
          const cw = Math.max(1, Math.round(wEff / cellSize)), cd = Math.max(1, Math.round(d / cellSize));
          for (let i = 0; i < cw; i++) for (let j = 0; j < cd; j++) lot.cells.push({ cx: cc.cx - Math.floor(cw / 2) + i, cz: cc.cz - Math.floor(cd / 2) + j });
          index.add(lot);
          out.push(lot);
          nextId++;
          s += wEff;
        } else {
          s += cellSize;
        }
      }
    }
  }
  return out;
}
