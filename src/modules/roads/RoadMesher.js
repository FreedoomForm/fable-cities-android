/**
 * Geometry generation for road segments and junctions.
 *
 * A segment is a cross-section profile (asphalt, kerbs, sidewalks, median, barriers, verge skirt)
 * swept along its curve with adaptive station spacing; the end stations sit exactly at the junction
 * trims so the junction fan and corner strips share the same vertices → watertight, no z-fighting.
 * Asphalt, sidewalk and kerb vertices carry `aRoad = (lateral, along, distToEndA, distToEndB)`,
 * `aTurns` and `aSeg` (segment slot for info-view tinting) so the shaders can draw lane lines, stop
 * lines, crosswalks, turn arrows and the night light pools procedurally. Skirt vertices carry a
 * vertex colour: rgb = terrain ground tint at the toe, alpha = fade into the terrain.
 * Street lamps are emitted as instance records (pole position / yaw / kind) in step with the
 * analytic light pools of the shaders (same spacing, phase and lateral offsets).
 */
import { GeomBuilder, LAYOUT_BASIC, LAYOUT_ROAD, LAYOUT_SKIRT } from './GeomBuilder.js';
import { ROAD_TYPES, TERRAIN, SURFACE, BURY, SKIN, SHOULDER_DIRT, surfaceOffset, lampHeadLat } from './RoadTypes.js';
import { hash2, hashString, makeRng } from '../../shared/random.js';
import * as THREE from 'three';

const ROAD_LAYOUT_MATS = new Set(['asphalt_local', 'asphalt_avenue', 'asphalt_highway', 'sidewalk', 'curb', 'granite', 'median', 'soil']);
export const layoutFor = (mat) => (ROAD_LAYOUT_MATS.has(mat) ? LAYOUT_ROAD : mat === 'skirt' ? LAYOUT_SKIRT : LAYOUT_BASIC);
const NO_MARK = 1e5;
const LAMP_MARGIN = 3.0; // lamps keep this far from the trimmed segment ends (shader uses the same number)
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();

class PieceSet {
  constructor() { this.builders = new Map(); this.trees = []; this.posts = []; this.lamps = []; }
  get(mat) {
    let b = this.builders.get(mat);
    if (!b) { b = new GeomBuilder(layoutFor(mat)); this.builders.set(mat, b); }
    return b;
  }
  finish() {
    const byMat = new Map();
    let bbox = null;
    for (const [mat, b] of this.builders) {
      b.computeNormals();
      const raw = b.toRaw();
      if (!raw) continue;
      byMat.set(mat, raw);
      const bb = raw.bbox;
      if (!bbox) bbox = { ...bb };
      else {
        bbox.minX = Math.min(bbox.minX, bb.minX); bbox.minY = Math.min(bbox.minY, bb.minY); bbox.minZ = Math.min(bbox.minZ, bb.minZ);
        bbox.maxX = Math.max(bbox.maxX, bb.maxX); bbox.maxY = Math.max(bbox.maxY, bb.maxY); bbox.maxZ = Math.max(bbox.maxZ, bb.maxZ);
      }
    }
    if (!bbox && !this.trees.length && !this.posts.length && !this.lamps.length) return null;
    return { byMat, bbox, trees: this.trees, posts: this.posts, lamps: this.lamps };
  }
}

function frameAt(seg, s, network) {
  const L = seg.length;
  const u = L > 0 ? Math.min(1, Math.max(0, s / L)) : 0;
  seg.curve.getPointAt(u, _p);
  seg.curve.getTangentAt(u, _t);
  const l = Math.hypot(_t.x, _t.z) || 1;
  const tx = _t.x / l, tz = _t.z / l;
  return { x: _p.x, z: _p.z, y: network.heightAt(seg, s), tx, tz, rx: -tz, rz: tx, s };
}

/** Adaptive stations between s0 and s1: dense on curves, sparse on straights (but ≤ maxStep for terrain following). */
function stations(seg, s0, s1, network, quality = 1) {
  const out = [];
  if (s1 - s0 < 0.05) return out;
  const probe = 1.5, maxStep = quality >= 1 ? 8 : 12, minAngle = quality >= 1 ? 0.02 : 0.035;
  let last = frameAt(seg, s0, network);
  out.push(last);
  for (let s = s0 + probe; s < s1 - probe * 0.5; s += probe) {
    const f = frameAt(seg, s, network);
    const dot = f.tx * last.tx + f.tz * last.tz;
    const ang = Math.acos(Math.min(1, Math.max(-1, dot)));
    // vertical chord error: height at the midpoint vs. the straight chord from the last station
    const hMid = network.heightAt(seg, (last.s + s) * 0.5);
    const chord = Math.abs(hMid - (last.y + f.y) * 0.5);
    if (ang > minAngle || s - last.s >= maxStep || chord > 0.02 || Math.abs(f.y - last.y) > 0.25) { out.push(f); last = f; }
  }
  out.push(frameAt(seg, s1, network));
  return out;
}

/**
 * Evaluate profile points [[off, y, alpha?]] from an origin along normal n.
 * y === SURFACE → lies on the terrain; y === TERRAIN → buried below it. Both are pushed outwards on
 * embankments so the skirt becomes a graded 1:1.5 slope with a toe fillet instead of a wall.
 */
