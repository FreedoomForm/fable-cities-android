/**
 * traffic — routable lane network built from roads.api.laneGraph().
 *
 * The road module hands us lane centrelines and lane→lane connections at every node. This class
 * turns that into a graph of *elements* (a lane, or a Bézier connector through a junction), each
 * with arc-length parametrisation and a curvature speed limit, plus:
 *   · A* routing over elements
 *   · junction records with signal phases (or priority rules) and a connector conflict matrix
 *   · the same structure for the pedestrian sidewalk network
 */
const KMH = 1 / 3.6;
const LAT_ACC = 3.4;                 // m/s² lateral comfort → curve speed limit
const RANK = { highway: 4, avenue: 3, local: 2, path: 1 };

function makePoly(pts, speed) {
  const n = pts.length;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  const cum = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = pts[i].x; y[i] = pts[i].y; z[i] = pts[i].z; }
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1], y[i] - y[i - 1]);
  const vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = speed;
    if (i > 0 && i < n - 1) {
      const ax = x[i] - x[i - 1], az = z[i] - z[i - 1];
      const bx = x[i + 1] - x[i], bz = z[i + 1] - z[i];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la > 1e-3 && lb > 1e-3) {
        const cross = Math.abs(ax * bz - az * bx);
        const cx = x[i + 1] - x[i - 1], cz = z[i + 1] - z[i - 1];
        const lc = Math.hypot(cx, cz) || 1;
        const kappa = (2 * cross) / (la * lb * lc);
        if (kappa > 1e-4) v = Math.min(v, Math.sqrt(LAT_ACC / kappa));
      }
    }
    vmax[i] = Math.max(2.6, v);
  }
  // smooth the limit backwards so cars brake before the apex, not in it
  for (let i = n - 2; i >= 0; i--) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] * vmax[i + 1] + 2 * 1.6 * (cum[i + 1] - cum[i])));
  return { n, x, y, z, cum, vmax, len: cum[n - 1] };
}

const _s = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, v: 10 };
/** Sample a poly at arc length `s`. Returns a shared scratch record. */
export function polyAt(poly, s, out = _s) {
  const { n, cum } = poly;
  const d = Math.min(Math.max(s, 0), poly.len);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  out.x = poly.x[lo] + (poly.x[hi] - poly.x[lo]) * t;
  out.y = poly.y[lo] + (poly.y[hi] - poly.y[lo]) * t;
  out.z = poly.z[lo] + (poly.z[hi] - poly.z[lo]) * t;
  const dx = poly.x[hi] - poly.x[lo], dy = poly.y[hi] - poly.y[lo], dz = poly.z[hi] - poly.z[lo];
  const l = Math.hypot(dx, dz) || 1;
  out.tx = dx / l; out.tz = dz / l; out.ty = dy / (Math.hypot(dx, dy, dz) || 1);
  out.v = poly.vmax[lo] + (poly.vmax[hi] - poly.vmax[lo]) * t;
  return out;
}

function bezierConnector(p0, t0, p1, t1, speed) {
  const dx = p1.x - p0.x, dz = p1.z - p0.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.08) return makePoly([p0, { x: p1.x, y: p1.y, z: p1.z }], speed);
  const h = Math.min(d * 0.46, 16);
  const c0 = { x: p0.x + t0.x * h, y: p0.y, z: p0.z + t0.z * h };
  const c1 = { x: p1.x - t1.x * h, y: p1.y, z: p1.z - t1.z * h };
  const steps = Math.max(3, Math.min(14, Math.ceil(d / 1.6)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    pts.push({
      x: a * p0.x + b * c0.x + c * c1.x + e * p1.x,
      y: a * p0.y + b * c0.y + c * c1.y + e * p1.y,
      z: a * p0.z + b * c0.z + c * c1.z + e * p1.z,
    });
  }
  return makePoly(pts, speed);
}

function segInt(ax, az, bx, bz, cx, cz, dx, dz) {
  const r1 = bx - ax, r2 = bz - az, s1 = dx - cx, s2 = dz - cz;
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * s2 - (cz - az) * s1) / den;
  const u = ((cx - ax) * r2 - (cz - az) * r1) / den;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

/** Binary min-heap keyed by f. */
class Heap {
  constructor() { this.a = []; }
  push(node, f) { const a = this.a; a.push({ node, f }); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; const t = a[m]; a[m] = a[i]; a[i] = t; i = m; } } return top; }
  get size() { return this.a.length; }
}

export class LaneNetwork {
  constructor(world) {
    this.world = world;
    this.version = -1;
    this.elements = [];
    this.laneElems = [];
    this.pedElements = [];
    this.pedLaneElems = [];
    this.nodes = new Map();
    this.totalLength = 0;
    this.spawnCum = null;
    this.ready = false;
    this._open = new Heap();
    this._g = null; this._from = null; this._stamp = null; this._epoch = 0;
  }

