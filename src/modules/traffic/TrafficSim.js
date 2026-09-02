/**
 * traffic — agent simulation.
 *
 * Vehicles follow routed lane sequences with IDM car-following (free-flow term + gap term), a
 * curvature speed limit, and junction control: signalised nodes run real phase cycles, everything
 * else is resolved by a per-node first-come-first-served ticket ordered by turn priority and road
 * rank (so straight-through and major-road traffic wins, left turns yield to oncoming). A connector
 * conflict matrix computed from actual path crossings decides who blocks whom, and cars never enter
 * a junction whose exit is full, which keeps the network free of gridlock.
 *
 * Pedestrians walk the sidewalk lanes and wait at the kerb until the crossing is clear.
 */
import { polyAt } from './LaneNetwork.js';
import { VEHICLE_SPECS, VEHICLE_IDS } from './VehicleModels.js';

const KIND = { car: 'car', box: 'van', truck: 'truck', bus: 'bus' };   // vocabulary the audio module asked for

const A_MAX = 2.85, B_COMF = 3.30, S0 = 2.05, T_HEAD = 1.05, DEC_MAX = -7.6;
const CLAIM_DIST = 30;
const LOOKAHEAD = 85;

function idmAccel(v, v0, gap, dv, aMax) {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.5, v0), 4);
  let inter = 0;
  if (gap < 1e8) {
    const sStar = S0 + Math.max(0, v * T_HEAD + (v * dv) / (2 * Math.sqrt(aMax * B_COMF)));
    const g = Math.max(0.4, gap);
    inter = (sStar / g) * (sStar / g);
  }
  return aMax * (free - inter);
}

let TYPE_TABLE = null;
function typeTable() {
  if (TYPE_TABLE) return TYPE_TABLE;
  let sum = 0;
  TYPE_TABLE = VEHICLE_IDS.map((id) => { sum += VEHICLE_SPECS[id].weight; return { id, cum: sum }; });
  TYPE_TABLE.total = sum;
  return TYPE_TABLE;
}

export class TrafficSim {
  constructor(net, world, rng) {
    this.net = net;
    this.world = world;
    this.rng = rng;
    this.vehicles = [];
    this.peds = [];
    this.target = 0;
    this.pedTarget = 0;
    this.frame = 0;
    this.ticket = 1;
    this.time = 0;
    this.nextId = 1;
    this.camX = 0; this.camZ = 0;
    this._bucket = []; this._bstamp = null; this._touched = [];
    this._pbucket = []; this._pstamp = null; this._ptouched = [];
    this.congestion = 0;
    this.avgSpeedRatio = 1;
    this._astar = 16;
  }

  onNetwork() {
    this.vehicles.length = 0;
    this.peds.length = 0;
    const n = this.net.elements.length;
    this._bucket = new Array(n);
    this._bstamp = new Int32Array(n);
    this._touched = [];
    for (let i = 0; i < n; i++) this._bucket[i] = [];
    const p = this.net.pedElements.length;
    this._pbucket = new Array(p);
    this._pstamp = new Int32Array(p);
    this._ptouched = [];
    for (let i = 0; i < p; i++) this._pbucket[i] = [];
    for (const node of this.net.nodes.values()) node.claims.clear();
  }

  // ------------------------------------------------------------------ spawning
  _pickType() {
    const tbl = typeTable();
    const r = this.rng() * tbl.total;
    for (const t of tbl) if (r <= t.cum) return t.id;
    return tbl[0].id;
  }

  _clear(elemIdx, s, half) {
    for (const v of this.vehicles) {
      if (v.elem !== elemIdx) continue;
      if (Math.abs(v.s - s) < half + v.half + 3.5) return false;
    }
    return true;
  }

