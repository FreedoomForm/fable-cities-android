/**
 * Select and bulldoze — both work on the same picker and highlight vocabulary.
 * Select: soft white hover, cyan cage + corner brackets + sweeping ring on the selection,
 *         emits entity:selected { kind, id, entity } (and null on deselect).
 * Bulldoze: red hatched footprint, animated danger cage, click (or drag) removes and refunds.
 */
import { PAL } from './gfx.js';
import { drawFootprint, drawCage, drawSelectionRing } from './shapes.js';
import { footprintOf } from './picking.js';

const ROAD_LIFT = 0.22;  // road surfaces (kerb + sidewalk) sit above the conformed terrain
const ROAD_COST = { local: 180, avenue: 420, highway: 900, path: 60 };
const ROAD_LABEL = { local: 'Two-lane road', avenue: 'Four-lane avenue', highway: 'Highway', path: 'Pedestrian path' };
const ZONE_LABEL = {
  'res-low': 'Low density residential', 'res-high': 'High density residential',
  'com-low': 'Low density commercial', 'com-high': 'High density commercial',
  ind: 'Industrial', office: 'Office',
};
const BUILD_LABEL = {
  'res-low': 'House', 'res-high': 'Apartments', 'com-low': 'Shop',
  'com-high': 'Commercial tower', ind: 'Factory', office: 'Office building',
};

export function describe(hit, world) {
  if (!hit || !hit.entity) return null;
  const e = hit.entity;
  if (hit.kind === 'building') {
    return {
      title: `${BUILD_LABEL[e.type] || e.type || 'Building'}`,
      value: `Lv ${e.level || 1}`,
      sub: e.state === 'construction' ? 'Under construction' : (e.residents ? `${e.residents} residents` : (e.jobs ? `${e.jobs} jobs` : `${Math.round(e.height || 0)} m tall`)),
    };
  }
  if (hit.kind === 'service') {
    return { title: e.name || 'Service', value: `${Math.round(e.radius || 0)} m`, sub: `${Math.round((e.efficiency != null ? e.efficiency : 1) * 100)}% efficiency · ${e.workers || 0} staff` };
  }
  if (hit.kind === 'road') {
    return { title: ROAD_LABEL[e.type] || 'Road', value: `${Math.round(e.length || 0)} m`, sub: `${(e.lanes && e.lanes.length) || 0} lanes · ${Math.round(e.width || 0)} m wide` };
  }
  if (hit.kind === 'lot') {
    return { title: ZONE_LABEL[e.type] || 'Lot', value: `${Math.round((e.w || 0) * (e.d || 0))} m²`, sub: e.buildingId ? 'Developed' : 'Vacant plot' };
  }
  void world;
  return null;
}

/** Anchor point for a chip over a road (or any point entity). */
function midOf(hit, env) {
  const e = hit.entity;
  if (e && Array.isArray(e.points) && e.points.length) return e.points[Math.floor(e.points.length / 2)];
  if (hit.point) return hit.point;
  return { x: e && e.x ? e.x : 0, z: e && e.z ? e.z : 0, y: env.groundY(0, 0) };
}

