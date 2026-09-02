/**
 * Illustrative 88×50 SVG thumbnails for the build catalogue (Cities: Skylines II style asset previews).
 *
 * Every tray card, selection-panel header and info-view legend shows one of these little dioramas instead of a
 * glyph: roads are drawn in perspective with their real lane layout, buildings as oblique blocks with lit
 * windows and roofs, service buildings with their signature silhouette (cooling tower, water tank, hose tower…),
 * info views as a miniature map overlay. Colours are fixed (they are pictures, not tinted glyphs); a few
 * shared gradients live in one hidden <defs> block that `ensureThumbDefs(root)` injects once.
 */
const W = 88, H = 50, HZ = 23; // horizon
const wrap = (inner, cls = '') => `<svg viewBox="0 0 ${W} ${H}" class="fc-thumb-svg ${cls}" aria-hidden="true">${inner}</svg>`;

// ---------- colour helpers ----------
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const rgb = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const [r1, g1, b1] = hex(a), [r2, g2, b2] = hex(b); return rgb(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t); };
const lt = (c, t = 0.3) => mix(c, '#ffffff', t);
const dk = (c, t = 0.3) => mix(c, '#000000', t);

// ---------- primitives ----------
const rect = (x, y, w, h, f, o = 1, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${f}" fill-opacity="${o}"/>`;
const path = (d, f, o = 1) => `<path d="${d}" fill="${f}" fill-opacity="${o}"/>`;
const line = (d, s, w = 1, o = 1, dash = '') => `<path d="${d}" fill="none" stroke="${s}" stroke-width="${w}" stroke-opacity="${o}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const circle = (cx, cy, r, f, o = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}" fill-opacity="${o}"/>`;
const ellipse = (cx, cy, rx, ry, f, o = 1) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}" fill-opacity="${o}"/>`;
const shadow = (cx, cy, rx, ry = rx * 0.32) => ellipse(cx, cy, rx, ry, '#000', 0.28);

/** Sky + ground backdrop. */
const SKY = `<rect width="${W}" height="${H}" fill="url(#fct-sky)"/>`;
const GROUND = rect(0, HZ, W, H - HZ, 'url(#fct-grass)') + rect(0, HZ, W, 3, '#fff', 0.12);
const backdrop = (ground = GROUND) => SKY + ground;
const cloud = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})" fill="#fff" fill-opacity=".75"><circle r="3.2"/><circle cx="3.6" cy=".8" r="2.4"/><circle cx="-3.4" cy="1" r="2.2"/><rect x="-5" y=".8" width="10" height="2.4" rx="1.2"/></g>`;

/** Oblique block: front face + lighter top + darker side. (x,y) = bottom-left of the front face. */
function block(x, y, w, h, d, c) {
  const dx = d * 0.72, dy = d * 0.42;
  return path(`M${x} ${y - h}h${w}v${h}h${-w}z`, c) +
    path(`M${x} ${y - h}l${dx} ${-dy}h${w}l${-dx} ${dy}z`, lt(c, 0.38)) +
    path(`M${x + w} ${y - h}l${dx} ${-dy}v${h}l${-dx} ${dy}z`, dk(c, 0.32));
}
/** Window grid on a front face. */
function windows(x, y, w, h, cols, rows, { c = '#0f1a26', lit = 0, litC = '#ffd66b', pad = 1.4, gx = 1.1, gy = 1.3 } = {}) {
  const cw = (w - pad * 2 - gx * (cols - 1)) / cols, ch = (h - pad * 2 - gy * (rows - 1)) / rows;
  let s = '', i = 0;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++, i++) {
    const on = lit && ((i * 7 + r * 3) % 10) < lit * 10;
    s += rect(x + pad + k * (cw + gx), y - h + pad + r * (ch + gy), cw, ch, on ? litC : c, on ? 0.95 : 0.78, 0.2);
  }
  return s;
}
/** Pitched-roof house. */
function house(x, y, w, h, d, wall, roof) {
  const dx = d * 0.72, dy = d * 0.42, rh = h * 0.55;
  return block(x, y, w, h, d, wall) +
    path(`M${x - 1} ${y - h}L${x + w / 2} ${y - h - rh}L${x + w + 1} ${y - h}z`, dk(roof, 0.12)) + // gable
    path(`M${x + w / 2} ${y - h - rh}l${dx} ${-dy}L${x + w + 1 + dx} ${y - h - dy}L${x + w + 1} ${y - h}z`, roof) + // roof slope
    rect(x + w * 0.42, y - h * 0.62, w * 0.18, h * 0.62, dk(wall, 0.55), 1, 0.3) + // door
    windows(x, y, w * 0.36, h, 1, 1, { pad: 1.2 }) + windows(x + w * 0.62, y, w * 0.36, h, 1, 1, { pad: 1.2 });
}
const tree = (x, y, s = 1, c = '#3f8f3a') => `<g transform="translate(${x} ${y}) scale(${s})">` + shadow(0, 0.4, 2.6, 0.9) + rect(-0.6, -3.2, 1.2, 3.4, '#6b4a33') + circle(0, -5.2, 3.1, dk(c, 0.15)) + circle(-0.9, -6, 2.3, lt(c, 0.12)) + '</g>';
const lamp = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">` + rect(-0.35, -9, 0.7, 9, '#7d8791') + rect(-1.6, -9.8, 3.2, 1.3, '#dfe6ec', 1, 0.5) + circle(0, -9.2, 1.7, '#ffe9a8', 0.35) + '</g>';
const smoke = (x, y) => circle(x, y, 2.2, '#d9dde2', 0.55) + circle(x + 2.4, y - 2.2, 2.7, '#e6e9ee', 0.5) + circle(x + 5.6, y - 4.6, 3.1, '#eef0f3', 0.42);