const SKIRT_SLOPE = 1.5; // horizontal metres per metre of drop (≈ 34°, a natural embankment)
function evalProfile(ox, oz, nx, nz, yBase, pts, world) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    let off = pts[i][0];
    const py = pts[i][1];
    let alpha = pts[i][2] == null ? 1 : pts[i][2];
    let x = ox + nx * off, z = oz + nz * off;
    let y;
    if (py === TERRAIN || py === SURFACE) {
      const prev = out[i - 1] || { off: off - 0.5, y: yBase };
      let ty = world.terrain.getHeight(x, z);
      const drop = prev.y - ty;
      // toe fillet: the last two points ease the slope out (1:1.5 → 1:3) into the ground
      const slope = i >= pts.length - 2 ? SKIRT_SLOPE * 2 : SKIRT_SLOPE;
      if (drop > 0.3) off = Math.max(off, prev.off + Math.min(30, drop * slope));
      if (out[i - 1]) off = Math.max(off, prev.off + 0.25);
      const pushed = off - pts[i][0];
      if (pushed > 1e-4) { x = ox + nx * off; z = oz + nz * off; ty = world.terrain.getHeight(x, z); }
      y = py === TERRAIN ? ty - BURY : ty + SKIN;
      // a SURFACE point must never rise above the strip it hangs from (cuts) — clamp to the base height
      if (py === SURFACE) y = Math.min(y, prev.y);
      // On a real cut/fill bank the embankment IS the ground: keep the turf opaque out to the toe so
      // the graded dirt underneath never shows through as a scar (only the last point still fades out).
      if (pushed > 0.5 && i < pts.length - 1) alpha = Math.max(alpha, Math.min(0.95, 0.45 + pushed * 0.12));
    } else y = yBase + py;
    // `gt` = how strongly this point takes the surrounding terrain's own colour. It is driven by the
    // profile's authored alpha, not the coverage alpha above, so widening an embankment does not turn it
    // into a flat lawn-green halo: the far half of every verge always reads as the local ground.
    const gt = 1 - (pts[i][2] == null ? 1 : pts[i][2]);
    out[i] = { x, y, z, off, a: alpha, gt, dark: pts[i][3] || 0, ground: py === TERRAIN || py === SURFACE };
  }
  return out;
}

/** Terrain ground tint for the skirt (grass verge → dry / sand / rock tones of the surrounding ground). */
function groundTint(world, x, z, out) {
  out[0] = out[1] = out[2] = 1;
  const api = world.terrain.api;
  if (!api || typeof api.groundInfo !== 'function') return out;
  const g = api.groundInfo(x, z);
  if (!g) return out;
  const dry = Math.min(1, g.dry || 0), sand = Math.min(1, g.sand || 0), rock = Math.min(1, g.rock || 0);
  const dirt = Math.min(1, (g.dirt || 0) * (1 - Math.min(1, g.forest || 0)));
  let r = 1, gg = 1, b = 1;
  r += dry * 0.10 + sand * 0.16 - rock * 0.26 - dirt * 0.08;
  gg += dry * 0.00 + sand * 0.10 - rock * 0.26 - dirt * 0.16;
  b += -dry * 0.28 + sand * 0.02 - rock * 0.24 - dirt * 0.32;
  out[0] = Math.max(0.4, r); out[1] = Math.max(0.4, gg); out[2] = Math.max(0.3, b);
  return out;
}

/** Add a row of vertices for one strip. `road` (optional) supplies aRoad/aTurns/aSeg for road layouts. */
function pushRow(builder, pts, uvFn, road) {
  const idx = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const uv = uvFn(p, i);
    idx[i] = builder.vertex({
      position: [p.x, p.y, p.z], uv,
      color: [p.tint ? p.tint[0] : 1, p.tint ? p.tint[1] : 1, p.tint ? p.tint[2] : 1, p.a == null ? 1 : p.a],
      aRoad: road ? [p.lat != null ? p.lat : road[0], road[1], road[2], road[3]] : undefined,
      aTurns: road ? road.turns : undefined,
      aSeg: road ? [road.slot || 0] : undefined,
      aDark: road ? [p.dark || 0] : undefined,
    });
  }
  return idx;
}

const markerY = (y) => (y === TERRAIN ? -0.4 : y === SURFACE ? -0.1 : y);
function profileDistances(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], markerY(pts[i][1]) - markerY(pts[i - 1][1])));
  return d;
}

/**
 * Sweep the edge strips of `type` along a list of stations. Each station:
 * { x, z, nx, nz, yBase, w, v, cw, dA, dB, slot, lamp:[headLat, spacing] | null }.
 * `reverse` flips the point order (left side of a segment) so winding stays consistent.
 * `uSign` is the lateral sign of this edge (+1 right, −1 left, 0 = corner strip without lane space).
 */
const RAIL_TERMINAL = 5.5;   // metres over which a free-ending guard rail is flared out and buried
/**
 * How much of a guard rail stands at this station. A W-beam that simply stops leaves a blunt cut face
 * floating over the shoulder (the critic's "guardrail stubs"); a real run is flared away from the
 * carriageway and buried in the backslope over 4-6 m. 1 = full height, 0 = laid into the verge.
 */
function railTerminal(st, term) {
  if (!term) return 1;
  let k = 1;
  if (term.a) k = Math.min(k, Math.max(0, st.dA - 0.3) / RAIL_TERMINAL);
  if (term.b) k = Math.min(k, Math.max(0, st.dB - 0.3) / RAIL_TERMINAL);
  k = Math.min(1, Math.max(0, k));
  return k * k * (3 - 2 * k);
}

