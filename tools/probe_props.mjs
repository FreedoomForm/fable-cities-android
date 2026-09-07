// Props street-furniture golden probe — drives the REAL web PropScatter.segment() in Node on
// synthetic polyline segments (the same adapters the native renderer builds) and emits
// android/app/src/test/java/com/fablecities/android/worldgen/PropsGoldens.kt
import { writeFileSync } from 'node:fs';
import { PropScatter } from '../src/modules/props/PropScatter.js';
import { makeRng, hash2, hashString } from '../src/shared/random.js';

const SEED = 1337;

// ---- synthetic segments (identical to the Kotlin test's adapters) ------------------------------
const SEGS = [
  { id: 'd0', type: 'local', hw: 8.0, cwHalf: 3.8, sidewalk: 2.0 },
  { id: 'd1', type: 'avenue', hw: 11.0, cwHalf: 9.0, sidewalk: 2.8 },
  { id: 'd2', type: 'local', hw: 8.0, cwHalf: 3.8, sidewalk: 2.0 },
  { id: 'd3', type: 'path', hw: 3.5, cwHalf: 1.2, sidewalk: 0.0 },
  { id: 'd4', type: 'highway', hw: 15.0, cwHalf: 15.4, sidewalk: 0.0 },
];
// straight polylines of different lengths along x (deterministic)
const pts = (len) => {
  const out = [];
  const n = Math.max(2, Math.round(len / 8));
  for (let i = 0; i <= n; i++) out.push([i * (len / n), 0]);
  return out;
};
const LENGTHS = [260, 190, 130, 90, 300];
for (let i = 0; i < SEGS.length; i++) SEGS[i].pts = pts(LENGTHS[i]);

const heightFn = (x, z) => 2.0 + 0.01 * x - 0.01 * z;
const isWater = () => false;
// no buildings on the synthetic map
const inBuilding = () => false;

// ---- the REAL scatter on a bare instance --------------------------------------------------------
const props = Object.create(PropScatter.prototype);
Object.assign(props, {
  world: { seed: SEED, roads: { api: { surfaceHeight: () => null } } },
  density: 1.0,
  counts: {},
  items: [],
  slots: new Map(),
  buildings: [],
  carPalette: [0xf2f3f4, 0xe8e9ea, 0xd8dade, 0xb9bdc0, 0x9aa0a5, 0x6d7377, 0x2f3438, 0x1b1e21,
    0x2d4a72, 0x38607f, 0x6b2f33, 0x8f3b2c, 0x35513c, 0x7a6a4f, 0xc9a227, 0x1f4a3c],
  assets: { modelSizes: {} },
  ground: { run() {} },
  add(kind, item) {
    this.items.push({ kind, ...item });
    this.counts[kind] = (this.counts[kind] || 0) + 1;
  },
  luminaire() {},               // lights are the native lamp builder's job
  isWater,
  groundY: heightFn,
  paveY: (x, z, fb) => fb,
  indexBuildings() {},
  contacts() {},
  markPaved() {},
  isPaved: () => false,
  edge(seg, s, side) {
    const t = Math.min(1, Math.max(0, s / Math.max(1e-3, seg.length)));
    const e = sampleEdgePolyline(seg, t, side);
    if (!e) return null;
    e.tx = e.nz * side;
    e.tz = -e.nx * side;
    return e;
  },
});
function sampleEdgePolyline(seg, t, side) {
  const P = seg.pts;
  const acc = [0];
  for (let i = 1; i < P.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  }
  const s = t * acc[acc.length - 1];
  let lo = 0, hi = acc.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (acc[mid] <= s) lo = mid; else hi = mid; }
  const segLen = acc[lo + 1] - acc[lo];
  const u = segLen > 1e-9 ? (s - acc[lo]) / segLen : 0;
  const px = P[lo][0] + (P[lo + 1][0] - P[lo][0]) * u;
  const pz = P[lo][1] + (P[lo + 1][1] - P[lo][1]) * u;
  const tx = (P[lo + 1][0] - P[lo][0]) / segLen;
  const tz = (P[lo + 1][1] - P[lo][1]) / segLen;
  const rx = -tz, rz = tx;
  const lat = Math.sign(side || 1) * seg.hw;
  const x = px + rx * lat, z = pz + rz * lat;
  return { x, y: heightFn(x, z) + 0.20, z, nx: Math.sign(lat) * rx, nz: Math.sign(lat) * rz };
}

