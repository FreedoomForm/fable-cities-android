/**
 * tools — the player's hands on the canvas.
 *
 * Owns `world.tool` ('select' | 'road' | 'zone' | 'bulldoze' | 'service' | 'info' | …) and every
 * on-canvas preview: CS2-style selection outlines, the road ghost with snapping guides, the zoning
 * brush with a live per-cell preview, the bulldoze danger highlight and the service placement ghost
 * with its coverage radius. Everything is built through the public module APIs (roads / zones /
 * buildings / services), so the tools work with whatever modules are actually loaded.
 *
 * Events in : tool:select (tool, options), tool:changed (from __game.setTool)
 * Events out: tool:changed, entity:selected { kind, id, entity } | null, notification, audio:play,
 *             economy:changed (road cost / bulldoze refund)
 *
 * Screenshot hooks (used by showcase.js and critics):
 *   __game.modules.tools.debugPreview('road', [{x,z},…] | { points, type, curve, invalid })
 *   __game.modules.tools.debugPreview('zone'|'service'|'bulldoze'|'select', {…})   · (null) clears
 *   __game.modules.tools.debugPointer(x, z)   pin the "cursor" so live tools draw (and pick) without a mouse
 *   __game.modules.tools.debugClick()         synthetic click at that cursor — drives the real tool path
 * Also exposed as `world.tools.api` (select, cancel, pick, selectEntity, stats, debug*).
 */
import * as THREE from 'three';
import { VectorLayer, FillLayer, Chip, PAL } from './gfx.js';
import { createPicker } from './picking.js';
import { createRoadTool } from './roadtool.js';
import { createZoneTool } from './zonetool.js';
import { createServiceTool } from './servicetool.js';
import { createSelectTool, createBulldozeTool } from './entitytool.js';

export const name = 'tools';

const LIFT = 0.16;
const KEY_TOOLS = { 1: { tool: 'road', options: { type: 'local', cost: 180 } }, 2: { tool: 'zone', options: { type: 'res-low' } }, 3: { tool: 'service', options: { type: 'police', cost: 50000 } }, 4: { tool: 'bulldoze', options: { refund: 0.5 } } };

let ctxRef = null;
let group = null;
let vec = null, fill = null;
let chips = [];
let tools = null;
let env = null;
let picker = null;
let active = null;
let staged = new Set();
let offs = [];
let keyHandler = null;
let escHandler = null;
let applying = false;
let elapsedTime = 0;
let chipIdx = 0;
let forcedGround = null;
let forceClick = 0;      // api.click() / api.rightClick(): one synthetic pointer click
let lastGround = null;
let uiPresent = () => false;
/** No pointer has touched the canvas yet (headless screenshots): keep the live tool inert. */
const pointerSeen = () => !!(ctxRef && (ctxRef.input.pointer.x !== 0 || ctxRef.input.pointer.y !== 0));
const _pick = new THREE.Vector3();
const _ndc = new THREE.Vector2();
let currentName = null;
let currentOptions = null;
let stats = { draws: 0, picks: 0 };