  spawn(count, hint) {
    const net = this.net;
    if (!net.ready) return 0;
    let made = 0;
    for (let i = 0; i < count; i++) {
      let placed = false;
      for (let tries = 0; tries < 6 && !placed; tries++) {
        let li = -1;
        if (hint && this.rng() < 0.55) li = hint();
        if (li < 0) li = net.randomLane(this.rng());
        if (li < 0) return made;
        const el = net.elements[li];
        if (!el || el.kind !== 0) continue;
        const id = this._pickType();
        const spec = VEHICLE_SPECS[id];
        if ((id === 'bus' || id === 'truck') && el.rank < 2) continue;
        if (el.poly.len < spec.len * 2.2) continue;
        const s = 1.0 + this.rng() * (el.poly.len - spec.len - 2);
        if (!this._clear(li, s, spec.len * 0.5)) continue;
        const v = this._makeVehicle(id, spec, li, s);
        this.vehicles.push(v);
        made++;
        placed = true;
      }
    }
    return made;
  }

  _makeVehicle(id, spec, elemIdx, s) {
    const rng = this.rng;
    const el = this.net.elements[elemIdx];
    const veh = {
      id: this.nextId++, type: id, kind: KIND[spec.kind] || 'car', spec, elem: elemIdx, s, v: el.speed * 0.55,
      route: [elemIdx], ri: 0, half: spec.len * 0.5,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, spin: 0, steer: 0, yawRate: 0, speedRatio: 1, segmentId: null,
      brake: 0, wait: 0, vf: 0.86 + rng() * 0.24, paint: (rng() * 1e6) | 0, box: (rng() * 1e6) | 0,
      stopDist: Infinity, bidx: -1, dist: 0, dead: false, prevYaw: 0, seed: rng(),
      blink: 0, blinkSide: 0,
      sl: 1 + (rng() - 0.5) * 0.055, sw: 1 + (rng() - 0.5) * 0.040, sh: 1 + (rng() - 0.5) * 0.045,
    };
    veh.half = spec.len * 0.5 * veh.sl;
    this._extendRoute(veh);
    return veh;
  }

  spawnPeds(count) {
    const net = this.net;
    if (!net.pedLaneElems || !net.pedLaneElems.length) return 0;
    let made = 0;
    for (let i = 0; i < count; i++) {
      const li = net.randomPedLane(this.rng());
      if (li < 0) break;
      const el = net.pedElements[li];
      if (!el || el.poly.len < 3) continue;
      this.peds.push({
        id: this.nextId++, elem: li, s: this.rng() * el.poly.len, v: 1.0 + this.rng() * 0.45,
        vmax: 1.05 + this.rng() * 0.55, phase: this.rng() * 6.283, x: 0, y: 0, z: 0, yaw: 0,
        shirt: (this.rng() * 1e6) | 0, pants: (this.rng() * 1e6) | 0, seed: this.rng(), bidx: -1, dist: 0,
      });
      made++;
    }
    return made;
  }

  _extendRoute(veh) {
    const net = this.net;
    const last = veh.route[veh.route.length - 1];
    const lastEl = net.elements[last];
    if (!lastEl) return false;
    if (!lastEl.outs.length) return false;
    if (this._astar > 0) {
      this._astar--;
      for (let t = 0; t < 3; t++) {
        const goal = net.randomLane(this.rng());
        if (goal < 0 || goal === last) continue;
        const path = net.route(last, goal);
        if (path && path.length > 1) {
          for (let i = 1; i < path.length; i++) veh.route.push(path[i]);
          return true;
        }
      }
    }
    // fallback: random legal step
    const c = lastEl.outs[(this.rng() * lastEl.outs.length) | 0];
    if (c === undefined) return false;
    veh.route.push(c);
    const conn = net.elements[c];
    if (conn && conn.outs.length) veh.route.push(conn.outs[0]);
    return true;
  }

  despawnFar(n) {
    let removed = 0;
    for (let i = this.vehicles.length - 1; i >= 0 && removed < n; i--) {
      const v = this.vehicles[i];
      const d = Math.hypot(v.x - this.camX, v.z - this.camZ);
      if (d > 170) { this._release(v); this.vehicles.splice(i, 1); removed++; }
    }
    for (let i = this.vehicles.length - 1; i >= 0 && removed < n; i--) {
      this._release(this.vehicles[i]); this.vehicles.splice(i, 1); removed++;
    }
    return removed;
  }

