/**
 * Junction solver. For a node with k segment ends it finds, iteratively, how far each segment must
 * be trimmed back so that the corner fillets between neighbouring roads fit, and produces the
 * boundary of the junction:
 *   • 'fillet' corners (wedge < 180°): kerb arc of radius R tangent to both road edges, with the
 *     sidewalk block corner as a mitre behind it (like a real street corner);
 *   • 'round' corners (reflex wedge, or the single end of a dead end): arc around the node;
 *   • 'flat' corners (collinear continuation): straight connection, width transitions taper.
 * It also decides stop lines / crosswalks / turn arrows / median gaps for each segment end.
 *
 * Heights: every junction with trims is a *planar pad* — the plane through the node with the
 * gradient `node.grad` (fitted by the network from the arms' natural slopes). Corner points and
 * the fan lie on that plane, and RoadNetwork blends each arm's height profile onto it, so the fan
 * is never a tent between mouths at different heights (the round-1 "hole" and "missing corner").
 */
import * as THREE from 'three';
import { ROAD_TYPES, surfaceOffset } from './RoadTypes.js';
import { wrapTau, wrapPi, headingOf } from './curves.js';

const DEG = Math.PI / 180;
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Height of the junction pad plane at (x, z). */
export function planeY(node, x, z) {
  const g = node.grad;
  if (!g) return node.y;
  return node.y + g.gx * (x - node.x) + g.gz * (z - node.z);
}

/** Frame of a segment end `t` metres from the node, oriented *away* from the node. */
export function endFrame(network, seg, end, t) {
  const L = seg.length;
  const s = end === 'a' ? Math.min(t, L) : Math.max(L - t, 0);
  const u = L > 0 ? s / L : 0;
  seg.curve.getPointAt(u, _p);
  seg.curve.getTangentAt(u, _t);
  let dx = _t.x, dz = _t.z;
  if (end === 'b') { dx = -dx; dz = -dz; }
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;
  return { x: _p.x, z: _p.z, y: network.heightAt(seg, s), dx, dz, rx: -dz, rz: dx, s };
}

function lineIntersect(ax, az, ux, uz, bx, bz, vx, vz) {
  const den = ux * vz - uz * vx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = bx - ax, qz = bz - az;
  return { alpha: (qx * vz - qz * vx) / den, beta: (qx * uz - qz * ux) / den };
}

/** Distance along ray (q, n) to the first hit on polyline `poly` ([{x,z}]), or null. */
function rayPolyline(qx, qz, nx, nz, poly) {
  let best = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const vx = b.x - a.x, vz = b.z - a.z;
    const r = lineIntersect(qx, qz, nx, nz, a.x, a.z, vx, vz);
    if (!r || r.beta < -1e-6 || r.beta > 1 + 1e-6 || r.alpha < 0) continue;
    if (best == null || r.alpha < best) best = r.alpha;
  }
  return best;
}

/**
 * Solve the corner between end i (its right edge) and the next end j counter-clockwise (its left
 * edge). `ei.frameTrim` is the trim the frames were evaluated at; the returned needTrim values are
 * absolute (relative to that frame), never relative to a trim that was bumped earlier this pass.
 */
