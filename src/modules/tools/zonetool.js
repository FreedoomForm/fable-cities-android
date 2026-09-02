/**
 * Zoning brush — drag a marquee or paint freehand, with a live per-cell preview that only shows
 * the cells the zoning module would really create (queried through zones.api.cellAt, so the
 * preview is oriented to the road exactly like the finished zone).
 *
 *   LMB drag      rectangle fill        Shift + LMB drag   freehand brush
 *   RMB           erase (same modes)    [ / ]              brush size 1…5 cells
 */
import { PAL, lin } from './gfx.js';
import { drawFootprint } from './shapes.js';

const FALLBACK_COLORS = {
  'res-low': '#8fd95a', 'res-high': '#2ea86f', 'com-low': '#62c6ff',
  'com-high': '#2b6fdc', ind: '#f1b634', office: '#b57cf0',
};
const LABELS = {
  'res-low': 'Low density residential', 'res-high': 'High density residential',
  'com-low': 'Low density commercial', 'com-high': 'High density commercial',
  ind: 'Industrial', office: 'Office',
};

export function createZoneTool(env) {
  const { world } = env;
  const colorCache = new Map();
  const S = { type: 'res-low', brush: 2, drag: null, erase: false, staged: null, lastPaint: 0 };

  const api = () => (world.zones && world.zones.api) || null;
  function zoneColor(type) {
    if (!type) return PAL.bad;
    if (colorCache.has(type)) return colorCache.get(type);
    let hex = FALLBACK_COLORS[type] || '#8fd95a';
    const a = api();
    if (a && Array.isArray(a.types)) {
      const rec = a.types.find((t) => t.id === type);
      if (rec && rec.color) hex = rec.color;
    }
    const c = lin(hex);
    colorCache.set(type, c);
    return c;
  }

  /** Cells the zoning grid would actually paint inside an axis-aligned world rect. */
  function cellsInRect(x0, z0, x1, z1) {
    const a = api();
    if (!a || typeof a.cellAt !== 'function') return [];
    if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
    if (z0 > z1) { const t = z0; z0 = z1; z1 = t; }
    const step = world.cellSize * 0.5;
    const nx = Math.min(160, Math.ceil((x1 - x0) / step) + 1);
    const nz = Math.min(160, Math.ceil((z1 - z0) / step) + 1);
    const seen = new Set();
    const out = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = x0 + Math.min(x1 - x0, i * step);
        const z = z0 + Math.min(z1 - z0, j * step);
        const c = a.cellAt(x, z);
        if (!c) continue;
        if (c.x < x0 || c.x > x1 || c.z < z0 || c.z > z1) continue;
        const k = c.cx + ',' + c.cz;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
    return out;
  }

  function brushRect(p) {
    const r = (S.brush * world.cellSize) / 2;
    return { x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r };
  }

  function previewCells() {
    const staged = S.staged;
    if (staged) return staged.cells;
    const g = env.ground();
    if (!g) return [];
    if (S.drag && S.drag.mode === 'rect') {
      const d = S.drag;
      return cellsInRect(d.x0, d.z0, g.x, g.z);
    }
    const r = brushRect(g);
    return cellsInRect(r.x0, r.z0, r.x1, r.z1);
  }

  function paint(cells, type) {
    const a = api();
    if (!a || !cells.length) return 0;
    const n = a.paint(cells.map((c) => ({ cx: c.cx, cz: c.cz })), type);
    if (n) env.audio(type ? 'zone' : 'bulldoze');
    return n;
  }

  // ---------------------------------------------------------------- lifecycle
  function enter(options = {}) {
    if (options.type) S.type = options.type;
    S.drag = null;
    const a = api();
    if (a && typeof a.setOverlayVisible === 'function') a.setOverlayVisible(true);
  }
  function exit() {
    const a = api();
    if (a && typeof a.setOverlayVisible === 'function') a.setOverlayVisible(false);
    S.drag = null;
  }
  function cancel() { if (S.drag) { S.drag = null; return true; } return false; }

  function update() {
    const g = env.ground();
    if (env.pressed('BracketLeft')) S.brush = Math.max(1, S.brush - 1);
    if (env.pressed('BracketRight')) S.brush = Math.min(5, S.brush + 1);
    const input = env.input;
    const drag = input.drag;
    if (!g) { return; }

    // start / continue a drag
    if (drag && !env.overUI && (drag.button === 0 || drag.button === 2)) {
      if (!S.drag) {
        S.drag = { mode: input.shift ? 'paint' : 'rect', x0: g.x, z0: g.z, button: drag.button };
        S.erase = drag.button === 2;
      }
      if (S.drag.mode === 'paint') {
        const r = brushRect(g);
        paint(cellsInRect(r.x0, r.z0, r.x1, r.z1), S.erase ? null : S.type);
      }
    } else if (!S.drag && (env.click || env.rightClick)) {
      // plain click (or a synthetic one from the debug api): stamp the brush once
      const r = brushRect(g);
      paint(cellsInRect(r.x0, r.z0, r.x1, r.z1), env.rightClick ? null : S.type);
    } else if (S.drag) {
      // released
      const d = S.drag;
      const end = env.lastGround || g;
      if (d.mode === 'rect') {
        const cells = cellsInRect(d.x0, d.z0, end.x, end.z);
        if (cells.length) paint(cells, S.erase ? null : S.type);
        else if (env.click || env.rightClick) {
          const r = brushRect(end);
          paint(cellsInRect(r.x0, r.z0, r.x1, r.z1), S.erase ? null : S.type);
        }
      }
      S.drag = null;
    }
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    const { vec, fill, groundY } = env;
    const cells = previewCells();
    const staged = S.staged;
    const erase = staged ? staged.erase : (S.drag ? S.erase : env.input.buttonDown(2));
    const type = staged ? staged.type : S.type;
    const col = erase ? PAL.bad : zoneColor(type);
    for (const c of cells) {
      const q = c.corners;
      const p = [];
      for (let i = 0; i < 4; i++) {
        const x = q[i * 2], z = q[i * 2 + 1];
        p.push({ x, y: groundY(x, z) + 0.03, z });
      }
      fill.quad(p[0], p[1], p[2], p[3], [0, 0, 1, 0, 1, 1, 0, 1], col, [erase ? 0.75 : 0.85, erase ? 4 : 2, 2.2, 0]);
    }
    const g = staged ? staged.at : env.ground();
    if (!g) return;
    // marquee / brush frame
    if (S.drag && S.drag.mode === 'rect' && !staged) {
      const d = S.drag;
      const box = { x: (d.x0 + g.x) / 2, z: (d.z0 + g.z) / 2, w: Math.abs(g.x - d.x0), d: Math.abs(g.z - d.z0), yaw: 0 };
      if (box.w > 1 && box.d > 1) {
        drawFootprint(env, box, erase ? PAL.badHi : PAL.accentHi, { width: 2.2, dash: 0, glow: 1.0, corner: 2, brackets: true });
      }
    } else if (!staged) {
      const r = brushRect(g);
      const box = { x: g.x, z: g.z, w: r.x1 - r.x0, d: r.z1 - r.z0, yaw: 0 };
      drawFootprint(env, box, erase ? PAL.badHi : PAL.accentHi, { width: 1.8, dash: 2.4, glow: 0.7, corner: 1.5, alpha: 0.8 });
    } else if (staged.rect) {
      const r = staged.rect;
      const box = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: Math.abs(r.x1 - r.x0), d: Math.abs(r.z1 - r.z0), yaw: 0 };
      drawFootprint(env, box, erase ? PAL.badHi : PAL.accentHi, { width: 2.2, glow: 1.0, corner: 2, brackets: true });
    }
    const area = cells.length * world.cellSize * world.cellSize;
    const chip = env.nextChip();
    chip.set({
      value: `${cells.length} cell${cells.length === 1 ? '' : 's'}`,
      title: `${(area / 10000).toFixed(2)} ha`,
      sub: erase ? 'Erase zoning' : LABELS[type] || type,
      tone: erase ? 'bad' : 'accent',
    });
    chip.place(g.x, groundY(g.x, g.z) + 6.5, g.z);
    void vec;
  }

  function stage(spec) {
    if (!spec) { S.staged = null; return; }
    S.type = spec.type || S.type;
    const rect = spec.rect || null;
    const cells = rect ? cellsInRect(rect.x0, rect.z0, rect.x1, rect.z1) : [];
    S.staged = {
      cells, rect, type: S.type, erase: !!spec.erase,
      at: spec.at || (rect ? { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 } : null),
    };
  }

  return { name: 'zone', enter, exit, update, draw, cancel, stage, state: S, cursorStyle: () => 'cell' };
}
