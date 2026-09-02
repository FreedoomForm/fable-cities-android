/**
 * Inline SVG icon set for the HUD — Cities: Skylines II style painted pictograms on a 24×24 grid.
 *
 * Every tool / zone / service / info-view glyph is a *filled silhouette*: a light body (currentColor,
 * tinted by CSS), a thin dark outline (paint-order: stroke) so it stays crisp on any plate, dark cut-outs
 * for detail and a white highlight. Roads are drawn as top-down cross-sections with their lane count
 * visible (2 / 4 + median / 6 + barrier + shoulders / winding path). A few icons use fixed accent colours
 * (asphalt, grass, glass, machine yellow) so they read as illustrations rather than glyphs.
 * Small UI glyphs (close, check, chevrons…) stay 2 px strokes.
 */
const INK = '#0b1118';
const ASPHALT = '#5c6875';
const MARK = '#f4f7fa';
const GRASS = '#5cb85c';
const GLASS = '#8fd0ff';
const YELLOW = '#f5c542';
const STEEL = '#c9d3dd';
const WOOD = '#8d6e63';

const I = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
/** stroked (2 px) glyph wrapper for small UI icons */
const S = (inner, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
/** dark outline drawn *under* the fill */
const OUT = `stroke="${INK}" stroke-opacity=".62" stroke-width="1.15" stroke-linejoin="round" paint-order="stroke"`;
const P = (d, fill = 'currentColor', o = 1, extra = '') => `<path d="${d}" fill="${fill}" fill-opacity="${o}" ${OUT} ${extra}/>`;
const R = (x, y, w, h, r = 0, fill = 'currentColor', o = 1, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" fill-opacity="${o}" ${OUT} ${extra}/>`;
const C = (cx, cy, r, fill = 'currentColor', o = 1, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${o}" ${OUT} ${extra}/>`;
/** flat (no outline) helpers for details */
const dark = (d, o = 0.6) => `<path d="${d}" fill="${INK}" fill-opacity="${o}"/>`;
const darkR = (x, y, w, h, r = 0.4, o = 0.6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${INK}" fill-opacity="${o}"/>`;
const darkC = (cx, cy, r, o = 0.6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}" fill-opacity="${o}"/>`;
const lite = (d, o = 0.55) => `<path d="${d}" fill="#fff" fill-opacity="${o}"/>`;
const liteC = (cx, cy, r, o = 0.7) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" fill-opacity="${o}"/>`;
const flatR = (x, y, w, h, r = 0, fill = 'currentColor', o = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" fill-opacity="${o}"/>`;
const flatC = (cx, cy, r, fill = 'currentColor', o = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${o}"/>`;
const L = (d, stroke = INK, w = 1.4, o = 0.7, extra = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="${o}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
/** outlined stroke: dark halo under a coloured stroke */
const OL = (d, stroke, w = 2, extra = '') => L(d, INK, w + 1.6, 0.6, extra) + L(d, stroke, w, 1, extra);
/** lane dashes along a vertical line at x */
const dashes = (x, y0 = 2.5, y1 = 21.5, len = 2.4, gap = 2.2, w = 1.1, color = MARK) =>
  `<path d="M${x} ${y0}V${y1}" stroke="${color}" stroke-width="${w}" stroke-dasharray="${len} ${gap}" stroke-linecap="butt"/>`;

const GEAR = 'M12 2.5l2.2 2.2 3-.5.9 2.9 2.9.9-.5 3 2.2 2.2-2.2 2.2.5 3-2.9.9-.9 2.9-3-.5L12 21.5l-2.2-2.2-3 .5-.9-2.9-2.9-.9.5-3L1.3 12l2.2-2.2-.5-3 2.9-.9.9-2.9 3 .5z';
const FACE = C(12, 12, 9.5) + darkC(8.6, 9.7, 1.55, 0.72) + darkC(15.4, 9.7, 1.55, 0.72);
const CLOUD = 'M7 17.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.4 1.6A3.3 3.3 0 0 0 7 17.5z';
const SUN_RAYS = L('M12 1.8v2.4M12 19.8v2.4M1.8 12h2.4M19.8 12h2.4M4.8 4.8l1.7 1.7M17.5 17.5l1.7 1.7M4.8 19.2l1.7-1.7M17.5 6.5l1.7-1.7', 'currentColor', 2, 1);

export const ICONS = {
  // ---------------------------------------------------------------- brand
  crest: `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="fcg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7ad9ff"/><stop offset="1" stop-color="#3aa7e8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.14)"/><path d="M7 25V15h5v10zm7 0V7h6v18zm8 0V17h4v8z" fill="url(#fcg)"/><path d="M16 4l1.6 2.6L20 7.4l-2 2.1.4 2.9L16 11.2l-2.4 1.2.4-2.9-2-2.1 2.4-.8z" fill="#ffd66b"/></svg>`,
  trophy: I(P('M7 3h10v6a5 5 0 0 1-10 0z') + OL('M7 5.2H3.6c0 3 1.6 4.8 3.7 5.3M17 5.2h3.4c0 3-1.6 4.8-3.7 5.3', 'currentColor', 1.7) + flatR(11, 13.6, 2, 4, 0.4) + P('M7.5 21c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5z') + lite('M8.6 4.3h1.7v4.4c0 .8-.6 1.4-1.7 1.6z', 0.45)),

  // ---------------------------------------------------------------- roads (top-down cross-sections)
  /** category: crossroads */
  crossroads: I(P('M8 1.5h8V8h6.5v8H16v6.5H8V16H1.5V8H8z') + `<path d="M9.6 1.5h4.8v8.1h8.1v4.8h-8.1v8.1H9.6v-8.1H1.5V9.6h8.1z" fill="${ASPHALT}"/>` + dashes(12, 2.6, 7.6) + dashes(12, 16.4, 21.4) + `<path d="M2.6 12H7.6M16.4 12h5" stroke="${MARK}" stroke-width="1.1" stroke-dasharray="2.4 2.2" stroke-linecap="butt"/>` + lite('M9.6 9.6h4.8v4.8H9.6z', 0.08)),
  /** two-lane road: sidewalks + 2 lanes + centre dashes */
  road: I(R(3.5, 1.5, 17, 21, 1.6) + `<rect x="6.3" y="1.5" width="11.4" height="21" fill="${ASPHALT}"/>` + dashes(12) + `<path d="M6.3 1.5v21M17.7 1.5v21" stroke="${INK}" stroke-opacity=".35" stroke-width=".6"/>`),
  /** four-lane avenue with planted median */
  avenue: I(R(1.5, 1.5, 21, 21, 1.6) + `<rect x="3.4" y="1.5" width="17.2" height="21" fill="${ASPHALT}"/>` + `<rect x="10.9" y="1.5" width="2.2" height="21" fill="${GRASS}"/>` + `<path d="M10.9 1.5v21M13.1 1.5v21" stroke="${INK}" stroke-opacity=".4" stroke-width=".6"/>` + flatC(12, 5.5, 0.9, '#2e7d32', 0.9) + flatC(12, 12, 0.9, '#2e7d32', 0.9) + flatC(12, 18.5, 0.9, '#2e7d32', 0.9) + dashes(7.15) + dashes(16.85)),
  /** motorway: 2×3 lanes, dark barrier, hard shoulders, no sidewalks */
  highway: I(R(1.5, 1.5, 21, 21, 1.6, ASPHALT) + `<rect x="11.3" y="1.5" width="1.4" height="21" fill="${INK}" fill-opacity=".8"/>` + `<path d="M2.7 1.5v21M21.3 1.5v21" stroke="${MARK}" stroke-width=".9"/>` + dashes(5.6, 2.5, 21.5, 2, 1.8, 0.9) + dashes(8.5, 2.5, 21.5, 2, 1.8, 0.9) + dashes(15.5, 2.5, 21.5, 2, 1.8, 0.9) + dashes(18.4, 2.5, 21.5, 2, 1.8, 0.9)),
  /** pedestrian path: winding paving with trees */
  path: I(OL('M6.5 22C6.5 15.5 17.5 15 17.5 9.5S12.5 4.5 12.5 2', 'currentColor', 3.6) + `<path d="M6.5 22C6.5 15.5 17.5 15 17.5 9.5S12.5 4.5 12.5 2" fill="none" stroke="${INK}" stroke-opacity=".38" stroke-width=".9" stroke-dasharray="1.6 1.8"/>` + R(17.3, 15.6, 2, 4.5, 0.5, WOOD) + C(18.3, 14.2, 3.4, GRASS) + R(5.2, 7.8, 1.7, 3.6, 0.4, WOOD) + C(6, 6.4, 2.9, GRASS) + liteC(17.2, 13, 1, 0.35) + liteC(5.1, 5.4, 0.8, 0.35)),

  // ---------------------------------------------------------------- zoning
  /** category: four coloured zone tiles */
  zone: I(R(2.5, 2.5, 8.6, 8.6, 1.8, '#8fd95a') + R(12.9, 2.5, 8.6, 8.6, 1.8, '#62c6ff') + R(2.5, 12.9, 8.6, 8.6, 1.8, '#f1b634') + R(12.9, 12.9, 8.6, 8.6, 1.8, '#b57cf0') + lite('M3.6 3.6h6.4v1.4H3.6zM14 3.6h6.4v1.4H14zM3.6 14h6.4v1.4H3.6zM14 14h6.4v1.4H14z', 0.32)),
  house: I(R(5, 10.5, 14, 10.5, 0.8) + R(15.4, 4.2, 2.4, 4.6, 0.3) + P('M2.5 11.8 12 3.6l9.5 8.2z') + lite('M12 3.6l9.5 8.2h-1.9L12 5.5z', 0.3) + darkR(10.4, 15.2, 3.2, 5.8, 0.6, 0.7) + darkR(6.4, 13, 3, 3, 0.4, 0.62) + darkR(14.6, 13, 3, 3, 0.4, 0.62) + lite('M6.4 13h3v1.1h-3z', 0.5)),
  apartments: I(R(5, 2.5, 14, 19, 1) + R(4, 2.5, 16, 1.6, 0.5) + darkR(7, 5.6, 2.3, 2.3, 0.3, 0.68) + darkR(10.85, 5.6, 2.3, 2.3, 0.3, 0.68) + darkR(14.7, 5.6, 2.3, 2.3, 0.3, 0.68) + darkR(7, 9.2, 2.3, 2.3, 0.3, 0.68) + darkR(10.85, 9.2, 2.3, 2.3, 0.3, 0.68) + darkR(14.7, 9.2, 2.3, 2.3, 0.3, 0.68) + darkR(7, 12.8, 2.3, 2.3, 0.3, 0.68) + darkR(10.85, 12.8, 2.3, 2.3, 0.3, 0.68) + darkR(14.7, 12.8, 2.3, 2.3, 0.3, 0.68) + darkR(7, 16.4, 2.3, 2.3, 0.3, 0.68) + darkR(14.7, 16.4, 2.3, 2.3, 0.3, 0.68) + darkR(10.6, 17.6, 2.8, 3.9, 0.5, 0.75)),
  shop: I(R(4, 9.5, 16, 11.5, 0.8) + P('M2.5 7.6 5 3.5h14l2.5 4.1z') + dark('M6.6 3.5h2.2l-.4 4.1H6z M11 3.5h2v4.1h-2z M15.2 3.5h2.2l.6 4.1h-2.4z', 0.42) + R(2.5, 7.2, 19, 1.9, 0.9) + darkR(6, 12, 5.6, 4.6, 0.6, 0.62) + lite('M6 12h5.6v1.2H6z', 0.45) + darkR(13.6, 12, 4, 9, 0.6, 0.72) + liteC(16.6, 16.6, 0.5, 0.8)),
  tower: I(R(3, 12, 5, 10, 0.6) + R(11.3, 1, 1.4, 3.6, 0.4) + R(7, 4, 10.5, 18, 0.8) + darkR(8.8, 6, 1.9, 2, 0.3, 0.66) + darkR(11.3, 6, 1.9, 2, 0.3, 0.66) + darkR(13.8, 6, 1.9, 2, 0.3, 0.66) + darkR(8.8, 9.2, 1.9, 2, 0.3, 0.66) + darkR(11.3, 9.2, 1.9, 2, 0.3, 0.66) + darkR(13.8, 9.2, 1.9, 2, 0.3, 0.66) + darkR(8.8, 12.4, 1.9, 2, 0.3, 0.66) + darkR(11.3, 12.4, 1.9, 2, 0.3, 0.66) + darkR(13.8, 12.4, 1.9, 2, 0.3, 0.66) + darkR(8.8, 15.6, 1.9, 2, 0.3, 0.66) + darkR(11.3, 15.6, 1.9, 2, 0.3, 0.66) + darkR(13.8, 15.6, 1.9, 2, 0.3, 0.66) + darkR(4.2, 14, 1.7, 1.7, 0.3, 0.6) + darkR(4.2, 17, 1.7, 1.7, 0.3, 0.6) + darkR(11.1, 18.8, 2.3, 3.2, 0.4, 0.75)),
  industry: I(R(5, 3, 3.2, 8.5, 0.4) + liteC(9.6, 3.3, 1.7, 0.55) + liteC(12, 2.3, 1.3, 0.45) + P('M3 21.5V10.2l5 3.1v-3.1l5 3.1v-3.1l5 3.1v-3.1l3 1.9v9.4z') + darkR(6, 15.8, 2.6, 2.6, 0.3, 0.66) + darkR(10.7, 15.8, 2.6, 2.6, 0.3, 0.66) + darkR(15.4, 15.8, 2.6, 2.6, 0.3, 0.66) + dark('M3 21.5h18v-1.4H3z', 0.3)),
  office: I(R(4, 2.5, 16, 19.5, 1.2) + flatR(6, 4.6, 12, 13.6, 0.5, GLASS, 0.9) + L('M6 9.1h12M6 13.6h12M10 4.6v13.6M14 4.6v13.6', INK, 0.9, 0.42) + lite('M6 4.6h4v13.6H6z', 0.22) + darkR(10.2, 18.6, 3.6, 3.4, 0.5, 0.75)),

  // ---------------------------------------------------------------- services
  /** category: civic building */
  services: I(R(3, 18.6, 18, 3, 0.6) + R(5, 10.4, 2.4, 8.4, 0.3) + R(9.2, 10.4, 2.4, 8.4, 0.3) + R(13.4, 10.4, 2.4, 8.4, 0.3) + R(17.6, 10.4, 2.4, 8.4, 0.3, 'currentColor', 1) + R(3.5, 8.6, 17, 2.1, 0.4) + P('M2.5 8.8 12 2.5l9.5 6.3z') + liteC(12, 6.5, 1.1, 0.7)),
  power: I(P('M13.6 1.5 4.4 13.6h6.3L9.1 22.5 19.6 10h-6.4z') + lite('M13.2 3.2 7.4 10.9h3.9l-.9 2.3 3.2-4.1h-3.4z', 0.42)),
  water: I(P('M12 2.5s6.6 7.3 6.6 12a6.6 6.6 0 0 1-13.2 0C5.4 9.8 12 2.5 12 2.5z') + lite('M8.4 14.2a3.6 3.6 0 0 0 2.4 3.4c.1.9-.7 1.5-1.6 1.1a4.9 4.9 0 0 1-2.4-4.3c0-.9 1.4-1.2 1.6-.2z', 0.75)),
  sewage: I(P('M2.5 3.5h7.3a5.7 5.7 0 0 1 5.7 5.7V17h-4.2V9.7a1.5 1.5 0 0 0-1.5-1.5H2.5z') + R(10.2, 16.4, 6, 3.2, 0.6) + darkR(12, 5, 1.4, 4.5, 0.3, 0.35) + OL('M16 11.5c1.2-1.2 2.4-1.2 3.6 0s2.3 1.2 3.4 0M16 15.5c1.2-1.2 2.4-1.2 3.6 0s2.3 1.2 3.4 0', GLASS, 1.7)),
  garbage: I(R(9.4, 2.4, 5.2, 2.6, 1) + P('M5.5 7.8h13l-1.2 12.8a1.6 1.6 0 0 1-1.6 1.4H8.3a1.6 1.6 0 0 1-1.6-1.4z') + R(3.5, 5, 17, 2.8, 1.2) + L('M9.2 10.6l.4 8.6M12 10.6v8.6M14.8 10.6l-.4 8.6', INK, 1.5, 0.55)),
  police: I(P('M12 2 4 5v6.6c0 5 3.4 8.7 8 10.4 4.6-1.7 8-5.4 8-10.4V5z') + lite('M12 2 4 5v6.6c0 1 .1 1.9.4 2.8L12 3.4z', 0.22) + dark('M12 7l1.5 3.1 3.4.5-2.5 2.4.6 3.4L12 14.8l-3 1.6.6-3.4-2.5-2.4 3.4-.5z', 0.7)),
  fire: I(P('M12 22c-4.4 0-7.3-3-7.3-7.1 0-3 1.8-5 3.1-7.3.3 2 1.2 3.1 2.2 3.3-.2-4 2-6.6 4.3-8.6-.2 3 1 4.4 2.8 6.4s2.2 3.8 2.2 6.2c0 4.1-2.9 7.1-7.3 7.1z') + lite('M12 21c-2.1 0-3.7-1.5-3.7-3.6 0-1.9 1.8-3 3.7-5 1.9 2 3.7 3.1 3.7 5 0 2.1-1.6 3.6-3.7 3.6z', 0.78)),
  health: I(P('M9.4 2.5h5.2v6.9h6.9v5.2h-6.9v6.9H9.4v-6.9H2.5V9.4h6.9z') + lite('M10.5 3.6h1.4v6.9H3.6V9.4h6.9z', 0.32)),
  education: I(P('M1.5 9 12 4l10.5 5L12 14z') + P('M6 11.4v4.5c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-4.5L12 14.2z') + lite('M1.5 9 12 4l10.5 5-1.6.8L12 5.6 3.2 9.8z', 0.25) + L('M22 9.6v5.8', INK, 1.3, 0.75) + C(22, 16.6, 1.4, YELLOW)),
  school: I(P('M1.5 9 12 4l10.5 5L12 14z') + P('M6 11.4v4.5c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-4.5L12 14.2z') + L('M22 9.6v5.8', INK, 1.3, 0.75) + C(22, 16.6, 1.4, YELLOW)),
  park: I(R(10.8, 15.4, 2.4, 5.8, 0.5, WOOD) + P('M12 2.5l5.6 7.6h-3.4l4.1 5.4H5.7l4.1-5.4H6.4z', GRASS) + lite('M12 2.5l5.6 7.6h-1.8L12 5.1z', 0.3)),

  // ---------------------------------------------------------------- tools
  bulldoze: I(L('M13 12.2h3.7l2.1-4.2h2.4', INK, 3.2, 0.6) + L('M13 12.2h3.7l2.1-4.2h2.4', STEEL, 1.7, 1) + R(2.6, 9.2, 10.6, 6.3, 1, YELLOW) + R(4.8, 5.2, 5.4, 4.3, 0.7, YELLOW) + darkR(5.8, 6.2, 3.4, 2.4, 0.3, 0.68) + R(18.6, 8.3, 3.4, 9.2, 0.5, STEEL) + R(1.8, 15.5, 12.4, 4.8, 2.4, INK, 0.88) + liteC(4.4, 17.9, 1.15, 0.6) + liteC(8, 17.9, 1.15, 0.6) + liteC(11.6, 17.9, 1.15, 0.6)),
  select: I(P('M5 3l15 8.5-6.6 1.9-3.3 6.3z') + lite('M6.6 5.4l9 5.1-3 .9z', 0.3)),
  // white 'i' with the standard dark outline: legible both on the tinted plate and on the dark active plate
  info: I(C(12, 12, 9.5) + R(10.7, 10.4, 2.6, 7.2, 1.3, '#fff', 0.95) + C(12, 7.4, 1.6, '#fff', 0.95)),
  target: S('<circle cx="12" cy="12" r="8"/>' + flatC(12, 12, 2.8) + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),

  // ---------------------------------------------------------------- info views
  traffic: I(P('M4.5 13 6.6 7.4h10.8l2.1 5.6v5.6a1 1 0 0 1-1 1h-1.7a1 1 0 0 1-1-1V17H8.2v1.6a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1z') + dark('M7.1 12.6l1.4-3.9h7l1.4 3.9z', 0.6) + liteC(7.1, 14.9, 1.35, 0.85) + liteC(16.9, 14.9, 1.35, 0.85) + darkR(9.5, 14.4, 5, 1.4, 0.7, 0.45)),
  landvalue: I(R(2.5, 13.5, 4.8, 8, 0.6) + R(9.6, 9.5, 4.8, 12, 0.6) + R(16.7, 5, 4.8, 16.5, 0.6) + lite('M2.5 13.5h4.8v1.3H2.5zM9.6 9.5h4.8v1.3H9.6zM16.7 5h4.8v1.3h-4.8z', 0.4) + L('M3.5 10.5 9 6.8l4.5 2 6-5.4', INK, 1.5, 0.35)),
  pollution: I(P(CLOUD) + darkC(9.3, 12.4, 1.35, 0.7) + darkC(14.7, 12.4, 1.35, 0.7) + dark('M10.2 15.4h3.6c-.2 1.1-.9 1.6-1.8 1.6s-1.6-.5-1.8-1.6z', 0.7) + darkC(8, 20.7, 1.25, 0.5) + darkC(12, 20.7, 1.25, 0.5) + darkC(16, 20.7, 1.25, 0.5)),
  happiness: I(FACE + L('M7.4 13.9c1 2.4 2.6 3.6 4.6 3.6s3.6-1.2 4.6-3.6', INK, 1.9, 0.75)),
  sad: I(FACE + L('M7.4 17.2c1-2.4 2.6-3.6 4.6-3.6s3.6 1.2 4.6 3.6', INK, 1.9, 0.75)),

  // ---------------------------------------------------------------- statistics
  people: I(C(16.6, 8.6, 2.9, 'currentColor', 0.8) + P('M12.4 19.6c0-4 2-6.4 4.7-6.4s4.7 2.4 4.7 6.4z', 'currentColor', 0.8) + C(9, 7.6, 3.7) + P('M2.5 20.5c0-4.7 2.9-7.4 6.5-7.4s6.5 2.7 6.5 7.4z')),
  jobs: I(OL('M9 7.2V5a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 5v2.2', 'currentColor', 1.8) + R(3, 7, 18, 13.5, 2) + darkR(3.6, 12.2, 16.8, 1.5, 0, 0.42) + darkR(10.4, 11, 3.2, 3.2, 0.6, 0.72)),
  coin: I(C(12, 12, 9.5) + `<circle cx="12" cy="12" r="7" fill="none" stroke="${INK}" stroke-opacity=".38" stroke-width="1"/>` + L('M15 9.3A3.7 3.7 0 0 0 12.2 8a4 4 0 0 0 0 8 3.7 3.7 0 0 0 2.8-1.3', INK, 2.1, 0.75) + L('M9.6 11h5M9.6 13h5', INK, 1.3, 0.75)),
  income: I(P('M12 3 18.6 9.6h-4V20.5H9.4V9.6h-4z')),
  expense: I(P('M12 21 5.4 14.4h4V3.5h5.2v10.9h4z')),
  taxes: I(R(4.5, 2.5, 15, 19, 1.5) + L('M8 7.5h8M8 11h8M8 14.5h5', INK, 1.4, 0.55) + C(16.5, 17, 2.6, YELLOW) + L('M16.5 15.6v2.8', INK, 1, 0.7)),

  // ---------------------------------------------------------------- time
  pause: I(flatR(6, 4, 4.2, 16, 1.4) + flatR(13.8, 4, 4.2, 16, 1.4)),
  play: I(`<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor"/>`),
  fast2: I(`<path d="M3 5l8 7-8 7zM13 5l8 7-8 7z" fill="currentColor"/>`),
  fast3: I(`<path d="M1.5 6l6 6-6 6zM9 6l6 6-6 6zM16.5 6l6 6-6 6z" fill="currentColor"/>`),
  calendar: I(R(3, 4.5, 18, 17, 2.5) + dark('M3 7a2.5 2.5 0 0 1 2.5-2.5h13A2.5 2.5 0 0 1 21 7v2.3H3z', 0.55) + flatR(7, 2.4, 2, 4.2, 1, '#fff', 0.9) + flatR(15, 2.4, 2, 4.2, 1, '#fff', 0.9) + darkC(8, 13.6, 1.3, 0.6) + darkC(12, 13.6, 1.3, 0.6) + darkC(16, 13.6, 1.3, 0.6) + darkC(8, 17.6, 1.3, 0.6) + darkC(12, 17.6, 1.3, 0.6)),
  clock: I(C(12, 12, 9.5) + L('M12 6.8v5.4l3.6 2.1', INK, 2, 0.78) + darkC(12, 12, 1.1, 0.78)),
  sun: I(C(12, 12, 4.9) + SUN_RAYS),
  moon: I(P('M20.5 14.8A9 9 0 1 1 9.2 3.5a7.2 7.2 0 0 0 11.3 11.3z') + liteC(9.5, 12.5, 1, 0.35) + liteC(13.5, 16, 0.7, 0.3)),

  // ---------------------------------------------------------------- weather
  clear: I(C(12, 12, 4.9) + SUN_RAYS),
  cloudy: I(C(16.5, 8.5, 3.6, YELLOW) + P(CLOUD) + lite('M7.2 16.1a2 2 0 0 1-.9-3.7 4.7 4.7 0 0 1 8.9-2.2 3 3 0 0 0-3.4 1.3 3.3 3.3 0 0 0-4.6 4.6z', 0.22)),
  rain: I(P('M7 15h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.4 1.6A3.3 3.3 0 0 0 7 15z') + OL('M8 17.5l-1 3.5M12 17.5l-1 3.5M16 17.5l-1 3.5', GLASS, 1.8)),
  fog: S('<path d="M4 8.5h16M6 12.5h14M4 16.5h12M9 20.5h8"/>', 2.4),
  snow: S('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>' + flatC(12, 12, 2), 1.9),

  // ---------------------------------------------------------------- misc
  settings: I(P(GEAR) + darkC(12, 12, 3.4, 0.72)),
  bell: I(P('M12 2.6a6.2 6.2 0 0 0-6.2 6.2v3.5c0 .9-.3 1.7-.9 2.4L3.5 16.5h17l-1.4-1.8a3.8 3.8 0 0 1-.9-2.4V8.8A6.2 6.2 0 0 0 12 2.6z') + P('M9.3 18.2h5.4a2.7 2.7 0 0 1-5.4 0z') + lite('M8.4 5.4a4.8 4.8 0 0 0-1.6 3.4v3.5c0 .4 0 .8-.1 1.1l1.4-.1V8.8c0-1.3.4-2.4 1.1-3.3z', 0.4) + flatR(11.2, 1.4, 1.6, 1.8, 0.6)),
  keyboard: I(R(2, 6, 20, 12, 2.5) + darkR(4.5, 8.5, 2, 2, 0.4, 0.85) + darkR(8, 8.5, 2, 2, 0.4, 0.85) + darkR(11.5, 8.5, 2, 2, 0.4, 0.85) + darkR(15, 8.5, 2, 2, 0.4, 0.85) + darkR(18.5, 8.5, 1.5, 2, 0.4, 0.85) + darkR(4.5, 12, 2, 2, 0.4, 0.85) + darkR(17.5, 12, 2.5, 2, 0.4, 0.85) + darkR(8, 12, 8, 2, 0.4, 0.85)),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>', 2.2),
  check: S('<path d="M4.5 12.5l5 5L19.5 7"/>', 2.4),
  warning: I(P('M13.7 3.6c-.8-1.3-2.6-1.3-3.4 0L2.3 17.8c-.8 1.3.2 3 1.7 3h16c1.5 0 2.5-1.7 1.7-3z') + darkR(10.8, 8, 2.4, 6.6, 1.2, 0.78) + darkC(12, 17.4, 1.45, 0.78)),
  star: I(P('M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.3l-5.7 3.1 1.1-6.4L2.8 9.5l6.4-.9z')),
  starOutline: S('<path d="M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.3l-5.7 3.1 1.1-6.4L2.8 9.5l6.4-.9z"/>', 1.8),
  camera: I(P('M3 8.4h3.6l1.8-2.9h7.2l1.8 2.9H21v11.1H3z') + darkC(12, 13.8, 3.7, 0.68) + liteC(13.1, 12.6, 1, 0.7) + darkR(4.8, 10, 2.4, 1.4, 0.4, 0.45)),
  eye: I(P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z') + darkC(12, 12, 3.3, 0.72) + liteC(13.1, 10.9, 1, 0.75)),
  eyeOff: S('<path d="M3 3l18 18"/><path d="M10.6 5.2A10.5 10.5 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.7 8.6 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  chevronUp: S('<path d="M6 15l6-6 6 6"/>'),
  chevronDown: S('<path d="M6 9l6 6 6-6"/>'),
  pin: I(P('M12 22s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z') + darkC(12, 9.8, 2.7, 0.72)),
  ruler: I(P('M3 17 17 3l4 4L7 21z') + L('M7.4 12.6l1.8 1.8M10.4 9.6l1.8 1.8M13.4 6.6l1.8 1.8', INK, 1.3, 0.7)),
  crane: I(R(3.5, 19.4, 9.5, 2.4, 0.6) + darkR(3.8, 5.6, 3.2, 2.4, 0.3, 0.55) + R(7, 4.8, 14.5, 2.2, 0.4, YELLOW) + R(7, 4.8, 2.4, 14.8, 0.3, YELLOW) + L('M18.6 7v4.8', INK, 1, 0.8) + darkR(16.6, 11.6, 4, 3.4, 0.5, 0.65)),
  sparkle: I(P('M12 2.5l2 5.9 5.9 2-5.9 2-2 5.9-2-5.9-5.9-2 5.9-2z') + P('M19 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z', 'currentColor', 0.85)),
  reload: S('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  filter: I(P('M3 5h18l-7 8v6l-4 2v-8z')),
  mouse: I(R(6, 2.5, 12, 19, 6) + L('M12 2.5v7.5M6 10h12', INK, 0.9, 0.45) + darkR(11.1, 5, 1.8, 3.6, 0.9, 0.72)),
  grid: S('<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
  progress: S('<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 8v4l3 1.5"/>'),
  layers: I(P('M12 12.5 3 17.5l9 5 9-5z', 'currentColor', 0.55) + P('M12 7.5 3 12.5l9 5 9-5z', 'currentColor', 0.8) + P('M12 2.5 3 7.5l9 5 9-5z')),
  terrain: I(C(17.6, 5.6, 2.4, YELLOW) + P('M1.5 20.5 8.5 8.5l3.6 5.2 2.6-3.2 7.8 10z') + lite('M8.5 8.5l1.7 2.9-1.3.8-1.4-.9-1.3.8z', 0.75) + dark('M1.5 20.5h21v1H1.5z', 0.25)),
  buildingsView: I(R(2.5, 10.5, 6.5, 11, 0.6) + R(15, 12.5, 6.5, 9, 0.6) + R(8.5, 3.5, 7.5, 18, 0.8) + darkR(10.2, 6, 1.6, 1.8, 0.3, 0.62) + darkR(12.7, 6, 1.6, 1.8, 0.3, 0.62) + darkR(10.2, 9.5, 1.6, 1.8, 0.3, 0.62) + darkR(12.7, 9.5, 1.6, 1.8, 0.3, 0.62) + darkR(10.2, 13, 1.6, 1.8, 0.3, 0.62) + darkR(12.7, 13, 1.6, 1.8, 0.3, 0.62) + darkR(4, 13, 1.5, 1.6, 0.3, 0.55) + darkR(6.5, 13, 1.5, 1.6, 0.3, 0.55) + darkR(4, 16.5, 1.5, 1.6, 0.3, 0.55) + darkR(17, 15, 1.5, 1.6, 0.3, 0.55) + darkR(19, 15, 1.5, 1.6, 0.3, 0.55)),
  /** utility plug for the services-status row */
  plug: I(P('M7 9.5h10v3.5a5 5 0 0 1-10 0z') + L('M9.3 9.5V5M14.7 9.5V5', 'currentColor', 2, 1) + L('M12 18v3.5', 'currentColor', 2, 1)),
  efficiency: I(C(12, 13, 9) + dark('M12 13 7.2 8.6a6 6 0 0 0-1.1 3.2z', 0.15) + L('M12 13l4.6-4.6', INK, 2, 0.78) + darkC(12, 13, 1.3, 0.78) + L('M5.5 16.5h13', INK, 1.2, 0.35)),
};

export function icon(name) {
  return ICONS[name] || ICONS.info;
}