export async function init(ctx) {
  ctxRef = ctx;
  const { engine, scene, world, events, input, camera } = ctx;

  group = new THREE.Group();
  group.name = 'tools-overlay';
  group.matrixAutoUpdate = false;
  scene.add(group);

  vec = new VectorLayer(engine, { maxVerts: 48000, renderOrder: 3100 });
  fill = new FillLayer(engine, { maxVerts: 60000, renderOrder: 3000 });
  group.add(fill.mesh, vec.mesh);
  chips = [];
  picker = createPicker(ctx);

  const terrainY = (x, z) => {
    const t = world.terrain;
    const y = t && t.getHeight ? t.getHeight(x, z) : 0;
    return (Number.isFinite(y) ? y : 0) + LIFT;
  };

  env = {
    ctx, world, events, engine, camera, input,
    vec, fill, picker,
    nextChip: () => chipAt(chipIdx++),
    time: 0, dt: 0,
    click: false, rightClick: false, overUI: false,
    lastGround: null,
    groundY: terrainY,
    ground: () => (forcedGround || (pointerSeen() && input.groundValid && input.pointerInside ? { x: input.ground.x, z: input.ground.z } : null)),
    /** NDC to pick from: the real pointer, or the pinned debug cursor projected to screen. */
    pickNdc: () => {
      if (!forcedGround) return input.ndc;
      _pick.set(forcedGround.x, terrainY(forcedGround.x, forcedGround.z), forcedGround.z).project(camera);
      _ndc.set(_pick.x, _pick.y);
      return _ndc;
    },
    pressed: (k) => input.justPressed(k),
    audio: (n) => events.emit('audio:play', n),
    notify: (kind, title, text) => events.emit('notification', { kind, title, text }),
  };

  tools = {
    select: createSelectTool(env),
    road: createRoadTool(env),
    zone: createZoneTool(env),
    bulldoze: createBulldozeTool(env),
    service: createServiceTool(env),
  };

  uiPresent = () => !!(ctxRef && ctxRef.modules && ctxRef.modules.ui);

  // --- tool routing -------------------------------------------------------
  offs.push(events.on('tool:select', (tool, options) => applyTool(tool, options || {})));
  offs.push(events.on('tool:changed', (tool, options) => { if (!applying) applyTool(tool, options || {}, true); }));
  offs.push(events.on('entity:selected', (sel) => {
    if (applying) return;
    if (sel == null) world.selection = null;
    else if (sel.kind && sel.id != null) world.selection = { kind: sel.kind, id: sel.id, entity: sel.entity || (world.selection && world.selection.entity) || null };
  }));

  // --- keyboard -----------------------------------------------------------
  escHandler = (e) => {
    if (e.key !== 'Escape' || e.repeat) return;
    // Only swallow Escape while a placement is actually in progress; deselect / panel closing
    // stays with the HUD so one Escape never does two things.
    const t = active && active.name !== 'select' ? active : null;
    if (t && typeof t.cancel === 'function' && t.cancel()) {
      e.stopPropagation();
      e.preventDefault();
      env.audio('click');
    }
  };
  window.addEventListener('keydown', escHandler, true);

  keyHandler = (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    // The HUD owns 1-5 and Esc whenever it is loaded (it initialises after this module, so the
    // check has to happen per keystroke, not at init).
    if (uiPresent()) return;
    const code = e.code || e.key;
    if (code === 'Escape') { applyTool('select', {}); e.preventDefault(); return; }
    const m = /^Digit([1-4])$/.exec(code);
    if (m && !e.shiftKey) {
      const spec = KEY_TOOLS[m[1]];
      if (spec) { applyTool(spec.tool, spec.options); e.preventDefault(); }
    }
  };
  window.addEventListener('keydown', keyHandler);

  world.tools = { api };   // reachable as world.tools.api, like world.simulation.api

  // adopt whatever tool the world already carries (URL / earlier module)
  applyTool(world.tool && world.tool.active ? world.tool.active : 'select', (world.tool && world.tool.options) || {}, true);
  if (ctx.config && ctx.config.debug) console.info('[tools] ready');
}

function isTyping(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }

function toolFor(name) {
  if (tools[name]) return tools[name];
  return tools.select; // info views and unknown tools still pick entities
}

function sameOpts(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.view === b.view && a.curve === b.curve;
}

function applyTool(name, options = {}, silent = false) {
  const world = ctxRef.world;
  // Compare against what THIS module last applied — `__game.setTool()` writes world.tool before it
  // emits, so world.tool is not a reliable "did anything change" signal.
  const same = currentName === name && sameOpts(currentOptions, options);
  world.tool.active = name;
  world.tool.options = options;
  currentName = name;
  currentOptions = options;
  if (same) { updateCursor(); return; }
  const next = toolFor(name);
  if (active && active !== next) active.exit();
  active = next;
  active.enter(options);
  if (!silent) {
    applying = true;
    ctxRef.events.emit('tool:changed', name, options);
    applying = false;
  }
  updateCursor();
}

function updateCursor() {
  if (!ctxRef) return;
  const el = ctxRef.renderer && ctxRef.renderer.domElement;
  if (!el) return;
  const style = active && active.cursorStyle ? active.cursorStyle() : 'default';
  if (el.style.cursor !== style) el.style.cursor = style;
}