// ---------- roads in perspective ----------
const X = (t, u, x0 = 2, w0 = 84, x1 = 35, w1 = 18) => (x0 + w0 * u) * (1 - t) + (x1 + w1 * u) * t; // t: 0 bottom → 1 top
const Y0 = H, Y1 = HZ + 1;
const strip = (u0, u1, f, o = 1) => path(`M${X(0, u0)} ${Y0}L${X(0, u1)} ${Y0}L${X(1, u1)} ${Y1}L${X(1, u0)} ${Y1}z`, f, o);
const mark = (u, dash = '4 3.2', w = 1.1, c = '#f4f7fa', o = 0.95) => line(`M${X(0, u)} ${Y0}L${X(1, u)} ${Y1}`, c, w, o, dash);
const ASPHALT = '#5b6570', SIDEWALK = '#a9b0b8', CURB = '#cfd5db';
const roadside = (side, items) => items.map(([t, s]) => { const u = side < 0 ? -0.06 : 1.06; return [X(t, u), Y0 - (Y0 - Y1) * t, s]; });
const trees = (side, list, c) => roadside(side, list).map(([x, y, s]) => tree(x, y, s, c)).join('');
const lamps = (side, list) => roadside(side, list).map(([x, y, s]) => lamp(x, y, s)).join('');

function roadScene({ sidewalk = 0.11, lanesL = 1, lanesR = 1, median = 0, barrier = false, shoulder = 0, verge = true, extra = '' }) {
  let s = backdrop();
  if (verge) s += strip(-0.2, 1.2, '#4d8c3f', 0.9);
  if (sidewalk) s += strip(0, 1, SIDEWALK) + strip(sidewalk - 0.012, sidewalk, CURB) + strip(1 - sidewalk, 1 - sidewalk + 0.012, CURB);
  const a0 = sidewalk, a1 = 1 - sidewalk;
  s += strip(a0, a1, ASPHALT);
  // lane marks
  const roadW = a1 - a0, medW = median * roadW, half = (roadW - medW) / 2;
  const cL = a0 + half, cR = a1 - half;
  if (shoulder) { s += strip(a0, a0 + shoulder, lt(ASPHALT, 0.07)) + strip(a1 - shoulder, a1, lt(ASPHALT, 0.07)) + mark(a0 + shoulder, '', 0.9) + mark(a1 - shoulder, '', 0.9); }
  for (let i = 1; i < lanesL; i++) s += mark(a0 + shoulder + ((cL - a0 - shoulder) * i) / lanesL);
  for (let i = 1; i < lanesR; i++) s += mark(cR + ((a1 - shoulder - cR) * i) / lanesR);
  if (median > 0) {
    if (barrier) s += strip(cL, cR, '#c9d0d6') + strip(cL + medW * 0.35, cR - medW * 0.35, '#8e979f');
    else {
      s += strip(cL, cR, '#4d8c3f') + strip(cL, cL + 0.008, CURB) + strip(cR - 0.008, cR, CURB);
      s += [0.08, 0.3, 0.52, 0.72].map((t) => tree(X(t, 0.5), Y0 - (Y0 - Y1) * t, 0.9 - t * 0.7, '#2e7d32')).join('');
    }
  } else if (lanesL + lanesR === 2) s += mark(cL, '5 3.6', 1.2);
  return s + extra;
}

