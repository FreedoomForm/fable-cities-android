// LaneNetwork golden probe — runs the REAL web traffic/LaneNetwork.js + traffic/TrafficSim.js in
// Node on a synthetic junction graph (signalised avenue 4-way, signalised avenue T, priority
// local crossing, dead-end U-turns) and emits worldgen/LaneNetGoldens.kt.
// The Kotlin port (worldgen/Traffic.kt LaneNetwork + TrafficSim) must reproduce the element
// graph, junction records (phases / desync hash / conflict matrix), spawn table, A* routes,
// signal evolution and the driven simulation bit-exactly.
import { writeFileSync } from 'node:fs';
import { LaneNetwork } from '../src/modules/traffic/LaneNetwork.js';
import { TrafficSim } from '../src/modules/traffic/TrafficSim.js';
import { makeRng, hashString } from '../src/shared/random.js';

// ------------------------------------------------------------------ synthetic graph
// Segments: [id, a, b, type, midpoints]
const SEGS = [
  { id: 'avEW_w', type: 'avenue', a: 'W', b: 'C', pts: [[-90, 0], [-67.5, 0.8], [-45, 0]] },
  { id: 'avEW_m', type: 'avenue', a: 'C', b: 'A', pts: [[-45, 0], [-22.5, 0], [0, 0]] },
  { id: 'avEW_e', type: 'avenue', a: 'A', b: 'E', pts: [[0, 0], [45, 0.6], [90, 0]] },
  { id: 'avNS_s', type: 'avenue', a: 'S', b: 'A', pts: [[0, -90], [0, -45], [0, 0]] },
  { id: 'avNS_n', type: 'avenue', a: 'A', b: 'N', pts: [[0, 0], [0, 45], [0, 90]] },
  { id: 'locNS_s', type: 'local', a: 'P', b: 'K', pts: [[-45, -90], [-45, -67.5], [-45, -45]] },
  { id: 'locNS_n', type: 'local', a: 'K', b: 'C', pts: [[-45, -45], [-45, -22.5], [-45, 0]] },
  { id: 'locEW_w', type: 'local', a: 'L', b: 'K', pts: [[-90, -45], [-67.5, -45.7], [-45, -45]] },
  { id: 'locEW_e', type: 'local', a: 'K', b: 'R', pts: [[-45, -45], [-22.5, -45], [0, -45]] },
];
const TYPE = Object.fromEntries(SEGS.map((s) => [s.id, s.type]));
const SPEED = { avenue: 60, local: 50 };
const OFFS = { avenue: [3.375, 7.125], local: [1.9] }; // right of a→b, inner → outer
const WIDTH = { avenue: 3.75, local: 3.8 };
const NODES = {};
for (const s of SEGS) { NODES[s.a] = s.pts[0]; NODES[s.b] = s.pts[s.pts.length - 1]; }
const nodeSegments = {};
for (const s of SEGS) { (nodeSegments[s.a] ??= []).push(s.id); (nodeSegments[s.b] ??= []).push(s.id); }

const KMH = 1 / 3.6;
const headingOf = (dx, dz) => Math.atan2(dx, -dz);       // 0 = north (−Z), clockwise positive
function wrapPi(a) { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }

// lanes of a segment, both directions; rank = index within its direction group (inner → outer)
function segLanes(seg) {
  const pts = seg.pts.map(([x, y]) => [x, y, 0]);
  const ax = pts[0][0], az = pts[0][1];
  const bx = pts[pts.length - 1][0], bz = pts[pts.length - 1][1];
  const dl = Math.hypot(bx - ax, bz - az) || 1;
  const rx = -(bz - az) / dl, rz = (bx - ax) / dl;        // right of a→b travel
  const lanes = [];
  for (const dir of [1, -1]) {
    OFFS[seg.type].forEach((off, rank) => {
      const lat = off * dir;
      lanes.push({ id: `${seg.id}:${dir}:${rank}`, points: pts.map(([x, y]) => ({ x: x + rx * lat, y, z: 0 })), speed: SPEED[seg.type], segmentId: seg.id, dir, from: dir === 1 ? seg.a : seg.b, to: dir === 1 ? seg.b : seg.a, width: WIDTH[seg.type], rank });
    });
  }
  return lanes;
}
const LANES = SEGS.flatMap(segLanes);
const lanesById = new Map(LANES.map((l) => [l.id, l]));