export function update(dt, elapsed) {
  if (!env || !ctxRef) return;
  const { input, world, camera, engine } = ctxRef;
  elapsedTime = elapsed;
  env.time = elapsed;
  env.dt = dt;
  env.overUI = !!input.pointerOverUI;
  const ended = input.endedDrag;
  env.click = !!(ended && ended.button === 0 && !ended.active && !input.alt && !env.overUI) || forceClick === 1;
  env.rightClick = !!(ended && ended.button === 2 && !ended.active && !env.overUI) || forceClick === 2;
  forceClick = 0;
  const g = env.ground();
  if (g) { lastGround = g; env.lastGround = g; }

  // --- live tool
  if (active) {
    try { active.update(dt); } catch (err) { reportOnce('update:' + active.name, err); }
  }

  // --- draw everything (one vector + one fill draw call for the whole overlay)
  vec.begin(); fill.begin();
  chipIdx = 0;
  const drawn = new Set();
  const list = [];
  if (active && (!env.overUI || staged.has(active))) list.push(active);
  for (const t of staged) if (!list.includes(t)) list.push(t);
  const per = {};
  for (const t of list) {
    if (drawn.has(t)) continue;
    drawn.add(t);
    const v0 = vec.vi, f0 = fill.vi;
    try { t.draw(); } catch (err) { reportOnce('draw:' + t.name, err); }
    per[t.name] = [vec.vi - v0, fill.vi - f0];
  }
  stats.perTool = per;
  for (let i = chipIdx; i < chips.length; i++) chips[i].hide();
  const size = new THREE.Vector2();
  engine.renderer.getSize(size);
  vec.end(camera, size.y);
  fill.end(elapsed, (world.env && world.env.nightFactor) || 0);
  for (const c of chips) c.update(camera);
  declutterChips(camera);
  stats.draws = (vec.mesh.visible ? 1 : 0) + (fill.mesh.visible ? 1 : 0) + chipIdx;
  updateCursor();
  void world;
}

const _cv = new THREE.Vector3();
/** Constant-size labels crowd at distance: keep the nearest, hide the ones it covers. */
function declutterChips(camera) {
  const vis = [];
  for (const c of chips) {
    if (!c.sprite.visible) continue;
    _cv.copy(c.sprite.position).project(camera);
    if (_cv.z > 1) { c.sprite.visible = false; continue; }
    const h = c.sprite.scale.y * 0.5;                 // NDC half-height ≈ scale/2
    vis.push({ c, x: _cv.x, y: _cv.y, w: h * c._aspect, h, d: c.sprite.position.distanceToSquared(camera.position) });
  }
  vis.sort((a, b) => a.d - b.d);
  for (let i = 0; i < vis.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!vis[j].c.sprite.visible) continue;
      const a = vis[i], b = vis[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) * 0.55 && Math.abs(a.y - b.y + (a.h - b.h) * 0.5) < (a.h + b.h) * 0.62) { a.c.sprite.visible = false; break; }
    }
  }
}

function chipAt(i) {
  while (chips.length <= i) {
    const c = new Chip(ctxRef.engine, { heightFraction: chips.length % 2 === 0 ? 0.055 : 0.04 });
    chips.push(c);
    group.add(c.sprite);
  }
  chips[i].hide();
  return chips[i];
}

const reported = new Set();
function reportOnce(key, err) {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn('[tools] ' + key, err && err.message ? err.message : err);
}

// ---------------------------------------------------------------------------
// Debug / showcase hooks

/** Force a staged preview for a tool so a screenshot can show it. `debugPreview(null)` clears all. */
export function debugPreview(kind, spec) {
  if (!tools) return null;
  if (kind == null || kind === 'clear' || kind === false) {
    for (const t of Object.values(tools)) if (t.stage) t.stage(null);
    staged.clear();
    return null;
  }
  const tool = tools[kind];
  if (!tool || !tool.stage) { console.warn('[tools] debugPreview: unknown preview "' + kind + '"'); return null; }
  let s = spec;
  if (kind === 'road' && Array.isArray(spec) && !(spec[0] && spec[0].points)) s = { points: spec };
  if (kind === 'zone' && Array.isArray(spec)) s = { rect: { x0: spec[0], z0: spec[1], x1: spec[2], z1: spec[3] } };
  if ((kind === 'select' || kind === 'bulldoze') && s && (s.kind || s.x != null)) s = resolveEntitySpec(kind, s);
  if (s === null || s === false) { tool.stage(null); staged.delete(tool); return null; }
  tool.stage(s);
  staged.add(tool);
  return s;
}