  _release(veh) {
    const el = this.net.elements[veh.elem];
    if (el && el.kind === 1 && el.junctionRef) el.junctionRef.claims.delete(veh.id);
    const nx = this.net.elements[veh.route[veh.ri + 1]];
    if (nx && nx.kind === 1 && nx.junctionRef) nx.junctionRef.claims.delete(veh.id);
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, camX, camZ) {
    const net = this.net;
    if (!net.ready || dt <= 0) return;
    this.camX = camX; this.camZ = camZ;
    this.frame++;
    this.time += dt;
    this._astar = 16;
    net.updateSignals(dt);
    this._buildBuckets();
    for (const v of this.vehicles) this._intent(v);
    this._resolveClaims();
    for (const v of this.vehicles) this._stepVehicle(v, dt);
    for (const p of this.peds) this._stepPed(p, dt);
    // recycle vehicles that ran out of network
    for (let i = this.vehicles.length - 1; i >= 0; i--) if (this.vehicles[i].dead) { this._release(this.vehicles[i]); this.vehicles.splice(i, 1); }
  }

  _buildBuckets() {
    const f = this.frame;
    for (const e of this._touched) this._bucket[e].length = 0;
    this._touched.length = 0;
    for (const v of this.vehicles) {
      const e = v.elem;
      if (this._bstamp[e] !== f) { this._bstamp[e] = f; this._bucket[e].length = 0; this._touched.push(e); }
      this._bucket[e].push(v);
    }
    for (const e of this._touched) {
      const b = this._bucket[e];
      b.sort(cmpS);
      for (let i = 0; i < b.length; i++) b[i].bidx = i;
    }
    for (const e of this._ptouched) this._pbucket[e].length = 0;
    this._ptouched.length = 0;
    for (const p of this.peds) {
      const e = p.elem;
      if (this._pstamp[e] !== f) { this._pstamp[e] = f; this._pbucket[e].length = 0; this._ptouched.push(e); }
      this._pbucket[e].push(p);
    }
    for (const e of this._ptouched) {
      const b = this._pbucket[e];
      b.sort(cmpS);
      for (let i = 0; i < b.length; i++) b[i].bidx = i;
    }
  }

  /** Register (or drop) a junction claim and record a red-light stop distance. */
  _intent(veh) {
    const els = this.net.elements;
    veh.stopDist = Infinity;
    const el = els[veh.elem];
    if (!el) { veh.dead = true; return; }
    if (el.kind === 1) {
      const node = el.junctionRef;
      if (node) { const c = node.claims.get(veh.id); if (c) { c.state = 1; c.seen = this.frame; } }
      return;
    }
    const nextIdx = veh.route[veh.ri + 1];
    const next = nextIdx === undefined ? null : els[nextIdx];
    if (!next || next.kind !== 1) return;
    const node = next.junctionRef;
    if (!node) return;
    const remain = el.poly.len - veh.s;
    if (remain > CLAIM_DIST) return;

    if (node.signalized && el.approach && !el.approach.green) {
      const stopNeed = (veh.v * veh.v) / (2 * 4.2) + 1.0;
      const mustRun = el.approach.amber && remain < stopNeed;
      if (!mustRun) {
        node.claims.delete(veh.id);
        veh.stopDist = Math.max(0, remain - 0.7);
        return;
      }
    }
    if (!node.needsControl) return;
    let c = node.claims.get(veh.id);
    if (!c) {
      c = { id: veh.id, veh, local: next.localIdx, key: this.time + next.yieldDelay, ticket: this.ticket++, state: 0, go: false, seen: this.frame, blockedExit: false };
      node.claims.set(veh.id, c);
    } else { c.local = next.localIdx; c.state = 0; c.seen = this.frame; }
    // don't block the box: refuse to enter when the exit lane has no room
    const exit = els[next.outs[0]];
    if (exit) {
      const b = this._bucket[exit.idx];
      if (this._bstamp[exit.idx] === this.frame && b.length) {
        const first = b[0];
        if (first.s < veh.spec.len + first.half + 2.5 && first.v < 1.6) c.blockedExit = true;
        else c.blockedExit = false;
      } else c.blockedExit = false;
    }
  }