// ---------- thumbnails ----------
export const THUMBS = {
  // ----- roads -----
  local: () => roadScene({ lanesL: 1, lanesR: 1, extra: lamps(1, [[0.12, 1], [0.5, 0.6]]) + trees(-1, [[0.06, 1.1], [0.36, 0.75], [0.62, 0.5]]) + cloud(16, 9, 1) + cloud(66, 6, 0.8) }),
  avenue: () => roadScene({ sidewalk: 0.08, lanesL: 2, lanesR: 2, median: 0.09, extra: lamps(-1, [[0.16, 0.95], [0.55, 0.55]]) + trees(1, [[0.08, 1.05], [0.4, 0.7]]) + cloud(70, 7, 0.9) }),
  highway: () => roadScene({ sidewalk: 0, lanesL: 3, lanesR: 3, median: 0.06, barrier: true, shoulder: 0.05, extra: trees(-1, [[0.1, 1], [0.45, 0.6]]) + trees(1, [[0.22, 0.85], [0.6, 0.45]]) + cloud(20, 8, 0.85) +
    // overhead sign gantry
    rect(29, 7, 0.9, 16, '#8b949c') + rect(58, 7, 0.9, 16, '#8b949c') + rect(29, 6.5, 30, 1, '#8b949c') + rect(35, 4, 18, 6, '#2e7d32', 1, 0.6) + rect(37, 5.6, 8, 1, '#fff', 0.85) + rect(37, 7.6, 12, 1, '#fff', 0.85) }),
  path: () => backdrop() + strip(-0.2, 1.2, '#5a9e4a', 0.9) + strip(0.36, 0.64, '#d9c9a8') + strip(0.36, 0.372, '#f1e7d2') + strip(0.628, 0.64, '#f1e7d2') +
    [0.1, 0.26, 0.42, 0.58, 0.74, 0.9].map((t) => line(`M${X(t, 0.37)} ${Y0 - (Y0 - Y1) * t}L${X(t, 0.63)} ${Y0 - (Y0 - Y1) * t}`, '#b9a583', 0.6, 0.7)).join('') + mark(0.5, '2.5 2.5', 0.6, '#b9a583', 0.7) +
    trees(-1, [[0.05, 1.2], [0.3, 0.9], [0.55, 0.6]], '#43a047') + trees(1, [[0.16, 1.05], [0.42, 0.75], [0.66, 0.5]], '#66a84a') +
    // bench + flowers
    rect(58, 39, 6, 1.2, '#8d6e63', 1, 0.3) + rect(58.5, 40.2, 0.8, 2.2, '#5d4037') + rect(62.7, 40.2, 0.8, 2.2, '#5d4037') +
    circle(14, 44, 0.9, '#ff8a80') + circle(17, 46.5, 0.9, '#ffd54f') + circle(11, 47, 0.9, '#ce93d8') + circle(70, 47, 0.9, '#ff8a80') + cloud(72, 8, 0.8),

  // ----- zones -----
  'res-low': () => backdrop() + rect(0, 42, W, 8, '#4d8c3f', 0.7) + shadow(24, 44, 14, 3) + shadow(62, 45, 14, 3) +
    house(12, 43, 20, 11, 6, '#e8dcc8', '#b0533f') + house(52, 45, 18, 10, 6, '#d7c7a6', '#5d6d7e') + tree(43, 45, 1.1) + tree(80, 47, 1.25, '#4f9a3f') + tree(6, 47, 0.9, '#55a044') +
    rect(0, 47.5, W, 2.5, '#a9b0b8') + rect(0, 47.4, W, 0.4, '#e3e8ec', 0.8) + cloud(20, 8, 0.9) + cloud(66, 6, 0.75),
  'res-high': () => backdrop() + shadow(26, 47, 18, 3) + shadow(60, 47, 16, 3) +
    block(48, 47, 16, 30, 6, '#c8a882') + windows(48, 47, 16, 30, 3, 7, { lit: 0.35 }) +
    block(12, 47, 20, 24, 6, '#e0e4e8') + windows(12, 47, 20, 24, 4, 6, { lit: 0.3, litC: '#ffe0a3' }) + rect(12, 24, 20, 1.2, '#b0533f') +
    block(70, 47, 12, 18, 5, '#9fb3c8') + windows(70, 47, 12, 18, 2, 4, { lit: 0.4 }) + tree(40, 48, 1, '#3f8f3a') + tree(5, 48.5, 0.9) +
    rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(72, 7, 0.8),
  'com-low': () => backdrop() + rect(0, 43, W, 7, '#4d8c3f', 0.6) + shadow(44, 46, 30, 3.2) +
    block(16, 46, 44, 17, 8, '#f0e6d2') + rect(16, 29, 44, 3, '#b0533f') + // parapet
    rect(19, 33.5, 12, 8.5, '#1a2a3a', 0.85, 0.3) + rect(33, 33.5, 10, 8.5, '#1a2a3a', 0.85, 0.3) + rect(45, 33.5, 12, 8.5, '#1a2a3a', 0.85, 0.3) + rect(19.6, 34.2, 10.8, 3, '#8fd0ff', 0.35) + rect(45.6, 34.2, 10.8, 3, '#8fd0ff', 0.35) +
    // striped awning
    path('M15 34h46l1.5 4H13.5z', '#e53935') + [0, 1, 2, 3, 4, 5].map((i) => path(`M${15 + i * 8} 34h4l1.2 4h-4z`, '#fff', 0.85)).join('') +
    rect(24, 30, 28, 3, '#ffd66b', 1, 0.6) + rect(27, 31, 22, 1, '#7a4a10', 0.7) + tree(8, 47, 1.05) + tree(78, 47.5, 1.05, '#4f9a3f') + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(70, 7, 0.85),
  'com-high': () => backdrop() + shadow(42, 47, 26, 3.5) +
    block(30, 47, 22, 40, 8, '#7fb3d9') + windows(30, 47, 22, 40, 3, 10, { c: '#1d3d5a', lit: 0.45, litC: '#dff3ff', gx: 0.6, gy: 0.8, pad: 1 }) +
    block(10, 47, 18, 22, 7, '#e6e3dc') + windows(10, 47, 18, 22, 3, 5, { lit: 0.3 }) + rect(10, 25, 18, 2.5, '#ff7043') + rect(12, 26, 6, 0.9, '#fff', 0.9) +
    block(56, 47, 22, 16, 7, '#d8b39a') + windows(56, 47, 22, 16, 4, 3, { lit: 0.4 }) + rect(58, 33.5, 18, 2.2, '#2b6fdc', 1, 0.5) + rect(60, 34.2, 8, 0.8, '#fff', 0.9) +
    tree(4, 48, 0.9) + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(74, 6, 0.8),
  ind: () => backdrop() + rect(0, 42, W, 8, '#8a7a62', 0.55) + shadow(44, 47, 34, 3.5) +
    // sawtooth roof hall
    block(14, 46, 50, 16, 8, '#a9b0b8') + [0, 1, 2, 3].map((i) => path(`M${14 + i * 12.5} 30l6 -5v5z`, '#7f8a94') + rect(14 + i * 12.5 + 6, 25.6, 6.5, 4.4, '#8fd0ff', 0.55)).join('') +
    rect(17, 36, 44, 6, '#3a4653', 0.65, 0.4) + rect(20, 37.5, 10, 4.5, '#6b7885', 0.9, 0.3) + rect(48, 37.5, 10, 4.5, '#6b7885', 0.9, 0.3) +
    rect(68, 18, 5, 28, '#b5473b') + rect(68, 18, 5, 2, '#fff', 0.85) + rect(68, 22, 5, 2, '#fff', 0.85) + smoke(70, 15) +
    rect(6, 40, 6, 6, '#d9a64a', 1, 0.5) + rect(4.5, 39, 9, 1.4, '#b5843a', 1, 0.5) + tree(82, 48, 0.9, '#5f8f3a') + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(18, 8, 0.85),
  office: () => backdrop() + shadow(40, 47, 26, 3.5) +
    block(24, 47, 26, 38, 9, '#5f9ed6') + rect(24, 9, 26, 38, 'url(#fct-glass)') + [0, 1, 2, 3, 4, 5, 6, 7].map((r) => rect(24, 11 + r * 4.5, 26, 0.8, '#1d3d5a', 0.55)).join('') + [1, 2].map((k) => rect(24 + k * 8.7, 9, 0.7, 38, '#1d3d5a', 0.45)).join('') +
    rect(24, 8, 26, 1.4, '#e6eef5') + rect(36, 3, 1, 5, '#c9d3dd') +
    block(6, 47, 16, 20, 6, '#d0d6dc') + windows(6, 47, 16, 20, 3, 5, { c: '#25404f', lit: 0.25, litC: '#dff3ff' }) +
    block(58, 47, 22, 14, 7, '#b8c4cf') + windows(58, 47, 22, 14, 4, 3, { c: '#25404f', lit: 0.3, litC: '#dff3ff' }) + tree(84, 48, 0.9) + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(16, 8, 0.85) + cloud(74, 5, 0.7),

  // ----- services -----
  power: () => backdrop() + rect(0, 42, W, 8, '#8a7a62', 0.55) + shadow(30, 47, 22, 3.5) +
    path('M18 47L22 20h14L40 47z', '#c9d0d6') + path('M18 47L22 20h6L26 47z', '#e6eaee', 0.7) + path('M22 20a7 2.2 0 0 0 14 0a7 2.2 0 0 0-14 0z', '#5f6a75') + smoke(28, 17) +
    block(44, 47, 30, 18, 8, '#6b7885') + windows(44, 47, 30, 18, 5, 2, { c: '#22303d', lit: 0.5, litC: '#ffe082' }) + rect(46, 31, 26, 1.6, '#f4b942') +
    path('M60 30 55 38h3.5l-1.5 6 5.5-8h-3.6z', '#f4b942') +
    rect(78, 20, 4, 27, '#8f959c') + rect(78, 20, 4, 1.6, '#e53935') + rect(78, 24, 4, 1.6, '#fff') + rect(78, 28, 4, 1.6, '#e53935') + smoke(79, 16) +
    // power lines
    rect(6, 28, 1, 19, '#5f6a75') + path('M4 28h5l-2.5-4z', '#5f6a75') + line('M7 30C15 34 20 34 44 36', '#3a4653', 0.6, 0.8) + cloud(60, 6, 0.75),
  water: () => backdrop() + shadow(44, 47, 16, 3) +
    [[32, 20], [56, 20], [36, 32], [52, 32]].map(([x, y]) => rect(x - 0.7, y, 1.4, 47 - y, '#8f959c')).join('') + line('M32 34L56 24M56 34L32 24', '#8f959c', 0.9, 0.8) +
    rect(29, 12, 30, 12, '#4fa3d9', 1, 3) + rect(29, 12, 30, 12, 'url(#fct-tank)', 1, 3) + ellipse(44, 12, 15, 3.4, '#8fd0ff') + ellipse(44, 12, 15, 3.4, '#fff', 0.3) + rect(31, 15.5, 26, 1.2, '#2b6fa8', 0.55) + rect(31, 20.5, 26, 1.2, '#2b6fa8', 0.55) +
    path('M44 5c-2.4 3-3 4.2-3 5.4a3 3 0 0 0 6 0c0-1.2-.6-2.4-3-5.4z', '#fff', 0.95) +
    block(8, 47, 14, 8, 5, '#d0d6dc') + rect(10, 41.5, 10, 4, '#25404f', 0.75, 0.3) + tree(78, 48, 1.15) + tree(70, 46, 0.7, '#4f9a3f') + cloud(16, 8, 0.85) + cloud(72, 6, 0.75),
  sewage: () => backdrop() + rect(0, 42, W, 8, '#8a7a62', 0.5) + shadow(26, 48, 16, 3) + shadow(62, 48, 16, 3) +
    rect(12, 34, 28, 13, '#a9b0b8') + ellipse(26, 34, 14, 4.2, '#6b8fa8') + ellipse(26, 34, 11.5, 3.2, '#3d6f8f') + line('M17 34c3 1.5 6-1.5 9 0s6-1.5 9 0', '#8fd0ff', 0.9, 0.8) +
    rect(48, 36, 28, 11, '#a9b0b8') + ellipse(62, 36, 14, 4.2, '#6b8fa8') + ellipse(62, 36, 11.5, 3.2, '#3d6f8f') + line('M53 36c3 1.5 6-1.5 9 0s6-1.5 9 0', '#8fd0ff', 0.9, 0.8) +
    rect(40, 40, 8, 2.4, '#7d8791', 1, 1.2) + rect(43, 30, 2.2, 17, '#7d8791') + rect(24, 28, 4, 6, '#6b7885') +
    block(2, 47, 9, 8, 4, '#c9d0d6') + rect(3.5, 41, 6, 3.5, '#25404f', 0.75, 0.3) + tree(83, 48, 1.05, '#5f8f3a') + cloud(18, 8, 0.8) + cloud(70, 6, 0.85),
  garbage: () => backdrop() + rect(0, 40, W, 10, '#8a7a62', 0.7) + rect(0, 47.5, W, 2.5, '#6b5d48') +
    path('M8 47C16 30 40 26 58 30S84 40 86 47z', '#7a6449') + path('M14 47C22 34 42 30 58 33S80 42 82 47z', '#8c7454', 0.8) +
    [[22, 41, '#62c6ff'], [30, 37, '#f1b634'], [40, 35, '#e53935'], [50, 36, '#8fd95a'], [58, 38, '#b57cf0'], [66, 41, '#fff'], [36, 42, '#62c6ff'], [46, 43, '#f1b634']].map(([x, y, c]) => rect(x, y, 3, 2, c, 0.8, 0.4)).join('') +
    [6, 18, 30, 42, 54, 66, 78].map((x) => rect(x, 43, 0.8, 5, '#5d5148')).join('') + line('M6 44h72M6 46.5h72', '#5d5148', 0.5, 0.9) +
    // truck
    rect(6, 33.5, 11, 6, '#8fd95a', 1, 0.8) + rect(2.5, 35, 4, 4.5, '#3f8f3a', 1, 0.6) + circle(5, 40.2, 1.5, '#222') + circle(14, 40.2, 1.5, '#222') +
    tree(84, 40, 0.9, '#5f8f3a') + smoke(60, 26) + circle(30, 14, 1.2, '#333', 0.6) + circle(36, 11, 1, '#333', 0.6) + cloud(72, 7, 0.7),
  police: () => backdrop() + rect(0, 43, W, 7, '#4d8c3f', 0.55) + shadow(44, 47, 30, 3.5) +
    block(16, 47, 40, 22, 8, '#dfe5ea') + rect(16, 25, 40, 3, '#2b4c9c') + rect(16, 34, 40, 2.4, '#2b4c9c') + windows(16, 47, 40, 22, 5, 2, { c: '#22303d', lit: 0.4, litC: '#dff3ff', pad: 3, gy: 3 }) +
    rect(32, 39, 8, 8, '#1d2a3a', 0.9, 0.5) + rect(32, 29, 8, 5, '#1d2a3a', 0.9, 0.5) +
    path('M36 26l1.6 2.1 2.6.4-1.9 1.8.5 2.6-2.8-1.4-2.8 1.4.5-2.6-1.9-1.8 2.6-.4z', '#ffd66b') +
    // patrol car
    rect(62, 41, 16, 5, '#f4f7fa', 1, 1.2) + rect(65, 38.5, 9, 3.5, '#1d3d5a', 1, 1) + rect(62, 43, 16, 1.6, '#2b4c9c') + rect(68, 37.3, 3, 1.4, '#e53935', 1, 0.4) + rect(68, 37.3, 1.5, 1.4, '#2b8ae6', 1, 0.4) + circle(65, 46.5, 1.6, '#222') + circle(75, 46.5, 1.6, '#222') +
    rect(8, 27, 1, 20, '#8f959c') + path('M9 27h6l-1.5 1.7L15 30.5H9z', '#2b6fdc') + tree(6, 48, 0.9) + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(18, 7, 0.8) + cloud(72, 6, 0.75),
  fire: () => backdrop() + rect(0, 43, W, 7, '#4d8c3f', 0.55) + shadow(40, 47, 32, 3.5) +
    block(14, 47, 40, 20, 8, '#c0392b') + rect(14, 27, 40, 2.4, '#8e2a1f') + line('M14 32h40M14 37h40M14 42h40', '#8e2a1f', 0.6, 0.6) +
    rect(18, 35, 12, 12, '#3a4653', 1, 2) + rect(18, 35, 12, 12, 'url(#fct-glass)', 0.5, 2) + rect(34, 35, 12, 12, '#3a4653', 1, 2) + rect(34, 35, 12, 12, 'url(#fct-glass)', 0.5, 2) + line('M19 40h10M35 40h10M19 44h10M35 44h10', '#8fd0ff', 0.6, 0.5) +
    rect(20, 29.5, 26, 3.5, '#fff', 0.9, 0.5) + rect(22.5, 30.6, 21, 1.2, '#c0392b') +
    block(58, 47, 12, 32, 6, '#d94b3a') + windows(58, 47, 12, 32, 1, 5, { c: '#22303d', lit: 0.5, litC: '#ffe082', pad: 2.5, gy: 3 }) + rect(58, 14, 12, 1.6, '#8e2a1f') + circle(64, 12.5, 1.8, '#e53935') +
    rect(5, 40, 1.2, 7, '#e53935') + rect(3, 40, 5.2, 2, '#e53935', 1, 0.8) + tree(84, 48, 1, '#4f9a3f') + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(20, 8, 0.85) + cloud(78, 6, 0.7),
  health: () => backdrop() + rect(0, 43, W, 7, '#4d8c3f', 0.55) + shadow(44, 47, 30, 3.5) +
    block(14, 47, 44, 24, 8, '#f2f5f7') + rect(14, 23, 44, 2, '#8fd0ff') + windows(14, 47, 44, 24, 6, 3, { c: '#8fd0ff', lit: 0, pad: 3, gy: 2.6 }) +
    rect(31, 38, 10, 9, '#1d3d5a', 0.9, 0.6) + rect(31, 38, 10, 9, 'url(#fct-glass)', 0.6, 0.6) + path('M30 37h12l2 2H28z', '#cfd5db') +
    // red cross sign
    rect(29, 26.5, 14, 10, '#fff', 1, 1) + rect(34.3, 27.8, 3.4, 7.4, '#e53935', 1, 0.4) + rect(32.3, 29.8, 7.4, 3.4, '#e53935', 1, 0.4) +
    // ambulance
    rect(64, 40, 16, 6.5, '#f4f7fa', 1, 1.2) + rect(64, 42.5, 16, 1.4, '#e53935') + rect(65, 41, 4, 2, '#8fd0ff', 1, 0.3) + rect(73.5, 40.6, 3, 3, '#e53935', 1, 0.3) + rect(74.6, 40.6, 0.8, 3, '#fff') + rect(73.5, 41.7, 3, 0.8, '#fff') + circle(67, 46.6, 1.6, '#222') + circle(77, 46.6, 1.6, '#222') +
    tree(6, 48, 1.05) + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(16, 7, 0.8) + cloud(72, 6, 0.75),
  education: () => backdrop() + rect(0, 42, W, 8, '#4d8c3f', 0.75) + shadow(40, 47, 32, 3.5) +
    block(10, 47, 30, 18, 8, '#c8794f') + windows(10, 47, 30, 18, 4, 2, { c: '#f8e7b0', lit: 0, pad: 2.5, gy: 2.5 }) + rect(10, 29, 30, 1.6, '#e9d9c0') +
    block(40, 47, 14, 26, 8, '#b5654a') + rect(40, 21, 14, 1.6, '#e9d9c0') + path('M39 21l8-6 8 6z', '#5d6d7e') + circle(47, 26.5, 3, '#f8f4e6') + line('M47 26.5v-2M47 26.5l1.6 1', '#333', 0.6) + rect(44.5, 40, 5, 7, '#3a2a20', 0.9, 0.4) +
    block(54, 47, 26, 16, 7, '#c8794f') + windows(54, 47, 26, 16, 4, 2, { c: '#f8e7b0', lit: 0, pad: 2.5, gy: 2.5 }) + rect(54, 31, 26, 1.6, '#e9d9c0') +
    rect(5, 27, 0.9, 20, '#8f959c') + path('M6 27h7l-1.6 2L13 31H6z', '#ffb300') + tree(84, 48, 1.05) +
    // yard: hopscotch + kids
    rect(58, 48, 20, 1.5, '#e9d9c0', 0.6) + circle(64, 46.5, 1, '#ff8a80') + circle(68, 46.8, 1, '#62c6ff') + rect(0, 47.5, W, 2.5, '#a9b0b8') + cloud(20, 7, 0.85) + cloud(70, 6, 0.7),

  // ----- info views (miniature map overlays) — namespaced: 'power' / 'water' also exist as services -----
  'view:traffic': () => mapBase() + mapRoads('#3a4653') + segs([[[4, 40], [44, 40], '#3ddc84'], [[44, 40], [84, 40], '#ff7043'], [[24, 6], [24, 50], '#3ddc84'], [[54, 6], [54, 27], '#ffd54f'], [[54, 27], [54, 50], '#d50000'], [[4, 18], [84, 18], '#ffd54f']]) + dots([[40, 40, '#fff'], [58, 44, '#fff'], [55, 36, '#fff'], [54, 31, '#fff'], [70, 18, '#fff']]),
  'view:landvalue': () => mapBase() + blocks([['#1e3a5f', 0.9], ['#2b8ac6', 0.9], ['#6fe08c', 0.9], ['#ffd66b', 0.95], ['#2b8ac6', 0.9], ['#6fe08c', 0.9], ['#ffd66b', 0.95], ['#ffd66b', 1], ['#1e3a5f', 0.9], ['#2b8ac6', 0.9], ['#6fe08c', 0.9], ['#2b8ac6', 0.9]]) + mapRoads('#0f1620') + circle(64, 30, 4, '#fff', 0.9) + path('M64 26l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z', '#1e3a5f'),
  'view:pollution': () => mapBase() + blocks([['#2ea86f', 0.6], ['#2ea86f', 0.6], ['#c8b560', 0.6], ['#9b6b3f', 0.7], ['#2ea86f', 0.6], ['#c8b560', 0.6], ['#9b6b3f', 0.75], ['#5d2e8c', 0.85], ['#2ea86f', 0.6], ['#c8b560', 0.6], ['#9b6b3f', 0.7], ['#5d2e8c', 0.8]]) + mapRoads('#0f1620') + circle(64, 32, 22, 'url(#fct-haze)') + rect(60, 26, 3, 10, '#2a1a3a') + rect(56, 31, 12, 6, '#3a2a4a') + smoke(61, 24),
  'view:happiness': () => mapBase() + blocks([['#8fd95a', 0.85], ['#2ea86f', 0.85], ['#ffc247', 0.85], ['#8fd95a', 0.85], ['#2ea86f', 0.85], ['#8fd95a', 0.85], ['#ff5252', 0.85], ['#ffc247', 0.85], ['#8fd95a', 0.85], ['#2ea86f', 0.85], ['#8fd95a', 0.85], ['#2ea86f', 0.85]]) + mapRoads('#0f1620') + face(14, 12, '#2ea86f', 1) + face(64, 30, '#ff5252', -1) + face(44, 42, '#ffc247', 0),
  'view:power': () => mapBase('#101623') + blocks([['#c99a2e', 0.5], ['#c99a2e', 0.55], ['#5a4a1c', 0.6], ['#1b1b2f', 0.9], ['#c99a2e', 0.6], ['#ffe082', 0.7], ['#c99a2e', 0.5], ['#1b1b2f', 0.9], ['#c99a2e', 0.5], ['#c99a2e', 0.55], ['#5a4a1c', 0.6], ['#1b1b2f', 0.9]]) + mapRoads('#0f1620') + circle(34, 28, 26, 'url(#fct-glowy)') + `<circle cx="34" cy="28" r="24" fill="none" stroke="#ffe082" stroke-opacity=".6" stroke-width="1" stroke-dasharray="3 2"/>` + circle(34, 28, 5, '#f4b942') + path('M35.4 23.5 31.2 29.6h3l-.8 4 4.6-6h-3z', '#1a1206'),
  'view:water': () => mapBase('#0f1a2a') + blocks([['#2b8ac6', 0.5], ['#8fe0ff', 0.6], ['#2b8ac6', 0.5], ['#1f4d6e', 0.6], ['#8fe0ff', 0.6], ['#8fe0ff', 0.65], ['#2b8ac6', 0.5], ['#1b1b2f', 0.9], ['#2b8ac6', 0.5], ['#2b8ac6', 0.5], ['#1f4d6e', 0.6], ['#1b1b2f', 0.9]]) + mapRoads('#0f1620') + circle(40, 26, 24, 'url(#fct-glowb)') + `<circle cx="40" cy="26" r="22" fill="none" stroke="#8fe0ff" stroke-opacity=".6" stroke-width="1" stroke-dasharray="3 2"/>` + circle(40, 26, 5, '#4fc3f7') + path('M40 22c-1.8 2.4-2.4 3.4-2.4 4.4a2.4 2.4 0 0 0 4.8 0c0-1-.6-2-2.4-4.4z', '#fff'),
  'view:zoning': () => mapBase('#26313d') + blocks([['#8fd95a', 1], ['#8fd95a', 1], ['#62c6ff', 1], ['#2b6fdc', 1], ['#2ea86f', 1], ['#8fd95a', 1], ['#62c6ff', 1], ['#b57cf0', 1], ['#f1b634', 1], ['#f1b634', 1], ['#2ea86f', 1], ['#b57cf0', 1]], true) + mapRoads('#3a4653'),
};