function sweepEdge(pieces, type, list, reverse, world, uSign, term) {
  if (list.length < 2) return;
  const defs0 = type.edge(list[0].w);
  const tint = [1, 1, 1];
  for (let si = 0; si < defs0.length; si++) {
    let prev = null;
    const mat = defs0[si].mat;
    const builder = pieces.get(mat);
    const roadLayout = layoutFor(mat) === LAYOUT_ROAD;
    const skirt = mat === 'skirt';
    const rail = mat === 'guardrail';
    for (const st of list) {
      const def = type.edge(st.w)[si];
      let pts = def.pts;
      if (rail && term) {
        const k = railTerminal(st, term);
        // flare 1.15 m away from the carriageway while the beam drops to the verge: an end treatment,
        // not a cut face. The posts shrink with the same curve (see buildSegmentPieces).
        if (k < 0.999) pts = pts.map((q) => [q[0] + (1 - k) * 1.15, 0.03 + (q[1] - 0.03) * k, q[2], q[3]]);
      }
      const dist = profileDistances(pts);
      let row = evalProfile(st.x, st.z, st.nx, st.nz, st.yBase, pts, world);
      for (let i = 0; i < row.length; i++) {
        const p = row[i];
        p.pd = dist[i];
        p.lat = uSign === 0 ? NO_MARK : uSign * (st.cw + p.off);
        if (skirt) {
          let tr = 1, tg = 1, tb = 1;
          if (p.ground) {
            groundTint(world, p.x, p.z, tint);
            const k = Math.max(0.35, p.gt == null ? 1 - p.a : p.gt); // the verge always carries some ground tone
            tr = 1 + (tint[0] - 1) * k; tg = 1 + (tint[1] - 1) * k; tb = 1 + (tint[2] - 1) * k;
          }
          // The first 1.5 m beyond the kerb is compacted roadside grit in the kerb's own contact shadow —
          // never lawn. That band is what used to read as a bright smooth halo hugging every kerb.
          const g = Math.max(0, 1 - (p.off - pts[0][0]) / SHOULDER_DIRT) ** 2;
          const shade = 1 - 0.36 * g;
          tr *= shade * (1 + 0.26 * g); tg *= shade * (1 + 0.05 * g); tb *= shade * (1 - 0.26 * g);
          // ±9 % seeded mottling so the verge is never a flat sheet next to the tufted terrain
          const n = (Math.sin(p.x * 0.37 + p.z * 0.71) + Math.sin(p.x * 0.13 - p.z * 0.21) * 0.7) * 0.055;
          p.tint = [tr * (1 + n), tg * (1 + n * 0.85), tb * (1 + n * 1.2)];
        }
      }
      if (reverse) row = row.slice().reverse();
      let road = null;
      if (roadLayout) {
        road = [NO_MARK, st.v, st.dA, st.dB];
        road.turns = st.lamp || [0, 0];
        road.slot = st.slot || 0;
      }
      const uS = uSign === 0 ? 1 : uSign; // corner strips have no lane space but still need a real texture u
      const idx = pushRow(builder, row, (p) => (def.uv === 'along' ? [p.pd, st.v] : [uS * (st.cw + p.off), st.v]), road);
      if (skirt) {
        // toe vertices lean their normals into the terrain so the fade has no lighting crease
        for (let i = 0; i < row.length; i++) {
          const p = row[i];
          if (!p.ground || p.a >= 0.999) continue;
          world.terrain.getNormal(p.x, p.z, _n);
          builder.hintNormal(idx[i], _n.x, _n.y, _n.z, Math.min(1, (1 - p.a) * 0.9 + 0.1));
        }
      }
      if (prev) builder.bridge(prev, idx);
      prev = idx;
    }
  }
}

/** Rows of a segment's cross-section at station `s`, in the segment's own frame (left → right). */
export function sectionRows(seg, s, network, world) {
  const type = ROAD_TYPES[seg.type];
  const f = frameAt(seg, s, network);
  const asphalt = evalProfile(f.x, f.z, f.rx, f.rz, f.y, type.asphaltPts, world);
  const centre = type.centre.map((strip) => evalProfile(f.x, f.z, f.rx, f.rz, f.y, strip.pts, world));
  return { frame: f, asphalt, centre };
}

/** Same as sectionRows but ordered in the *outgoing* frame of the given end (left → right seen from the node). */
export function mouthRows(seg, end, network, world) {
  const s = end === 'a' ? seg.trimA : seg.length - seg.trimB;
  const rows = sectionRows(seg, s, network, world);
  if (end === 'b') {
    rows.asphalt.reverse();
    rows.centre = rows.centre.map((r) => r.slice().reverse()).reverse();
  }
  return rows;
}

/** A dished bare-soil planting pit around a median tree: rim at the turf, centre 4 cm lower, AO on the rim. */
function addTreePit(pieces, x, y, z, r) {
  if (!(r > 0.15)) return;
  const b = pieces.get('soil');
  const start = b.triCount;
  const mk = (px, pz, py, dark) => b.vertex({
    position: [px, py, pz], uv: [px, pz], aRoad: [px - x, pz - z, 400, 400], aTurns: [0, 0], aSeg: [0], aDark: [dark],
  });
  const centre = mk(x, z, y - 0.045, 0.16);
  const N = 12;
  const ring = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    ring.push(mk(x + Math.cos(a) * r, z + Math.sin(a) * r, y + 0.012, 0.62));
  }
  b.fan(centre, ring, true);
  b.orient(0, 1, 0, start);
}