function resolveEntitySpec(kind, s) {
  const world = ctxRef.world;
  let hit = null;
  if (s.entity) hit = { kind: s.kind, id: s.entity.id, entity: s.entity };
  else if (s.kind && s.id != null) {
    const e = lookup(world, s.kind, s.id);
    if (e) hit = { kind: s.kind, id: s.id, entity: e };
  } else if (s.x != null && s.z != null) {
    const b = world.buildings && world.buildings.api && world.buildings.api.at(s.x, s.z);
    if (b) hit = { kind: 'building', id: b.id, entity: b };
    else {
      const r = world.roads && world.roads.api && world.roads.api.nearest(s.x, s.z, 30);
      if (r && r.segment) hit = { kind: 'road', id: r.segment.id, entity: r.segment };
    }
  }
  if (hit) hit.point = { x: hit.entity.x || 0, y: 0, z: hit.entity.z || 0 };
  if (kind === 'select') {
    if (hit && s.emit !== false) {
      applying = true;
      world.selection = { kind: hit.kind, id: hit.id, entity: hit.entity };
      ctxRef.events.emit('entity:selected', world.selection);
      applying = false;
    }
    return { selection: hit, hover: s.hover ? resolveEntitySpec('bulldoze', s.hover).hover : null };
  }
  return { hover: hit };
}

function lookup(world, kind, id) {
  if (kind === 'building') return (world.buildings.api && world.buildings.api.get && world.buildings.api.get(id)) || world.buildings.list.find((b) => b.id === id) || null;
  if (kind === 'road') return world.roads.segments.get(id) || null;
  if (kind === 'lot') return (world.zones.api && world.zones.api.lotById && world.zones.api.lotById(id)) || null;
  if (kind === 'service') return (world.services.api && world.services.api.get && world.services.api.get(id)) || null;
  return null;
}

/** Synthetic click at the current cursor — lets a screenshot drive the live tool end to end. */
export function debugClick(button = 0) { forceClick = button === 2 ? 2 : 1; return true; }

/** Pin the tool cursor to a world position (null → follow the real pointer again). */
export function debugPointer(x, z) {
  forcedGround = x == null ? null : { x, z };
  return forcedGround;
}

export const api = {
  get active() { return ctxRef ? ctxRef.world.tool.active : null; },
  get options() { return ctxRef ? ctxRef.world.tool.options : null; },
  select: (tool, options = {}) => applyTool(tool, options),
  cancel: () => (active && active.cancel ? active.cancel() : false),
  pick: (ndc) => (picker ? picker.pick(ndc || ctxRef.input.ndc) : null),
  selectEntity: (kind, id) => debugPreview('select', { kind, id }),
  debugPreview,
  debugPointer,
  click: () => debugClick(0),
  rightClick: () => debugClick(2),
  stats: () => ({ ...stats, staged: [...staged].map((t) => t.name), chips: chips.length, tool: ctxRef && ctxRef.world.tool.active, verts: vec ? vec.vi : 0, fills: fill ? fill.vi : 0, hover: (tools && tools.bulldoze.state.staged && tools.bulldoze.state.staged.hover) ? tools.bulldoze.state.staged.hover.kind : null }),
  PAL,
};

export function dispose() {
  for (const off of offs) { try { off(); } catch (_) { /* ignore */ } }
  offs = [];
  if (keyHandler) window.removeEventListener('keydown', keyHandler);
  if (escHandler) window.removeEventListener('keydown', escHandler, true);
  if (ctxRef && ctxRef.renderer && ctxRef.renderer.domElement) ctxRef.renderer.domElement.style.cursor = '';
  for (const c of chips) c.dispose();
  chips = [];
  if (vec) vec.dispose();
  if (fill) fill.dispose();
  if (group && group.parent) group.parent.remove(group);
  if (ctxRef && ctxRef.world) ctxRef.world.tools = null;
  group = null; vec = null; fill = null; tools = null; env = null; active = null; picker = null;
  staged.clear();
  currentName = null; currentOptions = null;
  ctxRef = null;
  void elapsedTime;
}