  _resolveClaims() {
    const f = this.frame;
    for (const node of this.net.nodes.values()) {
      const claims = node.claims;
      if (!claims.size) continue;
      for (const [k, c] of claims) if (c.seen !== f) claims.delete(k);
      if (!claims.size) continue;
      const list = [];
      for (const c of claims.values()) list.push(c);
      list.sort(cmpClaim);
      const k = node.conns.length;
      const taken = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const stale = this.time - (c.key || 0) > 7;      // nobody waits for ever
        let ok = c.state === 1 || !c.blockedExit;
        if (ok && !stale) {
          for (let j = 0; j < taken.length; j++) {
            if (node.conflict[taken[j] * k + c.local]) { ok = false; break; }
          }
        }
        c.go = ok;
        // a claim that is only waiting for room beyond the junction must not hold up cross traffic
        if (ok || !c.blockedExit) taken.push(c.local);
      }
    }
  }

  _leader(veh) {
    const els = this.net.elements;
    const b = this._bucket[veh.elem];
    if (this._bstamp[veh.elem] === this.frame && veh.bidx >= 0) {
      const nb = b[veh.bidx + 1];
      if (nb) return { gap: nb.s - nb.half - (veh.s + veh.half), v: nb.v };
    }
    let ahead = els[veh.elem].poly.len - veh.s;
    for (let k = 1; k <= 4; k++) {
      const ei = veh.route[veh.ri + k];
      if (ei === undefined) break;
      if (this._bstamp[ei] === this.frame) {
        const bb = this._bucket[ei];
        if (bb.length) { const nb = bb[0]; return { gap: ahead + nb.s - nb.half - veh.half, v: nb.v }; }
      }
      ahead += els[ei].poly.len;
      if (ahead > LOOKAHEAD) break;
    }
    return null;
  }

  _stepVehicle(veh, dt) {
    const els = this.net.elements;
    let el = els[veh.elem];
    if (!el) { veh.dead = true; return; }
    const p = polyAt(el.poly, veh.s);
    // target speed: lane limit × driver, curvature, and the entry speed of what comes next
    let v0 = Math.min(el.speed * veh.vf * (veh.spec.vmax || 1), p.v);
    const remain = el.poly.len - veh.s;
    const nextIdx = veh.route[veh.ri + 1];
    if (nextIdx !== undefined && remain < 40) {
      const nx = els[nextIdx];
      if (nx) {
        const entry = Math.min(nx.speed * veh.vf * (veh.spec.vmax || 1), nx.poly.vmax[0]);
        v0 = Math.min(v0, Math.sqrt(entry * entry + 2 * 2.0 * Math.max(0, remain - 1)));
      }
    }
    let a = idmAccel(veh.v, v0, 1e9, 0, A_MAX);
    const lead = this._leader(veh);
    if (lead) a = Math.min(a, idmAccel(veh.v, v0, lead.gap, veh.v - lead.v, A_MAX));

    // junction stop (red light, or not our turn)
    let stop = veh.stopDist;
    if (el.kind === 0 && nextIdx !== undefined) {
      const nx = els[nextIdx];
      if (nx && nx.kind === 1 && nx.junctionRef && nx.junctionRef.needsControl) {
        const c = nx.junctionRef.claims.get(veh.id);
        if (c && !c.go) stop = Math.min(stop, Math.max(0, remain - 0.7));
      }
    }
    if (stop < 1e8) a = Math.min(a, idmAccel(veh.v, v0, stop, veh.v, A_MAX));

    a = Math.max(DEC_MAX, Math.min(A_MAX, a));
    veh.v = Math.max(0, veh.v + a * dt);
    if (stop < 0.35 && veh.v < 0.6) veh.v = 0;
    // brake lamps: braking, plus held on while stopped at a light or in a queue
    let brakeT = Math.min(1, Math.max(0, -a / 2.6));
    if (veh.v < 0.6 && (stop < 1e8 || (lead && lead.gap < 9))) brakeT = Math.max(brakeT, 0.9);
    veh.brake = veh.brake + (brakeT - veh.brake) * Math.min(1, dt * 9);
    veh.wait = veh.v < 0.4 ? veh.wait + dt : 0;
    veh.s += veh.v * dt;
    veh.dist += veh.v * dt;

    // element transitions
    let guard = 0;
    while (veh.s > el.poly.len && guard++ < 6) {
      veh.s -= el.poly.len;
      const wasConn = el.kind === 1;
      const prevNode = wasConn ? el.junctionRef : null;
      veh.ri++;
      if (veh.ri >= veh.route.length) {
        if (!this._extendRoute(veh) || veh.ri >= veh.route.length) { veh.dead = true; return; }
      }
      veh.elem = veh.route[veh.ri];
      el = els[veh.elem];
      if (!el) { veh.dead = true; return; }
      if (prevNode) prevNode.claims.delete(veh.id);
      if (veh.route.length - veh.ri < 3) this._extendRoute(veh);
      if (veh.ri > 40) { veh.route = veh.route.slice(veh.ri); veh.ri = 0; }
    }
    if (veh.route.length - veh.ri < 3) this._extendRoute(veh);

    const q = polyAt(el.poly, veh.s);
    veh.x = q.x; veh.y = q.y; veh.z = q.z;
    const yaw = Math.atan2(q.tx, q.tz);
    let d = yaw - veh.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    veh.yawRate = dt > 0 ? d / dt : 0;
    veh.yaw = yaw;
    veh.pitch = -Math.asin(Math.max(-0.5, Math.min(0.5, q.ty)));
    veh.spin += (veh.v / veh.spec.wheelR) * dt;
    const targetSteer = Math.max(-0.55, Math.min(0.55, veh.yawRate * 0.85));
    veh.steer += (targetSteer - veh.steer) * Math.min(1, dt * 8);
    // turn indicators: on from ~26 m before a turn until the connector is finished
    let side = 0;
    if (el.kind === 1) side = el.turn === 2 ? 1 : el.turn === 1 ? -1 : 0;
    else {
      const nx2 = els[veh.route[veh.ri + 1]];
      if (nx2 && nx2.kind === 1 && el.poly.len - veh.s < 26) side = nx2.turn === 2 ? 1 : nx2.turn === 1 ? -1 : 0;
    }
    veh.blinkSide = side;
    veh.blink = side === 0 ? 0 : side * (((this.time + veh.seed) % 0.94) < 0.52 ? 1 : 0);
    veh.speedRatio = el.speed > 0.1 ? Math.min(1, veh.v / el.speed) : 1;
    veh.segmentId = el.kind === 0 ? el.segmentId : null;
    // published for the audio module (m/s + planar velocity)
    veh.speed = veh.v;
    veh.vx = Math.sin(yaw) * veh.v;
    veh.vz = Math.cos(yaw) * veh.v;
  }

  _stepPed(ped, dt) {
    const els = this.net.pedElements;
    let el = els[ped.elem];
    if (!el) { ped.elem = this.net.randomPedLane(this.rng()); ped.s = 0; return; }
    let target = ped.vmax;
    // personal space
    const b = this._pbucket[ped.elem];
    if (this._pstamp[ped.elem] === this.frame && ped.bidx >= 0) {
      const nb = b[ped.bidx + 1];
      if (nb) {
        const gap = nb.s - ped.s;
        if (gap < 1.5) target = Math.min(target, Math.max(0, nb.v * 0.85 + (gap - 0.7) * 0.9));
      }
    }
    // wait at the kerb
    const remain = el.poly.len - ped.s;
    if (el.kind === 0 && remain < 1.4) {
      if (ped.nextElem === undefined || ped.nextElem === null) ped.nextElem = this._pickPedNext(el);
      const nx = ped.nextElem !== null ? els[ped.nextElem] : null;
      if (nx && nx.crossing && !this._crossingClear(nx)) target = 0;
    }
    ped.v += (target - ped.v) * Math.min(1, dt * 3.5);
    if (ped.v < 0.02) ped.v = 0;
    ped.s += ped.v * dt;
    ped.phase += ped.v * dt * 4.6;
    ped.dist += ped.v * dt;
    let guard = 0;
    while (ped.s > el.poly.len && guard++ < 4) {
      ped.s -= el.poly.len;
      let nxt = ped.nextElem;
      ped.nextElem = null;
      if (nxt === undefined || nxt === null) nxt = this._pickPedNext(el);
      if (nxt === null) { ped.elem = this.net.randomPedLane(this.rng()); ped.s = 0; return; }
      ped.elem = nxt;
      el = els[ped.elem];
      if (!el) { ped.elem = this.net.randomPedLane(this.rng()); ped.s = 0; return; }
    }
    const q = polyAt(el.poly, ped.s);
    ped.x = q.x; ped.y = q.y; ped.z = q.z;
    ped.yaw = Math.atan2(q.tx, q.tz);
  }

  _pickPedNext(el) {
    if (el.kind === 1) return el.outs.length ? el.outs[0] : null;
    if (!el.outs.length) return null;
    // avoid immediately turning back the way we came
    const els = this.net.pedElements;
    let pick = null, tries = 0;
    while (tries++ < 4) {
      const c = el.outs[(this.rng() * el.outs.length) | 0];
      const conn = els[c];
      if (!conn) continue;
      const back = conn.outs.length && els[conn.outs[0]] && els[conn.outs[0]].to === el.from;
      if (!back || this.rng() < 0.2) { pick = c; break; }
      pick = c;
    }
    return pick;
  }

  _crossingClear(conn) {
    const node = conn.node ? this.net.nodes.get(conn.node) : null;
    if (!node) return true;
    const els = this.net.elements;
    for (const li of node.inLanes) {
      const b = this._bucket[li];
      if (this._bstamp[li] !== this.frame || !b.length) continue;
      const el = els[li];
      for (let i = b.length - 1; i >= 0; i--) {
        const v = b[i];
        const d = el.poly.len - v.s;
        if (d > 26) break;
        if (v.v > 1.2) return false;
      }
    }
    for (const c of node.claims.values()) if (c.state === 1) return false;
    return true;
  }

  // ------------------------------------------------------------------ stats
  /** Per-segment load 0..1 + a global congestion figure (called once per sim tick). */
  writeSegmentLoads() {
    const world = this.world;
    const segs = world.roads && world.roads.segments;
    if (!segs || !segs.size) { this.congestion = 0; return; }
    const load = new Map();
    let ratioSum = 0, ratioN = 0;
    for (const v of this.vehicles) {
      if (!v.segmentId) continue;
      let rec = load.get(v.segmentId);
      if (!rec) { rec = { n: 0, slow: 0 }; load.set(v.segmentId, rec); }
      rec.n++;
      rec.slow += 1 - (v.speedRatio === undefined ? 1 : v.speedRatio);
      ratioSum += v.speedRatio === undefined ? 1 : v.speedRatio; ratioN++;
    }
    let weighted = 0, total = 0;
    for (const seg of segs.values()) {
      const rec = load.get(seg.id);
      const lanes = Math.max(1, seg.lanes ? seg.lanes.length : 2);
      const cap = Math.max(1, (seg.length / 22) * lanes);
      let t = 0;
      if (rec) {
        // a grid with lights is never at free flow, so only the slow-down *beyond* the normal
        // stop-and-go of an urban street counts as congestion
        const density = Math.min(1.4, rec.n / cap);
        const slow = rec.n ? rec.slow / rec.n : 0;
        t = Math.min(1, 0.45 * density + 1.10 * Math.max(0, slow - 0.52));
      }
      seg.traffic = t;
      weighted += t * seg.length; total += seg.length;
    }
    this.avgSpeedRatio = ratioN ? ratioSum / ratioN : 1;
    this.congestion = total > 0 ? Math.min(1, weighted / total) : 0;
  }
}

function cmpS(a, b) { return a.s - b.s; }
function cmpClaim(a, b) {
  const ai = a.state === 1 ? 0 : 1, bi = b.state === 1 ? 0 : 1;
  if (ai !== bi) return ai - bi;
  if (a.key !== b.key) return a.key - b.key;
  return a.ticket - b.ticket;
}