// ---------- info-view map helpers ----------
function mapBase(c = '#17212d') { return rect(0, 0, W, H, c) + rect(0, 0, W, H, 'url(#fct-vignette)'); }
function mapRoads(c) { return line('M4 18H84M4 40H84M24 4V50M54 4V50', c, 3.2) + line('M4 18H84M4 40H84M24 4V50M54 4V50', lt(c, 0.25), 0.5, 0.6, '2 2'); }
function segs(list) { return list.map(([a, b, c]) => line(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, c, 2.2, 0.95)).join(''); }
function dots(list) { return list.map(([x, y, c]) => rect(x - 1.4, y - 0.9, 2.8, 1.8, c, 0.9, 0.5)).join(''); }
function blocks(colors, grid = false) {
  const cells = [[6, 6, 16, 10], [26, 6, 26, 10], [56, 6, 26, 10], [6, 20, 16, 18], [26, 20, 26, 18], [56, 20, 26, 18], [6, 42, 16, 6], [26, 42, 26, 6], [56, 42, 26, 6], [76, 6, 8, 10], [76, 20, 8, 18], [76, 42, 8, 6]];
  return cells.map(([x, y, w, h], i) => {
    const [c, o] = colors[i % colors.length];
    let s = rect(x, y, w, h, c, o, 1.2);
    if (grid) for (let gx = x + 4; gx < x + w; gx += 4) s += line(`M${gx} ${y}V${y + h}`, '#000', 0.4, 0.2);
    if (grid) for (let gy = y + 4; gy < y + h; gy += 4) s += line(`M${x} ${gy}H${x + w}`, '#000', 0.4, 0.2);
    return s;
  }).join('');
}
function face(x, y, c, mood) {
  const mouth = mood > 0 ? `M${x - 2.4} ${y + 1.2}q2.4 2.6 4.8 0` : mood < 0 ? `M${x - 2.4} ${y + 2.6}q2.4 -2.6 4.8 0` : `M${x - 2.2} ${y + 2}h4.4`;
  return circle(x, y, 5, c) + circle(x, y, 5, '#fff', 0.15) + circle(x - 1.8, y - 1.2, 0.8, '#1a1206', 0.8) + circle(x + 1.8, y - 1.2, 0.8, '#1a1206', 0.8) + line(mouth, '#1a1206', 1, 0.85);
}