function centreCap(builder, rows, tx, tz, sign) {
  // rows: array of strips' point rows at one station; union them into one polygon and fan it
  const poly = [];
  for (const r of rows) for (const p of r) {
    const last = poly[poly.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 1e-4 || Math.abs(last.y - p.y) > 1e-4) poly.push(p);
  }
  if (poly.length < 3) return;
  const start = builder.triCount;
  const idx = poly.map((p) => builder.vertex({ position: [p.x, p.y, p.z], uv: [p.off, p.y], color: [1, 1, 1, 1] }));
  for (let i = 1; i < idx.length - 1; i++) builder.tri(idx[0], idx[i], idx[i + 1]);
  builder.orient(sign * tx, 0, sign * tz, start);
}

/** Lamp index range whose poles fall inside [s0 + margin, s1 − margin] (along = s + phase; lamp i at along = (i + ½)·spacing). */
function lampRange(spacing, phase, s0, s1) {
  const iMin = Math.ceil((s0 + LAMP_MARGIN + phase) / spacing - 0.5);
  const iMax = Math.floor((s1 - LAMP_MARGIN + phase) / spacing - 0.5);
  return [iMin, iMax];
}

export function buildSegmentPieces(seg, network, world, quality = 1) {
  const type = ROAD_TYPES[seg.type];
  const pieces = new PieceSet();
  const L = seg.length;
  const s0 = Math.min(seg.trimA, L), s1 = Math.max(s0, L - seg.trimB);
  if (s1 - s0 < 0.05) return pieces.finish();
  const list = stations(seg, s0, s1, network, quality);
  // the guard-rail terminal is a 5.5 m curve; on a straight the adaptive stations are 8 m apart, so pack
  // a few extra rows into each free end (they cost one row per edge strip)
  if (ROAD_TYPES[seg.type].posts && (seg.capA || seg.capB) && s1 - s0 > 3) {
    const extra = [];
    for (const k of [0.6, 1.4, 2.4, 3.5, 4.7]) {
      if (seg.capA) extra.push(s0 + k);
      if (seg.capB) extra.push(s1 - k);
    }
    for (const sv of extra) if (sv > s0 + 0.05 && sv < s1 - 0.05) list.push(frameAt(seg, sv, network));
    list.sort((a, b) => a.s - b.s);
  }
  const turns = [seg.flagsA, seg.flagsB];
  const dA = (s) => s - s0;
  const dB = (s) => s1 - s;
  const along = (s) => s + seg.phase;
  const lm = type.lamps;
  const lampInfo = lm ? [lampHeadLat(type) + (seg.flagsA & 31 ? 100 : 0) + (seg.flagsB & 31 ? 200 : 0), lm.spacing] : null;

  // --- asphalt (full width, crowned) ---
  {
    const b = pieces.get(type.asphaltMat);
    let prev = null;
    for (const f of list) {
      const row = evalProfile(f.x, f.z, f.rx, f.rz, f.y, type.asphaltPts, world);
      row.forEach((p) => { p.lat = p.off; });
      const road = [0, along(f.s), dA(f.s), dB(f.s)];
      road.turns = turns;
      road.slot = seg.slot;
      const idx = pushRow(b, row, (p) => [p.off, along(f.s)], road);
      if (prev) b.bridge(prev, idx);
      prev = idx;
    }
  }

  // --- centre strips: median with kerbs, or motorway barrier ---
  if (type.centre.length) {
    const c0 = s0 + seg.gapA, c1 = s1 - seg.gapB;
    if (c1 - c0 > 0.5) {
      // A median or Jersey barrier that simply stops dead leaves a blunt slab floating at the junction
      // mouth. Every free end is instead tapered to a wedge nose over up to 9 m (real medians do this),
      // with extra stations packed into the taper so the wedge is smooth.
      const nose = Math.min(9, (c1 - c0) * 0.42);
      const noseA = seg.capA && !seg.bridgeA ? nose : 0;
      const noseB = seg.capB && !seg.bridgeB ? nose : 0;
      const noseScale = (s) => {
        let k = 1;
        if (noseA > 0.05) { const t = Math.min(1, Math.max(0, (s - c0) / noseA)); k = Math.min(k, 1 - (1 - t) * (1 - t)); }
        if (noseB > 0.05) { const t = Math.min(1, Math.max(0, (c1 - s) / noseB)); k = Math.min(k, 1 - (1 - t) * (1 - t)); }
        return Math.max(0.05, k);
      };
      const clist = stations(seg, c0, c1, network, quality);
      if (noseA > 0.05 || noseB > 0.05) {
        const extra = [];
        for (const base of [noseA > 0.05 ? c0 : null, noseB > 0.05 ? c1 : null]) {
          if (base == null) continue;
          const dir = base === c0 ? 1 : -1;
          for (let k = 1; k <= 7; k++) extra.push(base + dir * nose * (k / 8) ** 1.4);
        }
        for (const sv of extra) if (sv > c0 + 0.02 && sv < c1 - 0.02) clist.push(frameAt(seg, sv, network));
        clist.sort((a, b2) => a.s - b2.s);
      }
      const scaled = (pts, sc) => (sc >= 0.999 ? pts : pts.map((q) => [q[0] * sc, typeof q[1] === 'number' ? q[1] * sc : q[1], q[2], q[3]]));
      type.centre.forEach((strip) => {
        const b = pieces.get(strip.mat);
        let prev = null;
        for (const f of clist) {
          const sc = noseScale(f.s);
          const pts = scaled(strip.pts, sc);
          const dist = profileDistances(pts);
          const row = evalProfile(f.x, f.z, f.rx, f.rz, f.y, pts, world);
          row.forEach((p, i) => { p.pd = dist[i]; p.lat = p.off; });
          const road = layoutFor(strip.mat) === LAYOUT_ROAD ? [0, along(f.s), dA(f.s), dB(f.s)] : null;
          if (road) { road.turns = lampInfo || [0, 0]; road.slot = seg.slot; }
          const idx = pushRow(b, row, (p) => (strip.uv === 'along' ? [p.pd, along(f.s)] : [p.off, along(f.s)]), road);
          if (prev) b.bridge(prev, idx);
          prev = idx;
        }
      });
      const capMat = type.centre.find((st) => layoutFor(st.mat) === LAYOUT_BASIC)?.mat || type.centre[0].mat;
      if (seg.capA && !seg.bridgeA) {
        const f = clist[0];
        centreCap(pieces.get(capMat), type.centre.map((st) => evalProfile(f.x, f.z, f.rx, f.rz, f.y, scaled(st.pts, noseScale(f.s)), world)), f.tx, f.tz, -1);
      }
      if (seg.capB && !seg.bridgeB) {
        const f = clist[clist.length - 1];
        centreCap(pieces.get(capMat), type.centre.map((st) => evalProfile(f.x, f.z, f.rx, f.rz, f.y, scaled(st.pts, noseScale(f.s)), world)), f.tx, f.tz, 1);
      }
      // median trees
      if (type.trees) {
        const rng = makeRng(hash2(world.seed, hashString(seg.id + ':trees')));
        const tr = type.trees;
        let s = c0 + tr.minFromEnd + rng() * tr.spacing * 0.5;
        while (s < c1 - tr.minFromEnd) {
          const f = frameAt(seg, s, network);
          const medianTop = type.centre[1] ? type.centre[1].pts[0][1] : 0.14;
          pieces.trees.push({ x: f.x, y: f.y + medianTop - 0.05, z: f.z, scale: 0.85 + rng() * 0.4, yaw: rng() * Math.PI * 2, tint: 0.85 + rng() * 0.3 });
          // dished planting pit: bare soil with an AO-dark rim, so the tree stands in a bed, not in turf
          if (tr.pit) addTreePit(pieces, f.x, f.y + medianTop, f.z, Math.min(tr.pit, type.medianHalf - 0.3));
          s += tr.spacing + (rng() - 0.5) * 2 * tr.jitter;
        }
      }
    }
  }

  // --- edges (kerb, sidewalk, verge skirt / shoulder, guard rail) ---
  const sw = type.sidewalk;
  const cw = type.cwHalf;
  const yEdgeOff = surfaceOffset(type, cw);
  const mk = (f, sign) => ({
    x: f.x + sign * f.rx * cw, z: f.z + sign * f.rz * cw, nx: sign * f.rx, nz: sign * f.rz, yBase: f.y + yEdgeOff,
    w: sw, v: along(f.s), cw, dA: dA(f.s), dB: dB(f.s), slot: seg.slot, lamp: lampInfo,
  });
  // `capA/capB` are true exactly where the run of edge furniture terminates (dead end, intersection, or a
  // junction with a road of another type) — the same test the median nose uses.
  const railTerm = type.posts ? { a: !!seg.capA, b: !!seg.capB } : null;
  sweepEdge(pieces, type, list.map((f) => mk(f, 1)), false, world, 1, railTerm);
  sweepEdge(pieces, type, list.map((f) => mk(f, -1)), true, world, -1, railTerm);

  // --- guard-rail posts ---
  if (type.posts) {
    const ps = type.posts;
    for (let s = s0 + 1.5; s < s1 - 1; s += ps.spacing) {
      const f = frameAt(seg, s, network);
      const k = railTerminal({ dA: dA(f.s), dB: dB(f.s) }, railTerm);
      if (k < 0.10) continue;                       // buried section: no post pokes out of the verge
      const lat = cw + ps.lateral + (1 - k) * 1.15; // follow the flare
      const y = f.y + yEdgeOff - 0.02;
      const yaw = Math.atan2(f.tx, f.tz);
      pieces.posts.push({ x: f.x + f.rx * lat, y, z: f.z + f.rz * lat, yaw, h: k });
      pieces.posts.push({ x: f.x - f.rx * lat, y, z: f.z - f.rz * lat, yaw, h: k });
    }
  }

  // --- street lamps (in step with the shader's analytic light pools) ---
  if (lm) {
    const [iMin, iMax] = lampRange(lm.spacing, seg.phase, s0, s1);
    for (let i = iMin; i <= iMax; i++) {
      const s = (i + 0.5) * lm.spacing - seg.phase;
      const f = frameAt(seg, s, network);
      const side = lm.alternate ? ((((i % 2) + 2) % 2) === 0 ? 1 : -1) : 0;
      const lat = side * lm.poleLat;
      let y;
      if (side === 0) y = f.y + (type.centre[1] ? type.centre[1].pts[0][1] : 0);
      else y = f.y + surfaceOffset(type, side * cw) + (type.hasCurb ? 0.20 : 0.03);
      // arm points toward the carriageway (−outward normal); masts point their two arms across the road
      const ax = side === 0 ? f.rx : -side * f.rx, az = side === 0 ? f.rz : -side * f.rz;
      pieces.lamps.push({ x: f.x + f.rx * lat, y, z: f.z + f.rz * lat, yaw: Math.atan2(-az, ax), kind: lm.kind });
    }
  }
  return pieces.finish();
}

function polygonArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) * 0.5;
}

/** Debug assert: the fan ring must be a simple polygon (no self-intersections) — otherwise terrain could show through. */
function ringIsSimple(ring) {
  const n = ring.length;
  const cross = (ax, az, bx, bz) => ax * bz - az * bx;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-6) continue;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      const d1 = cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z), d2 = cross(b.x - a.x, b.z - a.z, d.x - a.x, d.z - a.z);
      const d3 = cross(d.x - c.x, d.z - c.z, a.x - c.x, a.z - c.z), d4 = cross(d.x - c.x, d.z - c.z, b.x - c.x, b.z - c.z);
      if (d1 * d2 < -1e-9 && d3 * d4 < -1e-9) return false;
    }
  }
  return true;
}

/** Cumulative plan arclength of a polyline, normalised to [0,1] (plus the total). */
function arcFractions(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = d[d.length - 1] || 1;
  return { f: d.map((v) => v / total), length: d[d.length - 1] };
}

/**
 * Sample a polyline at normalised arclength fractions. Every sample lies exactly on a chord of the
 * original polyline, so a loft built on the union of two polylines' own fractions stays watertight
 * against both of them (no sliver gaps against the corner sidewalks).
 */
function sampleAtFractions(pts, fr, fracs) {
  const out = [];
  for (const t of fracs) {
    let i = 1;
    while (i < fr.length - 1 && fr[i] < t) i++;
    const span = fr[i] - fr[i - 1] || 1;
    const w = Math.min(1, Math.max(0, (t - fr[i - 1]) / span));
    const a = pts[i - 1], b = pts[i];
    out.push({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, z: a.z + (b.z - a.z) * w });
  }
  return out;
}