/** Edge polylines of a road segment (centre line offset by ±width/2). */
function roadEdges(env, seg) {
  const pts = seg.points || [];
  if (pts.length < 2) return null;
  const w = (seg.width || 12) / 2;
  const left = [], right = [], centre = [];
  const stride = Math.max(1, Math.floor(pts.length / 90));
  for (let i = 0; i < pts.length; i += stride) {
    const a = pts[Math.max(0, i - stride)], b = pts[Math.min(pts.length - 1, i + stride)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = -tz, nz = tx;
    const p = pts[i];
    const gy = (p.y != null ? p.y + ROAD_LIFT : env.groundY(p.x, p.z));
    centre.push({ x: p.x, y: gy, z: p.z });
    left.push({ x: p.x - nx * w, y: env.groundY(p.x - nx * w, p.z - nz * w) + ROAD_LIFT, z: p.z - nz * w });
    right.push({ x: p.x + nx * w, y: env.groundY(p.x + nx * w, p.z + nz * w) + ROAD_LIFT, z: p.z + nz * w });
  }
  return { left, right, centre };
}

function drawRoad(env, seg, color, opts = {}) {
  const e = roadEdges(env, seg);
  if (!e) return;
  const { vec, fill } = env;
  vec.polyline(e.left, { color, width: opts.width || 2.6, alpha: 0.95, glow: 1.0 });
  vec.polyline(e.right, { color, width: opts.width || 2.6, alpha: 0.95, glow: 1.0 });
  const cap = (i) => vec.polyline([e.left[i], e.right[i]], { color, width: opts.width || 2.6, alpha: 0.9, glow: 1.0 });
  cap(0); cap(e.left.length - 1);
  if (opts.fill) {
    const along = [];
    let run = 0;
    for (let i = 0; i < e.centre.length; i++) {
      if (i) run += Math.hypot(e.centre[i].x - e.centre[i - 1].x, e.centre[i].z - e.centre[i - 1].z);
      along.push(run);
    }
    fill.strip(e.left, e.right, along, color, [opts.fillAlpha || 0.45, opts.pattern || 4, 0.35, 0]);
  }
}

// ---------------------------------------------------------------------------

export function createSelectTool(env) {
  const { world, events } = env;
  const S = { hover: null, staged: null };

  function enter() {}
  function exit() { S.hover = null; }
  function cancel() {
    if (world.selection) { select(null); return true; }
    return false;
  }

  function select(hit) {
    if (!hit || hit.kind === 'terrain') {
      if (world.selection) { world.selection = null; events.emit('entity:selected', null); env.audio('click'); }
      return;
    }
    world.selection = { kind: hit.kind, id: hit.id, entity: hit.entity };
    events.emit('entity:selected', { kind: hit.kind, id: hit.id, entity: hit.entity });
    env.audio('select');
  }

  function update() {
    S.hover = env.overUI ? null : env.picker.pick(env.pickNdc());
    if (env.click) select(S.hover);
  }

  function currentSelection() {
    const sel = world.selection;
    if (!sel) return null;
    if (sel.entity) return sel;
    return null;
  }

  function draw() {
    const staged = S.staged;
    const hover = staged ? staged.hover : S.hover;
    const sel = staged ? staged.selection : currentSelection();
    // hover
    if (hover && hover.kind !== 'terrain' && (!sel || sel.id !== hover.id)) {
      if (hover.kind === 'road') drawRoad(env, hover.entity, PAL.white, { width: 2.0 });
      else {
        const box = footprintOf(hover, world);
        if (box) drawFootprint(env, box, PAL.white, { width: 2.0, alpha: 0.8, glow: 0.6, inset: 0.2 });
      }
    }
    if (!sel) return;
    if (sel.kind === 'road') {
      drawRoad(env, sel.entity, PAL.accentHi, { width: 3.0, fill: true, fillAlpha: 0.28, pattern: 1 });
    } else {
      const box = footprintOf(sel, world);
      if (box) {
        drawFootprint(env, box, PAL.accentHi, { width: 3.4, glow: 1.6, brackets: true, inset: 0.2 });
        drawSelectionRing(env, box, PAL.accentHi, env.time);
        if (box.height > 1.5) drawCage(env, box, PAL.accentHi, { walls: true, wallAlpha: 0.11, width: 2.8 });
      }
    }
    const info = describe(sel, world);
    if (info) {
      const box = sel.kind === 'road' ? null : footprintOf(sel, world);
      const anchor = box ? null : midOf(sel, env);
      const p = box ? { x: box.x, z: box.z, y: (box.y || 0) + (box.height || 0) + 7 }
        : { x: anchor.x, z: anchor.z, y: env.groundY(anchor.x, anchor.z) + 6.5 };
      const chip = env.nextChip();
      chip.set({ value: info.value, title: info.title, sub: info.sub, tone: 'accent' });
      chip.place(p.x, p.y, p.z);
    }
  }

  function stage(spec) {
    if (!spec) { S.staged = null; return; }
    S.staged = { hover: spec.hover || null, selection: spec.selection || null };
  }

  return { name: 'select', enter, exit, update, draw, cancel, stage, state: S, select, cursorStyle: () => (S.hover && S.hover.kind !== 'terrain' ? 'pointer' : 'default') };
}

// ---------------------------------------------------------------------------

export function createBulldozeTool(env) {
  const { world, events } = env;
  const S = { hover: null, staged: null, removedThisDrag: new Set(), flash: 0 };

  function enter() { S.removedThisDrag.clear(); }
  function exit() { S.hover = null; }
  function cancel() { return false; }

  function refundFor(hit) {
    const opts = (world.tool && world.tool.options) || {};
    const rate = typeof opts.refund === 'number' ? opts.refund : 0.5;
    const e = hit.entity;
    if (hit.kind === 'road') return Math.round((e.length || 0) * (ROAD_COST[e.type] || 180) * rate);
    if (hit.kind === 'service') {
      const types = world.services && world.services.api && world.services.api.types;
      const d = types && types[e.type];
      return Math.round(((d && d.cost) || 0) * rate);
    }
    return 0;
  }

  function remove(hit) {
    if (!hit || hit.kind === 'terrain' || !hit.entity) return false;
    const key = hit.kind + ':' + hit.id;
    if (S.removedThisDrag.has(key)) return false;
    S.removedThisDrag.add(key);
    let done = false;
    try {
      if (hit.kind === 'road' && world.roads.api) done = world.roads.api.remove(hit.id) !== false;
      else if (hit.kind === 'building' && world.buildings.api) done = world.buildings.api.remove(hit.id) !== false;
      else if (hit.kind === 'service' && world.services.api) done = world.services.api.remove(hit.id) !== false;
      else if (hit.kind === 'lot' && world.zones.api && hit.entity.cells) done = world.zones.api.paint(hit.entity.cells, null) > 0;
    } catch (err) {
      console.warn('[tools] bulldoze failed', err);
      done = false;
    }
    if (done) {
      const refund = refundFor(hit);
      if (refund && world.economy) { world.economy.money += refund; events.emit('economy:changed', world.economy); }
      if (world.selection && world.selection.id === hit.id) { world.selection = null; events.emit('entity:selected', null); }
      env.audio('bulldoze');
      S.flash = 0.35;
      S.hover = null;
    } else env.audio('error');
    return done;
  }

  function update() {
    S.flash = Math.max(0, S.flash - env.dt * 3);
    S.hover = env.overUI ? null : env.picker.pick(env.pickNdc());
    const dragging = env.input.drag && env.input.drag.button === 0 && env.input.drag.active && !env.input.alt;
    if (!env.input.drag) S.removedThisDrag.clear();
    if (env.click || (dragging && S.hover)) remove(S.hover);
  }

  function draw() {
    const staged = S.staged;
    const hover = staged ? staged.hover : S.hover;
    if (!hover || hover.kind === 'terrain') {
      if (!staged) {
        const g = env.ground();
        if (g) {
          const chip = env.nextChip();
          chip.set({ title: 'Bulldoze', sub: 'Hover a road, building or zone', tone: 'bad' });
          chip.place(g.x, env.groundY(g.x, g.z) + 5, g.z);
        }
      }
      return;
    }
    const pulse = 0.75 + 0.25 * Math.sin(env.time * 6);
    if (hover.kind === 'road') {
      drawRoad(env, hover.entity, PAL.badHi, { width: 3.0, fill: true, fillAlpha: 0.55 * pulse, pattern: 4 });
    } else {
      const box = footprintOf(hover, world);
      if (box) {
        drawFootprint(env, box, PAL.badHi, { width: 3.0, glow: 1.4, brackets: true, fill: true, fillAlpha: 0.5 * pulse, pattern: 4 });
        if (box.height > 1.5) drawCage(env, box, PAL.bad, { walls: true, wallAlpha: 0.3 * pulse, width: 2.4 });
      }
    }
    const info = describe(hover, world);
    const refund = refundFor(hover);
    const box = hover.kind === 'road' ? null : footprintOf(hover, world);
    const anchor = box ? null : midOf(hover, env);
    const p = box ? { x: box.x, z: box.z, y: (box.y || 0) + (box.height || 0) + 7 } : { x: anchor.x, z: anchor.z, y: env.groundY(anchor.x, anchor.z) + 6.5 };
    const chip = env.nextChip();
    chip.set({
      value: refund ? `+₡${refund.toLocaleString('en-US')}` : 'Demolish',
      title: info ? info.title : hover.kind,
      sub: 'Click to remove',
      tone: 'bad',
    });
    chip.place(p.x, p.y, p.z);
  }

  function stage(spec) {
    if (!spec) { S.staged = null; return; }
    S.staged = { hover: spec.hover || null };
  }

  return { name: 'bulldoze', enter, exit, update, draw, cancel, stage, state: S, cursorStyle: () => (S.hover && S.hover.kind !== 'terrain' ? 'crosshair' : 'not-allowed') };
}