/** One hidden <defs> block per document — the thumbnails reference these gradients by id. */
let defsInjected = false;
export function ensureThumbDefs(root) {
  if (defsInjected || !root) return;
  defsInjected = true;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '0'); s.setAttribute('height', '0'); s.setAttribute('aria-hidden', 'true');
  s.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  s.innerHTML = `<defs>
    <linearGradient id="fct-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8fd6"/><stop offset=".55" stop-color="#8ec6ee"/><stop offset="1" stop-color="#d9ecf7"/></linearGradient>
    <linearGradient id="fct-grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6aa858"/><stop offset="1" stop-color="#4a8a3c"/></linearGradient>
    <linearGradient id="fct-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dff3ff" stop-opacity=".85"/><stop offset=".45" stop-color="#5f9ed6" stop-opacity=".3"/><stop offset="1" stop-color="#1d3d5a" stop-opacity=".6"/></linearGradient>
    <linearGradient id="fct-tank" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient>
    <radialGradient id="fct-vignette"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
    <radialGradient id="fct-haze"><stop offset="0" stop-color="#b58cff" stop-opacity=".75"/><stop offset="1" stop-color="#5d2e8c" stop-opacity="0"/></radialGradient>
    <radialGradient id="fct-glowy"><stop offset="0" stop-color="#ffe082" stop-opacity=".55"/><stop offset="1" stop-color="#ffe082" stop-opacity="0"/></radialGradient>
    <radialGradient id="fct-glowb"><stop offset="0" stop-color="#8fe0ff" stop-opacity=".5"/><stop offset="1" stop-color="#8fe0ff" stop-opacity="0"/></radialGradient>
  </defs>`;
  root.appendChild(s);
}

/** Thumbnail markup for a catalogue id ('local', 'res-high', 'power', …) or null when none exists. */
export function thumb(id) {
  const fn = THUMBS[id];
  return fn ? wrap(fn(), 'is-' + String(id).replace(':', '-')) : null;
}
export const hasThumb = (id) => !!THUMBS[id];
/** Info-view map thumbnail ('traffic', 'power', …) — namespaced so it never collides with a service id. */
export const viewThumb = (view) => thumb('view:' + view);