// outDir: unit direction pointing AWAY from the node along the segment (RoadNetwork._outDir)
function outDir(seg, nodeId) {
  const atA = seg.a === nodeId;
  const p0 = atA ? seg.pts[0] : seg.pts[seg.pts.length - 1];
  const p1 = atA ? seg.pts[seg.pts.length - 1] : seg.pts[0];
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
const classify = (travel, out) => {
  const rel = wrapPi(headingOf(out.x, out.z) - headingOf(travel.x, travel.z));
  const a = Math.abs(rel);
  if (a <= Math.PI / 6) return 'S';
  if (a >= (5 * Math.PI) / 6) return 'U';
  return rel > 0 ? 'R' : 'L';
};

// connections — a faithful transcription of roads/RoadNetwork.js laneGraph()
const connections = new Map(LANES.map((l) => [l.id, []]));
const SEGBY = Object.fromEntries(SEGS.map((s) => [s.id, s]));
for (const nodeId of Object.keys(NODES)) {
  const segIds = nodeSegments[nodeId] || [];
  const ends = segIds.map((id) => SEGBY[id]).map((seg) => ({ seg, dir: outDir(seg, nodeId) }));
  const vEnds = ends.filter((e) => lanesOf(e.seg).length > 0);
  function lanesOf(seg) { return LANES.filter((l) => l.segmentId === seg.id); }
  for (const e of vEnds) {
    const segLs = lanesOf(e.seg);
    const incoming = segLs.filter((l) => l.to === nodeId);
    if (!incoming.length) continue;
    const n = incoming.length;
    const travel = { x: -e.dir.x, z: -e.dir.z };
    const others = vEnds.filter((o) => o !== e).map((o) => ({
      ...o, cls: classify(travel, o.dir), out: lanesOf(o.seg).filter((l) => l.from === nodeId).sort((a, b) => a.rank - b.rank),
    }));
    for (const lane of incoming) {
      const r = lane.rank;
      const conn = connections.get(lane.id);
      const connectMatched = (out) => {
        if (!out.length) return;
        const m = out.length;
        conn.push(out[Math.min(r, m - 1)].id);
        if (r === n - 1) for (let k = r + 1; k < m; k++) conn.push(out[k].id);
      };
      if (vEnds.length === 1) {
        const back = segLs.filter((l) => l.from === nodeId).sort((a, b) => a.rank - b.rank);
        if (back.length) conn.push(back[Math.min(r, back.length - 1)].id);
      } else if (vEnds.length === 2) {
        connectMatched(others[0].out);
      } else {
        for (const o of others) {
          if (o.cls === 'S') connectMatched(o.out);
          else if (o.cls === 'L' && (r === 0 || n === 1) && o.out.length) conn.push(o.out[0].id);
          else if (o.cls === 'R' && (r === n - 1 || n === 1) && o.out.length) conn.push(o.out[o.out.length - 1].id);
        }
        if (!conn.length) for (const o of others) if (o.cls !== 'U') connectMatched(o.out);
        if (!conn.length) for (const o of others) connectMatched(o.out);
      }
    }
  }
}

const graph = {
  lanes: LANES,
  connections,
  nodePos: Object.fromEntries(Object.entries(NODES).map(([k, v]) => [k, [v[0], v[1]]])),
  segType: TYPE,
};
const connCount = [...connections.values()].reduce((s, a) => s + a.length, 0);
console.log('graph: lanes', LANES.length, 'connections', connCount, 'nodes', Object.keys(NODES).length);

// ------------------------------------------------------------------ REAL LaneNetwork
const fakeWorld = {
  roads: {
    version: 7,
    api: {
      laneGraph: () => graph,
      getSegment: (id) => ({ type: TYPE[id] }),
      getNode: (id) => ({ x: NODES[id][0], z: NODES[id][1] }),
    },
  },
};
const net = new LaneNetwork(fakeWorld);
const changed = net.rebuild();
console.log('rebuild:', changed, 'elements', net.elements.length, 'laneElems', net.laneElems.length, 'nodes', net.nodes.size);

// --- serialise the element graph
const f9 = (v) => +v.toFixed(9);
const elements = net.elements.map((el) => ({
  kind: el.kind, id: el.id, turn: el.turn ?? 0, rank: el.rank, fromLane: el.fromLane ?? -1, toLane: el.toLane ?? -1,
  localIdx: el.localIdx, yieldDelay: f9(el.yieldDelay ?? 0), speed: f9(el.speed), len: f9(el.poly.len),
  vmax0: f9(el.poly.vmax[0]), vmaxM: f9(el.poly.vmax[el.poly.n >> 1]), vmaxL: f9(el.poly.vmax[el.poly.n - 1]),
  sx: f9(el.sx), sz: f9(el.sz), ex: f9(el.ex), ez: f9(el.ez),
  outs: el.outs.join(','),
}));
const laneElems = net.laneElems.join(',');

// --- junction records
const nodesOut = [...net.nodes.values()].map((n) => ({
  id: n.id, signalized: n.signalized, phases: n.phases.map((p) => p.join(',')), phase: n.phase,
  timer: f9(n.timer ?? 0), greenTime: f9(n.greenTime ?? 0), needsControl: n.needsControl, maxRank: n.maxRank,
  approaches: [...n.approaches.values()].map((a) => ({ key: a.key, idx: a.idx, dx: f9(a.dx), dz: f9(a.dz), rank: a.rank, lanes: a.lanes.join(',') })),
  conns: n.conns.join(','),
  conflict: Array.from(n.conflict ?? []).join(''),
  inLanes: n.inLanes.join(','),
}));

// --- spawn table + weighted picks
const randomLaneProbes = [0, 0.13, 0.26, 0.39, 0.5, 0.62, 0.75, 0.88, 0.97, 0.999].map((r) => net.randomLane(r));

// --- explicit A* routes (no rng: safe before the sim)
const laneList = net.laneElems;
const routeProbes = [];
for (const [a, b] of [[laneList[0], laneList[5]], [laneList[2], laneList[9]], [laneList[12], laneList[1]], [laneList[7], laneList[3]]]) {
  const p = net.route(a, b);
  routeProbes.push(p ? p.join(',') : 'null');
}

// --- signal evolution (standalone, before the sim)
for (let i = 0; i < 600; i++) net.updateSignals(1 / 30);
const signalSnap = [...net.nodes.values()]
  .filter((n) => n.signalized)
  .map((n) => ({ id: n.id, state: n.state, phase: n.phase, timer: f9(n.timer), green: n.approachList.map((a) => (a.green ? 1 : 0)).join(''), amber: n.approachList.map((a) => (a.amber ? 1 : 0)).join('') }));

// ------------------------------------------------------------------ REAL TrafficSim
const SEED = 1337;
const rng = makeRng(SEED).fork(hashString('traffic'));
const sim = new TrafficSim(net, fakeWorld, rng);
sim.onNetwork();
const made = sim.spawn(14);
console.log('spawned', made, 'fleet', sim.vehicles.length);

const vehSnap = () => sim.vehicles.map((v) => ({
  id: v.id, t: v.type, e: v.elem, ri: v.ri, s: f9(v.s), v: f9(v.v),
  x: f9(v.x), y: f9(v.y), z: f9(v.z), yaw: f9(v.yaw), br: f9(v.brake), w: f9(v.wait),
  bl: v.blinkSide, sr: f9(v.speedRatio), d: f9(v.dist),
}));
const claimSnap = () => [...net.nodes.values()].filter((n) => n.claims.size).map((n) => ({
  id: n.id, c: [...n.claims.values()].map((c) => `${c.id}:${c.state}:${c.go ? 1 : 0}:${c.local}`).join(' '),
}));
const checkpoints = [];
for (let f = 1; f <= 900; f++) {
  sim.update(1 / 30, 12, -20);
  if (f === 480) { var despawned = sim.despawnFar(2); }
  if (f === 150 || f === 300 || f === 480 || f === 620 || f === 900) {
    checkpoints.push({ f, despawned: f === 480 ? despawned : undefined, fleet: sim.vehicles.length, veh: vehSnap(), claims: claimSnap() });
  }
}
console.log('checkpoints', checkpoints.length, 'final fleet', sim.vehicles.length);

// ------------------------------------------------------------------ emit goldens
const num = (v) => (Number.isInteger(v) ? v.toFixed(1) : `${v}`);
const ptArr = (p) => (p.x !== undefined ? [p.x, p.y, p.z] : p);
const ptsK = (pts) => `listOf(${pts.map((p) => `doubleArrayOf(${ptArr(p).map(num).join(', ')})`).join(', ')})`;
const lanesK = LANES.map((l) =>
  `        Traffic.GraphLane("${l.id}", ${ptsK(l.points)}, ${num(l.speed)}, "${l.segmentId}", ${l.dir}, "${l.from}", "${l.to}", ${num(l.width)})`).join(',\n');
const connsK = LANES.map((l) => {
  const outs = connections.get(l.id) || [];
  return `        "${l.id}" to listOf(${outs.map((o) => `"${o}"`).join(', ')})`;
}).join(',\n');
const nodePosK = Object.entries(graph.nodePos).map(([k, v]) => `        "${k}" to doubleArrayOf(${v.map(num).join(', ')})`).join(',\n');
const segTypeK = Object.entries(TYPE).map(([k, v]) => `        "${k}" to "${v}"`).join(',\n');

const kotlin = `// GENERATED by tools/probe_lanenetwork.mjs — golden values from the REAL web traffic/
// LaneNetwork.js + TrafficSim.js (Node) on the synthetic junction graph embedded below.
// Do not edit by hand.
package com.fablecities.android.worldgen

object LaneNetGoldens {
    class ElG(val kind: Int, val id: String, val turn: Int, val rank: Int, val fromLane: Int, val toLane: Int,
              val localIdx: Int, val yieldDelay: Double, val speed: Double, val len: Double,
              val vmax0: Double, val vmaxM: Double, val vmaxL: Double,
              val sx: Double, val sz: Double, val ex: Double, val ez: Double, val outs: List<Int>)
    class ApG(val key: String, val idx: Int, val dx: Double, val dz: Double, val rank: Int, val lanes: List<Int>)
    class NodeG(val id: String, val signalized: Boolean, val phases: List<List<Int>>, val phase: Int,
                val timer: Double, val greenTime: Double, val needsControl: Boolean, val maxRank: Int,
                val approaches: List<ApG>, val conns: List<Int>, val conflict: String, val inLanes: List<Int>)
    class VehG(val id: Int, val t: String, val e: Int, val ri: Int, val s: Double, val v: Double,
               val x: Double, val y: Double, val z: Double, val yaw: Double, val br: Double, val w: Double,
               val bl: Int, val sr: Double, val d: Double)
    class ClaimG(val id: Int, val state: Int, val go: Boolean, val local: Int)
    class SnapG(val f: Int, val despawned: Int, val fleet: Int, val veh: List<VehG>, val claims: Map<String, List<ClaimG>>)
    class SignalG(val id: String, val state: Int, val phase: Int, val timer: Double, val green: List<Int>, val amber: List<Int>)

    // ---------------- input graph (identical values feed both implementations) ----------------
    val graphLanes = listOf(
${lanesK},
    )
    val graphConnections = linkedMapOf(
${connsK},
    )
    val graphNodePos = mapOf(
${nodePosK},
    )
    val graphSegType = mapOf(
${segTypeK},
    )
    const val graphVersion = 7

    // ---------------- LaneNetwork structure ----------------
    const val elements = ${net.elements.length}
    const val laneElems = ${net.laneElems.length}
    const val nodes = ${net.nodes.size}
    val elG = listOf(
${elements.map((e) => `        ElG(${e.kind}, "${e.id}", ${e.turn}, ${e.rank}, ${e.fromLane}, ${e.toLane}, ${e.localIdx}, ${e.yieldDelay.toFixed(9)}, ${e.speed.toFixed(9)}, ${e.len.toFixed(9)}, ${e.vmax0.toFixed(9)}, ${e.vmaxM.toFixed(9)}, ${e.vmaxL.toFixed(9)}, ${e.sx.toFixed(9)}, ${e.sz.toFixed(9)}, ${e.ex.toFixed(9)}, ${e.ez.toFixed(9)}, listOf(${e.outs || ''}))`).join(',\n')},
    )
    val laneElemList = listOf(${laneElems || ''})
    val nodeG = listOf(
${nodesOut.map((n) => `        NodeG("${n.id}", ${n.signalized}, listOf(${n.phases.map((p) => `listOf(${p})`).join(', ')}), ${n.phase}, ${n.timer.toFixed(9)}, ${n.greenTime.toFixed(9)}, ${n.needsControl}, ${n.maxRank}, listOf(${n.approaches.map((a) => `ApG("${a.key}", ${a.idx}, ${a.dx.toFixed(9)}, ${a.dz.toFixed(9)}, ${a.rank}, listOf(${a.lanes}))`).join(', ')}), listOf(${n.conns}), "${n.conflict || ''}", listOf(${n.inLanes}))`).join(',\n')},
    )
    val randomLaneProbes = listOf(${randomLaneProbes.join(', ')})
    val routeProbes = listOf(
${routeProbes.map((p) => `        ${p === 'null' ? 'null' : `intArrayOf(${p})`}`).join(',\n')},
    )
    val signalSnap = listOf(
${signalSnap.map((s) => `        SignalG("${s.id}", ${s.state}, ${s.phase}, ${s.timer.toFixed(9)}, listOf(${s.green.split('').join(', ')}), listOf(${s.amber.split('').join(', ')}))`).join(',\n')},
    )
    val spawnCum = floatArrayOf(
${'        ' + [...net.spawnCum].map((v) => `${f9(v)}f`).join(', ')},
    )
    const val spawnTotal = ${net.spawnTotal.toFixed(9)}
    const val totalLength = ${net.totalLength.toFixed(9)}

    // ---------------- driven simulation (seed 1337, fork hashString('traffic')) ----------------
    const val spawned = ${made}
    val checkpoints = listOf(
${checkpoints.map((c) => `        SnapG(${c.f}, ${c.despawned ?? -1}, ${c.fleet}, listOf(${c.veh.map((v) => `VehG(${v.id}, "${v.t}", ${v.e}, ${v.ri}, ${v.s.toFixed(9)}, ${v.v.toFixed(9)}, ${v.x.toFixed(9)}, ${v.y.toFixed(9)}, ${v.z.toFixed(9)}, ${v.yaw.toFixed(9)}, ${v.br.toFixed(9)}, ${v.w.toFixed(9)}, ${v.bl}, ${v.sr.toFixed(9)}, ${v.d.toFixed(9)})`).join(', ')}), mapOf(${c.claims.map((n) => `"${n.id}" to listOf(${n.c.split(' ').map((cl) => { const [id, st, go, lo] = cl.split(':'); return `ClaimG(${id}, ${st}, ${go === '1'}, ${lo})`; }).join(', ')})`).join(', ')}))`).join(',\n')},
    )
}
`;
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/LaneNetGoldens.kt', import.meta.url), kotlin);
const graphJson = { lanes: graph.lanes, connections: Object.fromEntries(graph.connections), nodePos: graph.nodePos, segType: graph.segType };
writeFileSync(new URL('../tools/ln_graph.json', import.meta.url), JSON.stringify(graphJson, null, 1));
console.log('goldens written: LaneNetGoldens.kt + tools/ln_graph.json');