/** Piecewise-linear sample of `ys` at fractions `fs` (both ascending, same length). */
function sampleAt(fs, ys, f) {
  if (f <= fs[0]) return ys[0];
  for (let i = 1; i < fs.length; i++) {
    if (f <= fs[i]) {
      const w = (f - fs[i - 1]) / (fs[i] - fs[i - 1] || 1);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * w;
    }
  }
  return ys[ys.length - 1];
}

/**
 * k = 2 nodes (curve joints and, above all, the motorway → avenue transition) are lofted into a real
 * ribbon of carriageway instead of a blank triangle fan: the two corner arcs are the left/right
 * boundary, the mouth cross-sections are interpolated across it, and the road-space coordinates are
 * *normalised* to the dominant type's half width — so its lane lines, wheel tracks and gutter grime
 * taper smoothly with the carriageway instead of stopping at a hard seam. Where the two ends are of
 * different types the markings cross-fade out towards the narrower mouth (a real lane-drop taper).
 * Medians / Jersey barriers are carried in as a wedge-shaped nose from each mouth.
 * Returns true when the pad was built (the caller then skips the fan).
 */
function buildTransitionPad(node, network, world, pieces, mouths, J) {
  const e0 = J.ends[0], e1 = J.ends[1];
  if (!e0 || !e1 || e0.type.lanes <= 0 || e1.type.lanes <= 0) return false;
  const c0 = J.corners.find((c) => c.i === 0), c1 = J.corners.find((c) => c.i === 1);
  if (!c0 || !c1 || c0.degenerate || c1.degenerate || c0.pts.length < 2 || c1.pts.length < 2) return false;
  const rowA = mouths[0].asphalt, rowB = mouths[1].asphalt;
  if (rowA.length < 2 || rowB.length < 2) return false;
  const segA = network.segments.get(e0.segId), segB = network.segments.get(e1.segId);
  if (!segA || !segB) return false;

  // boundaries, both running mouth 0 → mouth 1: corner 0 is R0 → L1, corner 1 is R1 → L0
  const rightRaw = c0.pts, leftRaw = c1.pts.slice().reverse();
  const frL = arcFractions(leftRaw), frR = arcFractions(rightRaw);
  const span = Math.max(frL.length, frR.length);
  const fset = new Set([0, 1]);
  for (const t of frL.f) fset.add(Math.round(t * 1e4) / 1e4);
  for (const t of frR.f) fset.add(Math.round(t * 1e4) / 1e4);
  const extra = Math.min(16, Math.round(span / 2.5));
  for (let i = 1; i < extra; i++) fset.add(Math.round((i / extra) * 1e4) / 1e4);
  const T = [...fset].sort((a, b) => a - b);
  const nStat = T.length - 1;
  const Lp = sampleAtFractions(leftRaw, frL.f, T), Rp = sampleAtFractions(rightRaw, frR.f, T);
  // centreline arc length — too short a pad is just a joint, the fan handles it fine
  const mid = [];
  let padLen = 0;
  for (let s = 0; s <= nStat; s++) {
    const m = { x: (Lp[s].x + Rp[s].x) / 2, z: (Lp[s].z + Rp[s].z) / 2 };
    if (s > 0) padLen += Math.hypot(m.x - mid[s - 1].x, m.z - mid[s - 1].z);
    m.s = padLen;
    mid.push(m);
  }
  if (padLen < 1.2 || nStat < 2) return false;

  // lateral fractions: the union of both mouths' profile break-points keeps the loft watertight
  const fracsOf = (row) => {
    const x0 = row[0], x1 = row[row.length - 1];
    const span = Math.hypot(x1.x - x0.x, x1.z - x0.z) || 1;
    return row.map((p) => Math.min(1, Math.max(0, Math.hypot(p.x - x0.x, p.z - x0.z) / span)));
  };
  const fA = fracsOf(rowA), fB = fracsOf(rowB);
  const fracs = new Set([0, 1]);
  for (const f of fA) fracs.add(Math.round(f * 1e4) / 1e4);
  for (const f of fB) fracs.add(Math.round((1 - f) * 1e4) / 1e4);
  const V = [...fracs].sort((a, b) => a - b);
  // camber residuals relative to the straight L→R chord at each mouth
  const chordA = (v) => rowA[0].y + (rowA[rowA.length - 1].y - rowA[0].y) * v;
  const chordB = (v) => rowB[rowB.length - 1].y + (rowB[0].y - rowB[rowB.length - 1].y) * v;
  const resA = V.map((v) => sampleAt(fA, rowA.map((p) => p.y), v) - chordA(v));
  const resB = V.map((v) => sampleAt(fB, rowB.map((p) => p.y), 1 - v) - chordB(v));

  // dominant end drives the markings; road space is normalised to its half width
  const dIdx = e1.type.rank > e0.type.rank ? 1 : 0;
  const eD = dIdx === 0 ? e0 : e1, eO = dIdx === 0 ? e1 : e0;
  const segD = dIdx === 0 ? segA : segB;
  const cwD = eD.type.cwHalf, cwO = eO.type.cwHalf;
  const latSign = (eD.end === 'a' ? 1 : -1) * (dIdx === 0 ? 1 : -1);
  const along0 = segD.phase + (eD.end === 'b' ? segD.length - segD.trimB : segD.trimA);
  const alongSgn = eD.end === 'b' ? 1 : -1;

  const b = pieces.get(eD.type.asphaltMat);
  const start = b.triCount;
  // aDark packs the pad's geometry for the marking shader: rHere (this station's half width ÷ the
  // dominant type's) plus 4·round(255·rNarrow) (the half width the road keeps). rNarrow is constant over
  // the pad and rHere is linear along it, so the pair survives vertex interpolation exactly.
  const rNarrow = Math.min(1, Math.max(0.02, cwO / cwD));
  const padCode = 4 * Math.round(rNarrow * 255);
  let prev = null;
  for (let s = 0; s <= nStat; s++) {
    const q = dIdx === 0 ? s / nStat : 1 - s / nStat;   // 0 at the dominant mouth, 1 at the other
    const arc = dIdx === 0 ? mid[s].s : padLen - mid[s].s;
    const alongVal = along0 + alongSgn * arc;
    const cwHere = cwD + (cwO - cwD) * q;
    const dark = padCode + Math.min(1, cwHere / cwD);
    const row = [];
    for (let vi = 0; vi < V.length; vi++) {
      const v = V[vi];
      const x = Lp[s].x + (Rp[s].x - Lp[s].x) * v;
      const z = Lp[s].z + (Rp[s].z - Lp[s].z) * v;
      const chord = Lp[s].y + (Rp[s].y - Lp[s].y) * v;
      const y = chord + resA[vi] + (resB[vi] - resA[vi]) * (s / nStat);
      const u = 2 * v - 1;
      // PHYSICAL lateral: the dominant road's lane lines run straight into the pad and the carriageway
      // narrows around them (a real lane drop). Normalising lat to the mouth width made every line skew
      // diagonally across the pad — the "dashed stitch" the critic saw on the motorway transition.
      const off = latSign * u * cwHere;
      row.push({ x, y, z, off, lat: off, dark });
    }
    const road = [0, alongVal, 400, 400];
    road.turns = [0, 0];
    road.slot = segD.slot;
    const idx = pushRow(b, row, (p) => [p.off, alongVal], road);
    if (prev) b.bridge(prev, idx);
    prev = idx;
  }
  b.orient(0, 1, 0, start);
  // Median / barrier noses are NOT built here: every capped centre strip already tapers to a wedge on the
  // segment side (see buildSegmentPieces), which keeps the nose attached to the barrier instead of leaving
  // a blunt stub on the segment and a detached wedge floating in the pad.
  return true;
}

