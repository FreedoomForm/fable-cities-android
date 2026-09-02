/**
 * Road tool — click-click node placement, straight and curved, CS2-style snapping and guides.
 *
 *   LMB          place a node (chains: the end node becomes the next anchor)
 *   RMB / Esc    drop the last node, then the whole run
 *   C            toggle straight ⇄ curved (quadratic, 3 clicks: start · bend · end)
 *   Shift        suspend snapping
 *
 * Snapping order: existing junction node → point on an existing segment (creates a T) →
 * 45° guide ray from the anchor (also relative to the road the anchor sits on) → free.
 * The ghost carriageway is the real road width, conformed to the terrain, with hologram stripes,
 * hot edges, a dashed centre line, direction chevrons, a length/cost chip and an angle read-out.
 */
import { PAL, arc } from './gfx.js';

const COST_PER_M = { local: 180, avenue: 420, highway: 900, path: 60 };
const SNAP_NODE_R = 13;
const SNAP_SEG_R = 9;
const ANGLE_SNAP = Math.PI / 4;
const ANGLE_TOL = 4.0 * Math.PI / 180;
const MAX_SLOPE = 0.25;   // sustained gradient over ~10 m; conformPath grades everything gentler
const GHOST_LIFT = 0.22;   // float the ghost above kerbs and sidewalks of existing roads