  /** Rebuild from the current road network. Returns true when something changed. */
  rebuild() {
    const api = this.world.roads && this.world.roads.api;
    if (!api || typeof api.laneGraph !== 'function') return false;
    const graph = api.laneGraph();
    const version = this.world.roads.version;
    if (version === this.version && this.ready) return false;
    this.version = version;
    this.elements = [];
    this.laneElems = [];
    this.nodes = new Map();
    const byId = new Map();

    const getRank = (segId) => {
      const seg = api.getSegment ? api.getSegment(segId) : null;
      return seg ? (RANK[seg.type] || 2) : 2;
    };

    for (const lane of graph.lanes) {
      if (!lane.points || lane.points.length < 2) continue;
      const speed = (lane.speed || 50) * KMH;
      const poly = makePoly(lane.points, speed);
      if (!(poly.len > 1.2)) continue;
      const idx = this.elements.length;
      const el = {
        kind: 0, idx, poly, speed, id: lane.id, segmentId: lane.segmentId, dir: lane.dir,
        from: lane.from, to: lane.to, width: lane.width || 3.5, rank: getRank(lane.segmentId), outs: [],
        node: null, localIdx: -1, prio: 0, sx: poly.x[0], sz: poly.z[0], ex: poly.x[poly.n - 1], ez: poly.z[poly.n - 1],
      };
      this.elements.push(el);
      this.laneElems.push(idx);
      byId.set(lane.id, idx);
    }

    // --- connectors through junctions
    for (const [laneId, outs] of graph.connections) {
      const ai = byId.get(laneId);
      if (ai === undefined || !outs || !outs.length) continue;
      const A = this.elements[ai];
      const pa = { x: A.poly.x[A.poly.n - 1], y: A.poly.y[A.poly.n - 1], z: A.poly.z[A.poly.n - 1] };
      const ta = tangentEnd(A.poly);
      for (const outId of outs) {
        const bi = byId.get(outId);
        if (bi === undefined || bi === ai) continue;
        const B = this.elements[bi];
        const pb = { x: B.poly.x[0], y: B.poly.y[0], z: B.poly.z[0] };
        const tb = tangentStart(B.poly);
        const speed = Math.min(A.speed, B.speed);
        const poly = bezierConnector(pa, ta, pb, tb, speed);
        const idx = this.elements.length;
        const dot = ta.x * tb.x + ta.z * tb.z;
        const crossv = ta.x * tb.z - ta.z * tb.x;
        // +X is the vehicle's left, so crossv < 0 means the connector bends left.
        const turn = dot > 0.86 ? 0 : dot < -0.7 ? 3 : crossv < 0 ? 2 : 1;   // 0 straight 1 right 2 left 3 u-turn
        this.elements.push({
          kind: 1, idx, poly, speed, id: `${laneId}>${outId}`, node: A.to, fromLane: ai, toLane: bi,
          turn, rank: A.rank, outs: [bi], localIdx: -1, prio: 0,
          sx: pa.x, sz: pa.z, ex: pb.x, ez: pb.z,
        });
        A.outs.push(idx);
      }
    }

    this._buildJunctions(api);
    this._buildSpawnTable();
    this._buildPedestrians(graph);
    this._g = new Float32Array(this.elements.length);
    this._from = new Int32Array(this.elements.length);
    this._stamp = new Int32Array(this.elements.length);
    this._epoch = 0;
    this.ready = this.laneElems.length > 0;
    return true;
  }