export function buildJunctionPieces(node, network, world) {
  const J = node.junction;
  if (!J) return null;
  const pieces = new PieceSet();
  const k = J.k;
  const mouths = J.ends.map((e) => mouthRows(network.segments.get(e.segId), e.end, network, world));
  const lofted = k === 2 && buildTransitionPad(node, network, world, pieces, mouths, J);

  // --- asphalt fan: the ring is the segment caps' own cross-section vertices plus the corner arcs ---
  const ring = [];
  for (let i = 0; i < k; i++) {
    ring.push(...mouths[i].asphalt);
    const c = J.corners[i];
    if (c && !c.degenerate) for (let p = 1; p < c.pts.length - 1; p++) ring.push({ x: c.pts[p].x, y: c.pts[p].y, z: c.pts[p].z });
  }
  if (!lofted && ring.length >= 3 && polygonArea(ring) > 0.1) {
    if (!ringIsSimple(ring)) network.badFans = (network.badFans || 0) + 1;
    const b = pieces.get(J.dominant.asphaltMat);
    const yc = node.y; // the pad plane passes through the node
    // fan vertices: (dx, dz) from the node, FAN marker, pad radius — the shader paints the junction light pool from it
    const fanRoad = (p) => [p.x - node.x, p.z - node.z, -NO_MARK, J.padRadius];
    // texture the fan in the frame of the dominant segment's mouth so the asphalt continues seamlessly
    // across the junction; it also lends the fan that segment's info-view tint
    let slot = 0, uvOf = (p) => [p.x, p.z];
    for (let i = 0; i < k; i++) {
      const e = J.ends[i], s = network.segments.get(e.segId);
      if (!s || e.type !== J.dominant) continue;
      slot = s.slot;
      const f = e.frame; // outgoing frame at the mouth (away from the node)
      const atB = e.end === 'b';
      const along0 = s.phase + (atB ? s.length - s.trimB : s.trimA);
      const sgn = atB ? 1 : -1; // along grows toward the node for end b, away from it for end a
      uvOf = (p) => {
        const dx = p.x - f.x, dz = p.z - f.z;
        const fwd = -(dx * f.dx + dz * f.dz); // distance from the mouth into the junction
        const lat = dx * f.rx + dz * f.rz;
        return [atB ? -lat : lat, along0 + sgn * fwd];
      };
      break;
    }
    // The wear pass needs two more things on the pad (RoadMaterials GLSL_MARKINGS, fan branch):
    //  aTurns.y = the node's own along-coordinate, so `along − that` is the CROSSING arm's lateral and
    //             both approaches' wheel tracks can be laid in the junction's own frame;
    //  aDark    = 0 at the node, 1 on the kerb line — a true distance-to-rim for the gutter grime and
    //             the kerb-foot AO, which follow the real fan boundary rather than a circle.
    const uvNode = uvOf({ x: node.x, z: node.z });
    const fanTurns = [k, uvNode[1]];
    const start = b.triCount;
    const centre = b.vertex({ position: [node.x, yc, node.z], uv: uvNode, aRoad: fanRoad(node), aTurns: fanTurns, aSeg: [slot], aDark: [0] });
    const idx = ring.map((p) => b.vertex({ position: [p.x, p.y, p.z], uv: uvOf(p), aRoad: fanRoad(p), aTurns: fanTurns, aSeg: [slot], aDark: [1] }));
    b.fan(centre, idx, true);
    b.orient(0, 1, 0, start);
  }

  // --- corner sidewalks (traverse from L_j back to R_i for consistent winding) ---
  for (let i = 0; i < k; i++) {
    const c = J.corners[i];
    if (!c || c.degenerate || c.pts.length < 2) continue;
    const type = c.edgeType;
    const pts = c.pts.slice().reverse();
    let v = 0;
    const list = [];
    const inset = (type.hasCurb ? 0.2 : 0) + (type.verge || 0);
    for (let p = 0; p < pts.length; p++) {
      if (p > 0) v += Math.hypot(pts[p].x - pts[p - 1].x, pts[p].z - pts[p - 1].z);
      list.push({ x: pts[p].x, z: pts[p].z, nx: pts[p].nx, nz: pts[p].nz, yBase: pts[p].y, w: Math.max(type.sidewalk * 0.02, pts[p].w - inset), v, cw: 0, dA: 0, dB: 0, slot: 0, lamp: null });
    }
    // guard: a sidewalk narrower than the kerb collapses the kerb — keep a sliver
    for (const st of list) if (type.hasCurb && st.w < 0.25) st.w = 0.25;
    sweepEdge(pieces, type, list, false, world, 0);
    if (k >= 3 && c.kind === 'fillet' && type.lamps && type.lamps.kind === 'street') {
      const m = c.pts[Math.floor(c.pts.length / 2)];
      const off = 0.85;
      const lx = m.x + m.nx * off, lz = m.z + m.nz * off;
      pieces.lamps.push({ x: lx, y: m.y + (type.hasCurb ? 0.20 : 0.03), z: lz, yaw: Math.atan2(-(node.z - lz), node.x - lx), kind: 'street' });
    }
  }

  // --- k = 2 continuation: carry medians / barriers across the junction ---
  if (k === 2 && J.bridgeCentre) {
    const type = J.ends[0].type;
    const rowsI = mouths[0].centre, rowsJ = mouths[1].centre;
    type.centre.forEach((strip, ci) => {
      const b = pieces.get(strip.mat);
      const dist = profileDistances(strip.pts);
      const ri = rowsI[ci].slice().reverse(), rj = rowsJ[ci];
      const road = layoutFor(strip.mat) === LAYOUT_ROAD ? [NO_MARK, 0, 0, 0] : null;
      if (road) { road.turns = [0, 0]; road.slot = 0; }
      const mk = (row, v) => pushRow(b, row.map((p, n) => ({ ...p, lat: NO_MARK, pd: dist[strip.uv === 'along' ? (row === ri ? row.length - 1 - n : n) : n] })), (p) => (strip.uv === 'along' ? [p.pd, v] : [p.off, v]), road);
      const a = mk(ri, 0), bb = mk(rj, Math.hypot(mouths[0].frame.x - mouths[1].frame.x, mouths[0].frame.z - mouths[1].frame.z));
      b.bridge(a, bb);
    });
  }
  return pieces.finish();
}