function solveCorner(ei, fi, ej, fj, k, node) {
  const cwI = ei.type.cwHalf, cwJ = ej.type.cwHalf;
  const swI = ei.type.sidewalk + (ei.type.hasCurb ? 0.2 : 0) + (ei.type.verge || 0);
  const swJ = ej.type.sidewalk + (ej.type.hasCurb ? 0.2 : 0) + (ej.type.verge || 0);
  const Ax = fi.x + fi.rx * cwI, Az = fi.z + fi.rz * cwI; // right edge of i
  const Bx = fj.x - fj.rx * cwJ, Bz = fj.z - fj.rz * cwJ; // left edge of j
  const yI = fi.y + surfaceOffset(ei.type, cwI), yJ = fj.y + surfaceOffset(ej.type, -cwJ);
  const delta = k === 1 ? Math.PI * 2 : wrapTau(Math.atan2(fj.dz, fj.dx) - Math.atan2(fi.dz, fi.dx));
  const edgeType = swI >= swJ ? ei.type : ej.type;
  const out = { kind: 'flat', needTrimI: ei.frameTrim, needTrimJ: ej.frameTrim, pts: [], edgeType, swI, swJ, degenerate: false, A: { x: Ax, z: Az }, B: { x: Bx, z: Bz } };
  const push = (x, z, nx, nz, w) => out.pts.push({ x, z, nx, nz, w, y: 0, f: 0 });
  const flat = () => {
    push(Ax, Az, fi.rx, fi.rz, swI);
    push(Bx, Bz, -fj.rx, -fj.rz, swJ);
    out.degenerate = Math.hypot(Ax - Bx, Az - Bz) < 0.02;
  };

  const uAx = -fi.dx, uAz = -fi.dz, uBx = -fj.dx, uBz = -fj.dz;
  const r = k > 1 && delta < Math.PI - 0.15 * DEG ? lineIntersect(Ax, Az, uAx, uAz, Bx, Bz, uBx, uBz) : null;
  if (k > 1 && Math.abs(delta - Math.PI) < 0.15 * DEG) {
    // collinear continuation
    if (Math.abs(cwI - cwJ) > 0.05 || ei.type !== ej.type) {
      const need = Math.abs(cwI - cwJ) * 1.2 + Math.abs(swI - swJ) * 0.6 + 2.0;
      out.needTrimI = Math.max(ei.frameTrim, need);
      out.needTrimJ = Math.max(ej.frameTrim, need);
    }
    flat();
  } else if (k > 1 && delta < Math.PI && r) {
    out.kind = 'fillet';
    // full radius (3 m local / 6 m avenue) down to 40°; only very acute wedges shrink it so trims stay sane
    const Rfull = Math.min(ei.type.cornerRadius, ej.type.cornerRadius);
    const R = Math.max(1.2, Rfull * Math.min(1, Math.max(0.4, delta / (40 * DEG))));
    const td = R / Math.tan(delta / 2);
    // edge lines must reach the tangent points: the mouth edge point must lie ≥ td + 0.3 before the apex
    if (r.alpha < td + 0.3) out.needTrimI = ei.frameTrim + (td + 0.3 - r.alpha);
    if (r.beta < td + 0.3) out.needTrimJ = ej.frameTrim + (td + 0.3 - r.beta);
    const Cx = Ax + uAx * r.alpha, Cz = Az + uAz * r.alpha;
    const Tix = Cx + fi.dx * td, Tiz = Cz + fi.dz * td;
    const Tjx = Cx + fj.dx * td, Tjz = Cz + fj.dz * td;
    let bx = fi.dx + fj.dx, bz = fi.dz + fj.dz;
    const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
    const Ox = Cx + bx * (R / Math.sin(delta / 2)), Oz = Cz + bz * (R / Math.sin(delta / 2));
    // sidewalk block corner (mitre of the offset edge lines)
    const Apx = Ax + fi.rx * swI, Apz = Az + fi.rz * swI, Bpx = Bx - fj.rx * swJ, Bpz = Bz - fj.rz * swJ;
    const rp = lineIntersect(Apx, Apz, uAx, uAz, Bpx, Bpz, uBx, uBz);
    const Cpx = rp ? Apx + uAx * rp.alpha : (Apx + Bpx) / 2, Cpz = rp ? Apz + uAz * rp.alpha : (Apz + Bpz) / 2;
    const mitre = [{ x: Tix + fi.rx * swI, z: Tiz + fi.rz * swI }, { x: Cpx, z: Cpz }, { x: Tjx - fj.rx * swJ, z: Tjz - fj.rz * swJ }];
    const maxW = Math.max(swI, swJ) * 2.6 + 0.4, minW = 0.05;

    if (Math.hypot(Ax - Tix, Az - Tiz) > 0.02) push(Ax, Az, fi.rx, fi.rz, swI);
    push(Tix, Tiz, fi.rx, fi.rz, swI);
    const a0 = Math.atan2(Tiz - Oz, Tix - Ox), a1 = Math.atan2(Tjz - Oz, Tjx - Ox);
    const sweep = wrapPi(a1 - a0);
    const n = Math.max(5, Math.ceil((R * Math.abs(sweep)) / 0.45));
    for (let s = 1; s < n; s++) {
      const a = a0 + (sweep * s) / n;
      const qx = Ox + Math.cos(a) * R, qz = Oz + Math.sin(a) * R;
      const nx = (Ox - qx) / R, nz = (Oz - qz) / R;
      let w = rayPolyline(qx, qz, nx, nz, mitre);
      if (w == null) w = swI + (swJ - swI) * (s / n);
      push(qx, qz, nx, nz, Math.min(maxW, Math.max(minW, w)));
    }
    push(Tjx, Tjz, -fj.rx, -fj.rz, swJ);
    if (Math.hypot(Bx - Tjx, Bz - Tjz) > 0.02) push(Bx, Bz, -fj.rx, -fj.rz, swJ);
  } else if (k > 1 && delta < Math.PI) {
    // edges parallel but not collinear (offset continuation) — straight connector, keep the sidewalks
    flat();
    out.degenerate = false;
  } else {
    // reflex wedge (outer side of a bend) or dead-end cap: arc around the node
    out.kind = 'round';
    const Nx = node.x, Nz = node.z;
    const rA = Math.hypot(Ax - Nx, Az - Nz), rB = Math.hypot(Bx - Nx, Bz - Nz);
    const a0 = Math.atan2(Az - Nz, Ax - Nx);
    let sweep = wrapTau(Math.atan2(Bz - Nz, Bx - Nx) - a0);
    if (k === 1) sweep = Math.PI;
    const n = Math.max(6, Math.ceil((Math.max(rA, rB) * sweep) / 0.5));
    for (let s = 0; s <= n; s++) {
      const f = s / n;
      const a = a0 + sweep * f;
      const rad = rA + (rB - rA) * f;
      const cx = Math.cos(a), cz = Math.sin(a);
      push(Nx + cx * rad, Nz + cz * rad, cx, cz, swI + (swJ - swI) * f);
    }
    // make the end points exactly the mouth edge points
    out.pts[0].x = Ax; out.pts[0].z = Az; out.pts[0].nx = fi.rx; out.pts[0].nz = fi.rz;
    const last = out.pts[out.pts.length - 1];
    last.x = Bx; last.z = Bz; last.nx = -fj.rx; last.nz = -fj.rz;
  }
  // heights: on the junction plane, with the (tiny) residuals of the actual mouth edge heights blended
  // in so the strip meets the segment cap vertices exactly
  let total = 0;
  for (let i = 1; i < out.pts.length; i++) total += Math.hypot(out.pts[i].x - out.pts[i - 1].x, out.pts[i].z - out.pts[i - 1].z);
  const resI = yI - planeY(node, Ax, Az), resJ = yJ - planeY(node, Bx, Bz);
  let acc = 0;
  for (let i = 0; i < out.pts.length; i++) {
    const p = out.pts[i];
    if (i > 0) acc += Math.hypot(p.x - out.pts[i - 1].x, p.z - out.pts[i - 1].z);
    const f = total > 0 ? acc / total : 0;
    p.f = f;
    p.y = planeY(node, p.x, p.z) + resI + (resJ - resI) * f;
  }
  if (out.pts.length) { out.pts[0].y = yI; out.pts[out.pts.length - 1].y = yJ; }
  return out;
}