  _buildJunctions(api) {
    const nodes = this.nodes;
    const ensure = (id) => {
      let n = nodes.get(id);
      if (!n) {
        const rec = api.getNode ? api.getNode(id) : null;
        n = {
          id, x: rec ? rec.x : 0, z: rec ? rec.z : 0, approaches: new Map(), conns: [], conflict: null,
          signalized: false, phases: [], phase: 0, timer: 0, state: 0, cycle: 0, maxRank: 1, claims: new Map(), inLanes: [],
        };
        nodes.set(id, n);
      }
      return n;
    };
    for (const el of this.elements) {
      if (el.kind !== 0 || !el.to) continue;
      const node = ensure(el.to);
      node.inLanes.push(el.idx);
      let ap = node.approaches.get(el.segmentId);
      if (!ap) {
        const t = tangentEnd(el.poly);
        ap = { key: el.segmentId, dx: t.x, dz: t.z, lanes: [], rank: el.rank, green: true, idx: node.approaches.size };
        node.approaches.set(el.segmentId, ap);
      }
      ap.lanes.push(el.idx);
      el.approach = ap;
      el.junction = node;
      node.maxRank = Math.max(node.maxRank, el.rank);
    }
    for (const el of this.elements) {
      if (el.kind !== 1) continue;
      const node = nodes.get(el.node);
      if (!node) continue;
      el.localIdx = node.conns.length;
      node.conns.push(el.idx);
      el.junctionRef = node;
      // how long a driver defers to conflicting traffic before taking the gap (seconds).
      // Straight-through and major roads go first; left turns and minor roads yield, but only
      // for a bounded time, so a single left-turner can never lock a single-lane approach.
      el.yieldDelay = [0, 0.35, 1.5, 2.2][el.turn] + (4 - el.rank) * 0.55;
    }
    for (const node of nodes.values()) {
      const aps = [...node.approaches.values()];
      node.approachList = aps;
      // real cities only light up junctions on the major network; local crossings run
      // on priority (right-before-left / straight-before-turning), which keeps a grid flowing.
      node.signalized = node.maxRank >= 3 && aps.length >= 3;
      // phase groups: opposite approaches share a green
      const used = new Set();
      node.phases = [];
      for (let i = 0; i < aps.length; i++) {
        if (used.has(i)) continue;
        const group = [i]; used.add(i);
        let best = -1, bestDot = -0.55;
        for (let j = i + 1; j < aps.length; j++) {
          if (used.has(j)) continue;
          const d = aps[i].dx * aps[j].dx + aps[i].dz * aps[j].dz;
          if (d < bestDot) { bestDot = d; best = j; }
        }
        if (best >= 0) { group.push(best); used.add(best); }
        node.phases.push(group);
      }
      if (node.signalized) {
        node.greenTime = 7.5 + 1.1 * aps.length;
        node.cycle = 0;
        // deterministic desync so a grid does not blink in unison
        let h = 2166136261;
        for (let i = 0; i < node.id.length; i++) { h ^= node.id.charCodeAt(i); h = Math.imul(h, 16777619); }
        node.timer = ((h >>> 0) % 1000) / 1000 * (node.greenTime + 4.4);
        node.phase = (h >>> 10) % Math.max(1, node.phases.length);
      }
      // conflict matrix between the connectors of this junction
      const k = node.conns.length;
      node.conflict = new Uint8Array(k * k);
      for (let a = 0; a < k; a++) {
        const A = this.elements[node.conns[a]];
        for (let b = a + 1; b < k; b++) {
          const B = this.elements[node.conns[b]];
          let c = 0;
          if (A.fromLane !== B.fromLane) {
            if (A.toLane === B.toLane) c = 1;
            else c = polysCross(A.poly, B.poly) ? 1 : 0;
          }
          node.conflict[a * k + b] = c;
          node.conflict[b * k + a] = c;
        }
      }
      node.needsControl = false;
      for (let i = 0; i < k * k && !node.needsControl; i++) if (node.conflict[i]) node.needsControl = true;
    }
  }

  _buildSpawnTable() {
    let total = 0, len = 0;
    const cum = new Float32Array(this.laneElems.length);
    // Weight by road rank. Arterials are weighted hard: in Cities: Skylines II the avenues carry a
    // continuous stream while the back streets are nearly empty, and matching that ratio is what
    // makes a hero frame looking down an avenue read as a busy city rather than a thin trickle.
    const W = { 1: 0.30, 2: 0.75, 3: 3.6, 4: 5.2 };
    for (let i = 0; i < this.laneElems.length; i++) {
      const el = this.elements[this.laneElems[i]];
      total += el.poly.len * (W[el.rank] || 1);
      len += el.poly.len;
      cum[i] = total;
    }
    this.spawnCum = cum;
    this.spawnTotal = total;
    this.totalLength = len;
  }

  /** Pick a lane element index weighted by length. */
  randomLane(r) {
    const cum = this.spawnCum;
    if (!cum || !cum.length) return -1;
    const target = r * this.spawnTotal;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    return this.laneElems[lo];
  }