const segAdapters = SEGS.map((sg) => ({
  id: sg.id, type: sg.type, length: Math.hypot(sg.pts[sg.pts.length - 1][0] - sg.pts[0][0], 0),
  pts: sg.pts, hw: sg.hw, cwHalf: sg.cwHalf, sidewalk: sg.sidewalk, phase: 0, trimA: 0, trimB: 0,
  width: sg.hw * 2,
}));
// the web segment() reads def via types[seg.type].definition — feed ROAD_TYPES-like defs
const defs = {
  local: { cwHalf: 3.8, sidewalk: 2.0, hasCurb: true, lamps: { kind: 'street', spacing: 32, alternate: true, poleLat: 3.8 + 0.85, arm: 2.0, height: 9.0, radius: 11.0, color: [1.0, 0.70, 0.40] } },
  avenue: { cwHalf: 9.0, sidewalk: 2.8, hasCurb: true, lamps: { kind: 'street', spacing: 32, alternate: true, poleLat: 9.0 + 0.85, arm: 2.0, height: 9.0, radius: 13.0, color: [1.0, 0.70, 0.40] } },
  path: { cwHalf: 1.2, sidewalk: 0.0, hasCurb: false },
  highway: { cwHalf: 15.4, sidewalk: 0.0, hasCurb: false, lamps: { kind: 'mast', spacing: 46, alternate: false, poleLat: 0, arm: 2.6, height: 14.0, radius: 21, color: [1.0, 0.84, 0.62] } },
};
for (const seg of segAdapters) {
  props.slots.clear();
  props.items.length = 0;
  props.counts = {};
  props.segment(seg, defs[seg.type]);
}
// total scatter across all segments (the slots map persists per seg.id — do a full run)
props.slots.clear();
props.items.length = 0;
props.counts = {};
for (const seg of segAdapters) props.segment(seg, defs[seg.type]);

console.log('items', props.items.length, JSON.stringify(props.counts));

const ds = (v) => {
  let s = String(v);
  if (s === '-0') s = '0.0';
  if (!s.includes('.') && !s.includes('e') && !s.includes('Infinity')) s += '.0';
  return s;
};
const kinds = Object.keys(props.counts).sort();
const items = props.items;
const probes = items.slice(0, 40).map((it) => [it.kind, it.x, it.y, it.z, it.yaw, it.s]);
// NOTE: yaw is atan2-derived — V8 and the JVM differ by <=1 ulp on some angles, which scrambles an
// exact checksum, so the checksum covers the pure-arithmetic fields only (yaw stays in the probes
// with a tolerance)
let chk = 0;
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const tt = Array.isArray(it.tint) ? it.tint[0] * 6.07 + it.tint[1] * 7.01 + it.tint[2] * 8.03
    : (typeof it.tint === 'number' ? it.tint * 9.11 : 0.5);
  chk = (chk + (it.x * 1.37 + it.y * 2.13 + it.z * 3.19 + it.s * 5.01 + tt) * (i % 83 + 1)) % 4294967296;
}

const kotlin = `// GENERATED by tools/probe_props.mjs — goldens from the REAL PropScatter.segment() on synthetic
// polyline segments (local/avenue/local/path/highway at 260/190/130/90/300 m), seed 1337, D=1.0
package com.fablecities.android.worldgen

object PropsGoldens {
    const val itemCount = ${items.length}
    val kindCounts = mapOf(
${kinds.map((k) => '        "' + k + '" to ' + props.counts[k]).join(',\n')},
    )
    const val itemChk = ${chk}
    /** first 40 items: kind, x, y, z, yaw, s */
    val itemProbes = listOf(
${probes.map((p) => '        listOf("' + p[0] + '", ' + p.slice(1).map(ds).join(', ') + ')').join(',\n')},
    )
}
`;
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/PropsGoldens.kt', import.meta.url), kotlin);
console.log('PropsGoldens.kt written');

// debug dump for the item diff
writeFileSync('/tmp/props_web.txt', items.map((it, i) =>
  `${i} ${it.kind} ${it.x} ${it.y} ${it.z} ${it.yaw} ${it.s} ${Array.isArray(it.tint) ? 't' + it.tint.map((v) => v).join(',') : (typeof it.tint === 'number' ? 'h' + it.tint : '-')}`).join('\n'));