export function computeJunction(node, network) {
  const ends = [];
  for (const segId of node.segments) {
    const seg = network.segments.get(segId);
    if (!seg) continue;
    if (seg.a === node.id) ends.push({ seg, end: 'a', type: ROAD_TYPES[seg.type], trim: 0, frameTrim: 0, frame: null, angle: 0 });
    if (seg.b === node.id) ends.push({ seg, end: 'b', type: ROAD_TYPES[seg.type], trim: 0, frameTrim: 0, frame: null, angle: 0 });
  }
  const k = ends.length;
  if (k === 0) { node.junction = null; return; }
  for (const e of ends) {
    e.frame = endFrame(network, e.seg, e.end, 0);
    e.angle = Math.atan2(e.frame.dz, e.frame.dx);
  }
  ends.sort((a, b) => a.angle - b.angle);

  let corners = [];
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    corners = [];
    for (const e of ends) { e.frame = endFrame(network, e.seg, e.end, e.trim); e.frameTrim = e.trim; }
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      const ei = ends[i], ej = ends[j];
      const c = solveCorner(ei, ei.frame, ej, ej.frame, k, node);
      c.i = i; c.j = j;
      const maxTrimI = Math.max(0.5, ei.seg.length * 0.45), maxTrimJ = Math.max(0.5, ej.seg.length * 0.45);
      if (c.needTrimI > ei.trim + 1e-3) { const nt = Math.min(maxTrimI, c.needTrimI); changed = changed || nt > ei.trim + 1e-3; ei.trim = nt; }
      if (c.needTrimJ > ej.trim + 1e-3) { const nt = Math.min(maxTrimJ, c.needTrimJ); changed = changed || nt > ej.trim + 1e-3; ej.trim = nt; }
      corners.push(c);
    }
    if (!changed) break;
  }

  const vehicleEnds = ends.filter((e) => e.type.lanes > 0);
  const kv = vehicleEnds.length;
  const kind = k === 1 ? 'dead' : kv >= 3 ? 'inter' : 'cont';
  const sameType = k === 2 && ends[0].type === ends[1].type;
  const bridgeCentre = sameType && ends[0].type.centre.length > 0 && (ends[0].trim > 0.01 || ends[1].trim > 0.01);

  for (const e of ends) {
    const seg = e.seg, type = e.type;
    let flags = 0;
    if (kv >= 3 && type.stopLines) flags |= 16;
    if (kv >= 3 && type.crosswalks) flags |= 8;
    if (kv === 2 && k > kv && type.crosswalks && e === vehicleEnds[0]) flags |= 8; // path meets a road: crosswalk only
    if (type.lanes > 0 && kv >= 3) {
      const travel = { x: -e.frame.dx, z: -e.frame.dz };
      for (const o of vehicleEnds) {
        if (o === e) continue;
        const rel = wrapPi(headingOf(o.frame.dx, o.frame.dz) - headingOf(travel.x, travel.z));
        const a = Math.abs(rel);
        if (a <= Math.PI / 6) flags |= 2;
        else if (a < (5 * Math.PI) / 6) flags |= rel > 0 ? 4 : 1;
      }
    }
    if (kind === 'dead') flags |= 32;   // bit 5 = dead end (no markings; the shader fades wheel tracks out)
    const gap = kind === 'inter' ? type.centreGap.intersection : kind === 'dead' ? type.centreGap.deadEnd : 0;
    const cap = !(kind === 'cont' && sameType);
    const bridge = bridgeCentre;
    if (e.end === 'a') { seg.trimA = e.trim; seg.kindA = kind; seg.flagsA = flags; seg.gapA = gap; seg.capA = cap; seg.bridgeA = bridge; }
    else { seg.trimB = e.trim; seg.kindB = kind; seg.flagsB = flags; seg.gapB = gap; seg.capB = cap; seg.bridgeB = bridge; }
  }

  let dominant = ends[0].type;
  for (const e of ends) if (e.type.rank > dominant.rank) dominant = e.type;
  // outer radius of the pad (fan + corner sidewalks), used for terrain conforming and vegetation clearing
  let padRadius = 0;
  for (const e of ends) padRadius = Math.max(padRadius, e.trim + e.type.width * 0.5);
  node.junction = {
    k, kind, dominant, bridgeCentre, padRadius,
    // a pad is planar (heights blended onto node.grad) whenever the arms are trimmed back
    pad: k >= 3 || ends.some((e) => e.trim > 0.01),
    ends: ends.map((e) => ({ segId: e.seg.id, end: e.end, type: e.type, trim: e.trim, frame: e.frame })),
    corners,
  };
}