  _buildPedestrians(graph) {
    this.pedElements = [];
    this.pedLaneElems = [];
    const ped = graph.pedestrian;
    if (!ped) return;
    const byId = new Map();
    for (const lane of ped.lanes) {
      if (!lane.points || lane.points.length < 2) continue;
      const poly = makePoly(lane.points, 1.45);
      if (!(poly.len > 1.0)) continue;
      const idx = this.pedElements.length;
      this.pedElements.push({ kind: 0, idx, poly, id: lane.id, to: lane.to, from: lane.from, outs: [], crossing: false, node: null });
      this.pedLaneElems.push(idx);
      byId.set(lane.id, idx);
    }
    for (const [laneId, outs] of ped.connections) {
      const ai = byId.get(laneId);
      if (ai === undefined || !outs) continue;
      const A = this.pedElements[ai];
      const pa = { x: A.poly.x[A.poly.n - 1], y: A.poly.y[A.poly.n - 1], z: A.poly.z[A.poly.n - 1] };
      const ta = tangentEnd(A.poly);
      for (const outId of outs) {
        const bi = byId.get(outId);
        if (bi === undefined || bi === ai) continue;
        const B = this.pedElements[bi];
        const pb = { x: B.poly.x[0], y: B.poly.y[0], z: B.poly.z[0] };
        const gap = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        if (gap > 34) continue;
        const poly = bezierConnector(pa, ta, pb, tangentStart(B.poly), 1.45);
        const idx = this.pedElements.length;
        this.pedElements.push({
          kind: 1, idx, poly, id: `${laneId}>${outId}`, outs: [bi], crossing: gap > 5.5, node: A.to,
        });
        A.outs.push(idx);
      }
    }
    let total = 0;
    const cum = new Float32Array(this.pedLaneElems.length);
    for (let i = 0; i < this.pedLaneElems.length; i++) { total += this.pedElements[this.pedLaneElems[i]].poly.len; cum[i] = total; }
    this.pedCum = cum;
    this.pedTotal = total;
  }

  randomPedLane(r) {
    const cum = this.pedCum;
    if (!cum || !cum.length) return -1;
    const target = r * this.pedTotal;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    return this.pedLaneElems[lo];
  }

  /**
   * A* from lane element `startIdx` to lane element `goalIdx`.
   * Returns an array of element indices (lanes and connectors), or null.
   */
  route(startIdx, goalIdx, maxExpand = 900) {
    if (startIdx === goalIdx) return [startIdx];
    const els = this.elements;
    const g = this._g, from = this._from, stamp = this._stamp;
    const epoch = ++this._epoch;
    const open = this._open; open.a.length = 0;
    const goal = els[goalIdx];
    const inv = 1 / 22;
    const h = (el) => Math.hypot(el.ex - goal.sx, el.ez - goal.sz) * inv;
    g[startIdx] = 0; from[startIdx] = -1; stamp[startIdx] = epoch;
    open.push(startIdx, h(els[startIdx]));
    let expanded = 0;
    while (open.size) {
      const top = open.pop();
      const cur = top.node;
      if (cur === goalIdx) break;
      if (++expanded > maxExpand) return null;
      const curG = g[cur];
      if (top.f - h(els[cur]) > curG + 1e-3) continue;
      for (const nx of els[cur].outs) {
        const el = els[nx];
        const cost = el.poly.len / Math.max(3, el.speed) + (el.kind === 1 ? 1.2 + el.turn * 0.9 : 0);
        const ng = curG + cost;
        if (stamp[nx] === epoch && g[nx] <= ng) continue;
        stamp[nx] = epoch; g[nx] = ng; from[nx] = cur;
        open.push(nx, ng + h(el));
      }
    }
    if (stamp[goalIdx] !== epoch) return null;
    const path = [];
    let n = goalIdx;
    while (n >= 0 && path.length < 400) { path.push(n); n = from[n]; }
    path.reverse();
    return path;
  }

  /** Advance every signal cycle. */
  updateSignals(dt) {
    for (const node of this.nodes.values()) {
      if (!node.signalized || !node.phases.length) continue;
      node.timer += dt;
      const green = node.greenTime, amber = 2.6, allRed = 1.1;
      const total = green + amber + allRed;
      if (node.timer >= total) { node.timer -= total; node.phase = (node.phase + 1) % node.phases.length; }
      node.state = node.timer < green ? 0 : node.timer < green + amber ? 1 : 2;
      const active = node.phases[node.phase];
      for (let i = 0; i < node.approachList.length; i++) {
        const on = active.indexOf(i) >= 0;
        node.approachList[i].green = on && node.state === 0;
        node.approachList[i].amber = on && node.state === 1;
      }
    }
  }
}

function tangentEnd(poly) {
  const n = poly.n;
  const dx = poly.x[n - 1] - poly.x[n - 2], dz = poly.z[n - 1] - poly.z[n - 2];
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
function tangentStart(poly) {
  const dx = poly.x[1] - poly.x[0], dz = poly.z[1] - poly.z[0];
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
function polysCross(a, b) {
  for (let i = 0; i < a.n - 1; i++) {
    for (let j = 0; j < b.n - 1; j++) {
      if (segInt(a.x[i], a.z[i], a.x[i + 1], a.z[i + 1], b.x[j], b.z[j], b.x[j + 1], b.z[j + 1])) return true;
    }
  }
  return false;
}