export function createRoadTool(env) {
  const { world, events } = env;
  const S = {
    nodes: [],        // committed clicks of the current run
    type: 'local',
    curve: 'straight',
    cursor: null,     // { x, z, snap:{kind,id}, guide:number|null }
    lastBuiltEnd: null,
    flash: 0,
    staged: null,
  };

  const roadsApi = () => (world.roads && world.roads.api) || null;
  const widthOf = (t) => {
    const api = roadsApi();
    const rec = api && api.types && api.types[t];
    return (rec && rec.width) || 12;
  };
  const costPerM = (t) => {
    const o = world.tool && world.tool.options;
    if (o && o.type === t && typeof o.cost === 'number' && o.cost > 0) return o.cost;
    return COST_PER_M[t] || 180;
  };

  // ---------------------------------------------------------------- geometry
  /** Sample the pending curve (start → … → cursor) into dense world points. */
  function samplePath(pts) {
    const out = [];
    if (pts.length < 2) return out;
    const total = pathLength(pts);
    const n = Math.max(8, Math.min(220, Math.ceil(total / 2.2)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = pts.length >= 3 ? quad(pts[0], pts[1], pts[2], t) : lerpP(pts[0], pts[1], t);
      out.push(p);
    }
    return out;
  }
  const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  const quad = (a, b, c, t) => {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, z: u * u * a.z + 2 * u * t * b.z + t * t * c.z };
  };
  function pathLength(pts) {
    if (pts.length >= 3) {
      let l = 0, prev = pts[0];
      for (let i = 1; i <= 24; i++) { const p = quad(pts[0], pts[1], pts[2], i / 24); l += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
      return l;
    }
    return Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  }

  /** Ghost validity + measurements for the current pending path. */
  function evaluate(pts, evalType = S.type) {
    const samples = samplePath(pts);
    let length = 0, water = false, out = false;
    let prev = null;
    for (const p of samples) {
      p.y = world.terrain.getHeight(p.x, p.z);
      if (!world.inBounds(p.x, p.z)) out = true;
      if (world.terrain.isWater(p.x, p.z)) water = true;
      if (prev) length += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    // Gradient over a ~10 m window: local bumps are graded away by terrain.api.conformPath,
    // only a sustained climb is a real "too steep".
    let maxSlope = 0;
    if (samples.length > 1) {
      const step = length / (samples.length - 1) || 1;
      const win = Math.max(2, Math.round(10 / step));
      for (let i = 0; i + win < samples.length; i++) {
        const d = step * win;
        maxSlope = Math.max(maxSlope, Math.abs(samples[i + win].y - samples[i].y) / d);
      }
    }
    const cost = Math.round(length * costPerM(evalType));
    const money = world.economy ? world.economy.money : Infinity;
    let reason = null;
    if (out) reason = 'outside the map';
    else if (length < 6) reason = 'too short';
    else if (water) reason = 'crosses water';
    else if (maxSlope > MAX_SLOPE) reason = 'too steep';
    else if (cost > money) reason = 'not enough funds';
    return { samples, length, cost, slope: maxSlope, ok: !reason, reason };
  }

  // ---------------------------------------------------------------- snapping
  function guideAngles(anchor) {
    const list = [];
    for (let i = 0; i < 8; i++) list.push({ a: i * ANGLE_SNAP, kind: 'world' });
    const api = roadsApi();
    if (api) {
      const hit = api.nearest(anchor.x, anchor.z, 26);
      if (hit && hit.tangent) {
        const base = Math.atan2(hit.tangent.z, hit.tangent.x);
        for (let i = 0; i < 8; i++) list.push({ a: base + i * ANGLE_SNAP, kind: 'road' });
      }
    }
    return list;
  }

  function solveCursor(gx, gz, free) {
    const api = roadsApi();
    const anchor = S.nodes.length ? S.nodes[S.nodes.length - 1] : null;
    const res = { x: gx, z: gz, snap: null, guide: null, guides: [] };
    if (free) return res;
    if (api) {
      const s = api.snap(gx, gz, SNAP_NODE_R);
      if (s && s.nodeId != null) { res.x = s.x; res.z = s.z; res.snap = { kind: 'node', id: s.nodeId }; return res; }
      if (s && s.segmentId != null && Math.hypot(s.x - gx, s.z - gz) < SNAP_SEG_R) {
        res.x = s.x; res.z = s.z; res.snap = { kind: 'segment', id: s.segmentId, t: s.t }; return res;
      }
    }
    if (!anchor) return res;
    const dx = gx - anchor.x, dz = gz - anchor.z;
    const len = Math.hypot(dx, dz);
    if (len < 2) return res;
    const ang = Math.atan2(dz, dx);
    res.guides = guideAngles(anchor);
    let best = null, bestD = ANGLE_TOL;
    for (const g of res.guides) {
      let d = Math.abs(wrap(ang - g.a));
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) {
      res.x = anchor.x + Math.cos(best.a) * len;
      res.z = anchor.z + Math.sin(best.a) * len;
      res.guide = best.a;
      res.snap = { kind: 'guide' };
    }
    return res;
  }
  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

  // ---------------------------------------------------------------- lifecycle
  function enter(options = {}) {
    S.type = options.type && widthOf(options.type) ? options.type : 'local';
    if (options.curve === 'bezier' || options.curve === 'straight') S.curve = options.curve;
    S.nodes.length = 0;
    S.cursor = null;
  }
  function exit() { S.nodes.length = 0; S.cursor = null; }
  function cancel() {
    if (S.nodes.length) { S.nodes.pop(); return true; }
    return false;
  }

  function pending() {
    if (!S.cursor) return null;
    const pts = S.nodes.concat([{ x: S.cursor.x, z: S.cursor.z }]);
    return pts.length >= 2 ? pts : null;
  }

  function click() {
    if (!S.cursor) return;
    const p = { x: S.cursor.x, z: S.cursor.z, snap: S.cursor.snap };
    const need = S.curve === 'bezier' ? 3 : 2;
    if (S.nodes.length + 1 < need) {
      S.nodes.push(p);
      env.audio('click');
      return;
    }
    const pts = S.nodes.concat([p]);
    const ev = evaluate(pts);
    if (!ev.ok) {
      env.audio('error');
      env.notify('warning', 'Cannot build here', ev.reason);
      S.flash = 0.5;
      return;
    }
    const api = roadsApi();
    if (!api) return;
    const built = api.build(pts.map((q) => ({ x: q.x, z: q.z })), S.type, { curve: S.curve === 'bezier' ? 'bezier' : 'straight' });
    if (built && built.segments && built.segments.length) {
      if (world.economy) {
        world.economy.money -= ev.cost;
        events.emit('economy:changed', world.economy);
      }
      env.audio('road');
      S.lastBuiltEnd = { x: p.x, z: p.z, t: env.time };
      S.nodes.length = 0;
      S.nodes.push({ x: p.x, z: p.z, snap: { kind: 'node' } }); // chain from the new end node
    } else {
      env.audio('error');
      S.nodes.length = 0;
    }
  }

  function update() {
    const g = env.ground();
    if (!g) { S.cursor = null; return; }
    S.cursor = solveCursor(g.x, g.z, env.input.shift);
    if (env.pressed('c')) S.curve = S.curve === 'bezier' ? 'straight' : 'bezier';
    if (env.click) click();
    if (env.rightClick) { if (S.nodes.length) { S.nodes.pop(); env.audio('click'); } }
    S.flash = Math.max(0, S.flash - env.dt * 2);
  }

  // ---------------------------------------------------------------- drawing
  function drawGhost(pts, opts = {}, staged = null) {
    const type = (staged && staged.type) || S.type;
    const { vec, fill, groundY } = env;
    const ev = evaluate(pts, type);
    const ok = opts.forceValid != null ? opts.forceValid : ev.ok;
    const col = ok ? PAL.accent : PAL.bad;
    const hi = ok ? PAL.accentHi : PAL.badHi;
    const w = widthOf(type);
    const s = ev.samples;
    if (s.length < 2) return ev;
    const left = [], right = [], along = [], centre = [];
    let run = 0;
    for (let i = 0; i < s.length; i++) {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      if (i > 0) run += Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z);
      const cy = groundY(s[i].x, s[i].z) + GHOST_LIFT;
      centre.push({ x: s[i].x, y: cy, z: s[i].z });
      left.push({ x: s[i].x - nx * w * 0.5, y: groundY(s[i].x - nx * w * 0.5, s[i].z - nz * w * 0.5) + GHOST_LIFT, z: s[i].z - nz * w * 0.5 });
      right.push({ x: s[i].x + nx * w * 0.5, y: groundY(s[i].x + nx * w * 0.5, s[i].z + nz * w * 0.5) + GHOST_LIFT, z: s[i].z + nz * w * 0.5 });
      along.push(run);
    }
    const alpha = 0.52 + (S.flash > 0 ? Math.sin(S.flash * 30) * 0.25 : 0);
    fill.strip(left, right, along, col, [alpha, 1, 0.55, 0]);
    vec.polyline(left, { color: hi, width: 2.4, alpha: 0.95, glow: 0.7 });
    vec.polyline(right, { color: hi, width: 2.4, alpha: 0.95, glow: 0.7 });
    if (w > 4) vec.polyline(centre, { color: hi, width: 1.6, dash: 6, alpha: 0.6, glow: 0.4 });
    // direction chevrons every ~24 m
    const step = Math.max(18, ev.length / 6);
    for (let dpos = step * 0.6; dpos < ev.length - 4; dpos += step) {
      const i = nearestIndex(along, dpos);
      if (i <= 0 || i >= s.length - 1) continue;
      let tx = s[i + 1].x - s[i - 1].x, tz = s[i + 1].z - s[i - 1].z;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      const back = Math.max(3.0, w * 0.42), side = Math.max(2.2, w * 0.34);
      const tip = centre[i];
      const p1 = { x: tip.x - tx * back - nx * side, z: tip.z - tz * back - nz * side };
      const p3 = { x: tip.x - tx * back + nx * side, z: tip.z - tz * back + nz * side };
      vec.polyline([
        { x: p1.x, y: groundY(p1.x, p1.z) + GHOST_LIFT, z: p1.z },
        { x: tip.x, y: tip.y, z: tip.z },
        { x: p3.x, y: groundY(p3.x, p3.z) + GHOST_LIFT, z: p3.z },
      ], { color: hi, width: 3.8, alpha: 1.0, glow: 1.8 });
    }
    return ev;
  }

  function nearestIndex(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  function nodeMarker(p, { color = PAL.accentHi, r = 3.2, pulse = false } = {}) {
    const { vec, groundY } = env;
    const rr = pulse ? r + Math.sin(env.time * 4) * 0.35 : r;
    vec.polyline(arc(p.x, p.z, rr, 0, Math.PI * 2, groundY), { color, width: 2.6, alpha: 0.95, glow: 1.0, closed: false });
    vec.polyline(arc(p.x, p.z, rr * 0.42, 0, Math.PI * 2, groundY), { color, width: 2.0, alpha: 0.8, glow: 1.2 });
  }

  function drawGuides(anchor, cursor) {
    const { vec, groundY } = env;
    if (!anchor || !cursor) return;
    const len = Math.max(70, Math.hypot(cursor.x - anchor.x, cursor.z - anchor.z) * 1.35);
    const guides = cursor.guides && cursor.guides.length ? cursor.guides : guideAngles(anchor);
    for (const g of guides) {
      const active = cursor.guide != null && Math.abs(wrap(g.a - cursor.guide)) < 1e-4;
      const ex = anchor.x + Math.cos(g.a) * len, ez = anchor.z + Math.sin(g.a) * len;
      const p0 = { x: anchor.x, y: groundY(anchor.x, anchor.z), z: anchor.z };
      const p1 = { x: ex, y: groundY(ex, ez), z: ez };
      const mid = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = p0.x + (p1.x - p0.x) * t, z = p0.z + (p1.z - p0.z) * t;
        mid.push({ x, y: groundY(x, z), z });
      }
      vec.polyline(mid, {
        color: active ? PAL.snap : PAL.guide,
        width: active ? 3.0 : 2.0,
        dash: active ? 0 : 5.0,
        alpha: active ? 1.0 : (g.kind === 'road' ? 0.72 : 0.55),
        glow: active ? 1.6 : 0.25,
      });
    }
  }

  function drawAngle(pts) {
    if (pts.length < 3) return null;
    const a = pts[pts.length - 3], b = pts[pts.length - 2], c = pts[pts.length - 1];
    const a1 = Math.atan2(a.z - b.z, a.x - b.x);
    const a2 = Math.atan2(c.z - b.z, c.x - b.x);
    let d = wrap(a2 - a1);
    const r = Math.min(16, Math.max(7, Math.hypot(c.x - b.x, c.z - b.z) * 0.3));
    env.vec.polyline(arc(b.x, b.z, r, a1, a1 + d, env.groundY), { color: PAL.snap, width: 1.8, alpha: 0.85, glow: 0.8 });
    return { deg: Math.abs(d) * 180 / Math.PI, at: b, r };
  }

  function draw() {
    if (S.staged && S.staged.length) { for (const st of S.staged) drawOne(st.nodes, st.cursor, st); return; }
    drawOne(S.nodes, S.cursor, null);
  }

  function drawOne(nodes, cursor, staged) {
    const { vec, groundY } = env;
    if (!cursor && !nodes.length) return;
    const anchor = nodes.length ? nodes[nodes.length - 1] : null;
    if (anchor && cursor) drawGuides(anchor, cursor);

    const pts = cursor ? nodes.concat([{ x: cursor.x, z: cursor.z }]) : nodes.slice();
    let ev = null;
    if (pts.length >= 2) {
      // in curved mode with a single anchor the preview is the straight lead-in
      ev = drawGhost(pts, staged && staged.invalid != null ? { forceValid: !staged.invalid } : {}, staged);
      if (pts.length >= 3) {
        // control-point handle
        vec.polyline([
          { x: pts[0].x, y: groundY(pts[0].x, pts[0].z), z: pts[0].z },
          { x: pts[1].x, y: groundY(pts[1].x, pts[1].z), z: pts[1].z },
          { x: pts[2].x, y: groundY(pts[2].x, pts[2].z), z: pts[2].z },
        ], { color: PAL.guide, width: 1.2, dash: 3.2, alpha: 0.5, glow: 0.2 });
      }
    }
    for (let i = 0; i < nodes.length; i++) nodeMarker(nodes[i], { color: PAL.accentHi, r: 3.4 });
    if (cursor) {
      const snapKind = cursor.snap && cursor.snap.kind;
      nodeMarker(cursor, { color: snapKind === 'node' || snapKind === 'segment' ? PAL.snap : PAL.accentHi, r: snapKind ? 4.6 : 3.0, pulse: true });
      if (snapKind === 'node' || snapKind === 'segment') {
        const y = groundY(cursor.x, cursor.z);
        const k = 7.5;
        vec.polyline([{ x: cursor.x - k, y, z: cursor.z }, { x: cursor.x + k, y, z: cursor.z }], { color: PAL.snap, width: 1.6, alpha: 0.75, glow: 1.0 });
        vec.polyline([{ x: cursor.x, y, z: cursor.z - k }, { x: cursor.x, y, z: cursor.z + k }], { color: PAL.snap, width: 1.6, alpha: 0.75, glow: 1.0 });
      }
    }
    // read-outs
    const ang = pts.length >= 3 ? drawAngle(pts) : null;
    const type = staged && staged.type ? staged.type : S.type;
    const mode = (staged && staged.curve ? staged.curve : S.curve) === 'bezier' ? 'curved' : 'straight';
    if (ev && cursor) {
      const valid = staged && staged.invalid != null ? !staged.invalid : ev.ok;
      const chip = env.nextChip();
      chip.set({
        value: `${ev.length.toFixed(0)} m`,
        title: valid ? `₡${fmt(ev.cost)}` : (ev.reason || (staged && staged.reason) || 'blocked'),
        sub: `${label(type)} · ${mode}`,
        tone: valid ? 'accent' : 'bad',
      });
      const at = staged && ev.samples.length ? ev.samples[Math.floor(ev.samples.length * 0.55)] : cursor;
      chip.place(at.x, groundY(at.x, at.z) + 8.5, at.z);
    } else if (cursor && !nodes.length) {
      const chip = env.nextChip();
      chip.set({ title: 'Click to start a road', sub: `${label(type)} · ${mode} · C to switch`, tone: 'accent' });
      chip.place(cursor.x, groundY(cursor.x, cursor.z) + 5.5, cursor.z);
    }
    if (ang) {
      const chip = env.nextChip();
      chip.set({ value: `${ang.deg.toFixed(0)}°`, tone: 'warn' });
      chip.place(ang.at.x, groundY(ang.at.x, ang.at.z) + 3.0, ang.at.z);
    }
  }
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const label = (t) => ({ local: 'Two-lane road', avenue: 'Four-lane avenue', highway: 'Highway', path: 'Pedestrian path' })[t] || t;

  function stage(spec) {
    if (!spec) { S.staged = null; return; }
    const specs = Array.isArray(spec) ? spec : [spec];
    S.staged = specs.map((sp) => {
      const pts = (sp.points || []).map((p) => ({ x: p.x, z: p.z }));
      const cursorPt = pts.length ? pts[pts.length - 1] : null;
      return {
        type: sp.type || S.type,
        curve: sp.curve || (pts.length > 2 ? 'bezier' : 'straight'),
        nodes: pts.slice(0, -1),
        cursor: cursorPt ? { x: cursorPt.x, z: cursorPt.z, snap: sp.snap || null, guide: sp.guide !== undefined ? sp.guide : guideOf(pts), guides: null } : null,
        invalid: sp.invalid === undefined ? null : !!sp.invalid,
        reason: sp.reason || null,
      };
    }).filter((s2) => s2.cursor);
  }
  function guideOf(pts) {
    if (pts.length < 2) return null;
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    const k = Math.round(ang / ANGLE_SNAP) * ANGLE_SNAP;
    return Math.abs(wrap(ang - k)) < 0.02 ? k : null;
  }

  return { name: 'road', enter, exit, update, draw, cancel, stage, state: S, cursorStyle: () => 'crosshair' };
}
