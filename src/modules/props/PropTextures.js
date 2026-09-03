/**
 * props — procedural canvas textures (deterministic, no downloads).
 * Everything here is generated once at init: leaf clumps, bark, soil, sign faces (one atlas,
 * alpha-cut shapes), street-name blades, chain-link mesh and the lamp halo falloff.
 * Albedo/emissive canvases are tagged sRGB, masks NoColorSpace (ARCHITECTURE §3).
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function tex(c, { srgb = true, aniso = 8, wrap = THREE.RepeatWrapping } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Vertical bark strands. */
export function makeBarkTexture(seed) {
  const rng = makeRng(seed);
  const w = 128, h = 256, c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#6d5c4c';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 1100; i++) {
    const x = rng() * w, y = rng() * h, len = 10 + rng() * 46;
    g.strokeStyle = `hsl(${22 + rng() * 14},${14 + rng() * 16}%,${24 + rng() * 30}%)`;
    g.lineWidth = 1 + rng() * 2.2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 5, y + len);
    g.stroke();
  }
  return tex(c);
}

/** Dark, damp planting soil for tree pits. */
export function makeSoilTexture(seed) {
  const rng = makeRng(seed);
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#3a3028';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    const x = rng() * S, y = rng() * S, r = 1 + rng() * 3.5;
    g.fillStyle = `hsl(${24 + rng() * 16},${10 + rng() * 18}%,${8 + rng() * 22}%)`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c);
}

/* ------------------------------------------------------------------ signs */

/** Tile ids in the sign atlas (4×4 grid, 256 px cells). */
export const SIGN_TILES = {
  stop: 0, yield: 1, speed50: 2, speed30: 3,
  noParking: 4, noEntry: 5, oneWay: 6, crossing: 7,
  parking: 8, busStop: 9, priority: 10, warning: 11,
  hydrantPlate: 12, bikeRoute: 13, noStopping: 14, blank: 15,
};
export const SIGN_ATLAS_COLS = 4;

function ring(g, cx, cy, r, color, width) {
  g.strokeStyle = color; g.lineWidth = width;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
}
function disc(g, cx, cy, r, color) {
  g.fillStyle = color;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
}
function poly(g, pts, fill, stroke, lw) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}
function label(g, text, cx, cy, size, color = '#ffffff', font = '900') {
  g.fillStyle = color;
  g.font = `${font} ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy);
}

/**
 * 1024² atlas of 16 traffic-sign faces with transparent surrounds (alphaTest cuts the shape,
 * so an octagon really reads as an octagon). Also used as the emissive map so the faces glow
 * faintly at night like retro-reflective sheeting.
 */
export function makeSignAtlas() {
  const T = 256, c = canvas(T * 4, T * 4), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const at = (id, fn) => {
    const ox = (id % 4) * T, oy = Math.floor(id / 4) * T;
    g.save(); g.translate(ox, oy); g.beginPath(); g.rect(0, 0, T, T); g.clip();
    fn(T / 2, T / 2);
    g.restore();
  };
  const R = T * 0.44;
  const octagon = (cx, cy, r) => {
    const p = [];
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return p;
  };
  at(SIGN_TILES.stop, (cx, cy) => {
    poly(g, octagon(cx, cy, R), '#b3181c', '#ffffff', 14);
    label(g, 'STOP', cx, cy + 4, 84);
  });
  at(SIGN_TILES.yield, (cx, cy) => {
    const r = T * 0.48;
    poly(g, [[cx, cy + r * 0.86], [cx - r * 0.95, cy - r * 0.62], [cx + r * 0.95, cy - r * 0.62]], '#f2f0ea', '#b3181c', 26);
    label(g, 'YIELD', cx, cy - r * 0.15, 46, '#20201e');
  });
  const speed = (n) => (cx, cy) => {
    disc(g, cx, cy, R, '#f4f2ec');
    ring(g, cx, cy, R - 12, '#b3181c', 24);
    label(g, n, cx, cy + 6, 108, '#1b1b19');
  };
  at(SIGN_TILES.speed50, speed('50'));
  at(SIGN_TILES.speed30, speed('30'));
  at(SIGN_TILES.noParking, (cx, cy) => {
    disc(g, cx, cy, R, '#1c4b96');
    ring(g, cx, cy, R - 10, '#b3181c', 22);
    g.strokeStyle = '#b3181c'; g.lineWidth = 22;
    g.beginPath(); g.moveTo(cx - R * 0.62, cy + R * 0.62); g.lineTo(cx + R * 0.62, cy - R * 0.62); g.stroke();
  });
  at(SIGN_TILES.noStopping, (cx, cy) => {
    disc(g, cx, cy, R, '#1c4b96');
    ring(g, cx, cy, R - 10, '#b3181c', 22);
    g.strokeStyle = '#b3181c'; g.lineWidth = 20;
    g.beginPath(); g.moveTo(cx - R * 0.6, cy + R * 0.6); g.lineTo(cx + R * 0.6, cy - R * 0.6);
    g.moveTo(cx - R * 0.6, cy - R * 0.6); g.lineTo(cx + R * 0.6, cy + R * 0.6); g.stroke();
  });
  at(SIGN_TILES.noEntry, (cx, cy) => {
    disc(g, cx, cy, R, '#b3181c');
    g.fillStyle = '#f4f2ec';
    g.fillRect(cx - R * 0.66, cy - R * 0.17, R * 1.32, R * 0.34);
  });
  at(SIGN_TILES.oneWay, (cx, cy) => {
    g.fillStyle = '#1b1b19';
    g.fillRect(cx - T * 0.46, cy - T * 0.2, T * 0.92, T * 0.4);
    g.fillStyle = '#f4f2ec';
    g.beginPath();
    g.moveTo(cx + T * 0.34, cy); g.lineTo(cx + T * 0.14, cy - 26); g.lineTo(cx + T * 0.14, cy - 9);
    g.lineTo(cx - T * 0.36, cy - 9); g.lineTo(cx - T * 0.36, cy + 9); g.lineTo(cx + T * 0.14, cy + 9);
    g.lineTo(cx + T * 0.14, cy + 26); g.closePath(); g.fill();
  });
  at(SIGN_TILES.crossing, (cx, cy) => {
    g.fillStyle = '#1c4b96';
    g.fillRect(cx - R, cy - R, R * 2, R * 2);
    g.fillStyle = '#f4f2ec';
    poly(g, [[cx, cy - R * 0.72], [cx - R * 0.78, cy + R * 0.46], [cx + R * 0.78, cy + R * 0.46]], '#f4f2ec');
    g.fillStyle = '#1b1b19';
    // walking figure
    g.beginPath(); g.arc(cx + 4, cy - R * 0.2, 13, 0, Math.PI * 2); g.fill();
    g.lineWidth = 12; g.strokeStyle = '#1b1b19'; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + 4, cy - R * 0.05); g.lineTo(cx + 2, cy + R * 0.16);
    g.moveTo(cx + 2, cy + R * 0.16); g.lineTo(cx - 16, cy + R * 0.42);
    g.moveTo(cx + 2, cy + R * 0.16); g.lineTo(cx + 22, cy + R * 0.4);
    g.moveTo(cx + 4, cy - R * 0.02); g.lineTo(cx - 20, cy + R * 0.08);
    g.stroke();
  });
  at(SIGN_TILES.parking, (cx, cy) => {
    g.fillStyle = '#1c4b96';
    g.fillRect(cx - R, cy - R, R * 2, R * 2);
    label(g, 'P', cx, cy + 8, 150);
  });
  at(SIGN_TILES.busStop, (cx, cy) => {
    disc(g, cx, cy, R, '#f0c419');
    ring(g, cx, cy, R - 9, '#1f6c3d', 18);
    g.fillStyle = '#1f6c3d';
    g.fillRect(cx - 52, cy - 34, 104, 62);
    g.fillStyle = '#f0c419';
    g.fillRect(cx - 44, cy - 26, 40, 26);
    g.fillRect(cx + 4, cy - 26, 40, 26);
    g.fillStyle = '#1f6c3d';
    g.beginPath(); g.arc(cx - 30, cy + 32, 11, 0, Math.PI * 2); g.arc(cx + 30, cy + 32, 11, 0, Math.PI * 2); g.fill();
  });
  at(SIGN_TILES.priority, (cx, cy) => {
    const r = T * 0.46;
    poly(g, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], '#f4f2ec');
    poly(g, [[cx, cy - r * 0.66], [cx + r * 0.66, cy], [cx, cy + r * 0.66], [cx - r * 0.66, cy]], '#f0c419');
  });
  at(SIGN_TILES.warning, (cx, cy) => {
    const r = T * 0.47;
    poly(g, [[cx, cy - r * 0.86], [cx - r * 0.95, cy + r * 0.62], [cx + r * 0.95, cy + r * 0.62]], '#f4f2ec', '#b3181c', 26);
    label(g, '!', cx, cy + r * 0.16, 96, '#1b1b19');
  });
  at(SIGN_TILES.hydrantPlate, (cx, cy) => {
    g.fillStyle = '#b3181c';
    g.fillRect(cx - T * 0.34, cy - T * 0.24, T * 0.68, T * 0.48);
    label(g, 'FH', cx, cy + 4, 74);
  });
  at(SIGN_TILES.bikeRoute, (cx, cy) => {
    disc(g, cx, cy, R, '#1c4b96');
    g.strokeStyle = '#f4f2ec'; g.lineWidth = 12;
    g.beginPath(); g.arc(cx - 34, cy + 18, 26, 0, Math.PI * 2); g.arc(cx + 34, cy + 18, 26, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - 34, cy + 18); g.lineTo(cx - 8, cy - 22); g.lineTo(cx + 26, cy - 22); g.lineTo(cx + 34, cy + 18); g.stroke();
  });
  at(SIGN_TILES.blank, (cx, cy) => {
    g.fillStyle = '#dcdad2';
    g.fillRect(cx - R * 0.8, cy - R, R * 1.6, R * 2);
  });
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}

export const STREET_NAMES = [
  'MAPLE ST', 'OAK AVENUE', 'HARBOUR RD', 'KING STREET',
  '5TH AVENUE', 'ELM STREET', 'RIVERSIDE', 'PARK LANE',
];

/** 512×1024 atlas: 8 rows of street-name blades (each tile 512×128, 4:1). */
export function makeNameAtlas() {
  const W = 512, RH = 128, c = canvas(W, RH * 8), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  for (let i = 0; i < 8; i++) {
    const y = i * RH;
    g.fillStyle = i % 3 === 2 ? '#1d4d8f' : '#14563a';
    g.fillRect(0, y + 8, W, RH - 16);
    g.strokeStyle = '#e8e6df'; g.lineWidth = 4;
    g.strokeRect(9, y + 16, W - 18, RH - 32);
    label(g, STREET_NAMES[i], W / 2, y + RH / 2 + 3, 54, '#f2f1ea', '700');
  }
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}

/** Alpha mask for chain-link fabric (diamond mesh), tiled 1 m². */
export function makeChainLinkTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#b9bcc0';
  g.lineWidth = 3.4;
  for (let i = -S; i < S * 2; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke();
    g.beginPath(); g.moveTo(i, S); g.lineTo(i + S, 0); g.stroke();
  }
  return tex(c);
}

/** Radial falloff for the lamp halo billboards (alpha only). */
export function makeHaloTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,241,214,0.72)');
  grd.addColorStop(0.45, 'rgba(255,226,178,0.20)');
  grd.addColorStop(1.0, 'rgba(255,214,150,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return tex(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

/** Bus-shelter advertising poster (lit from behind at night). */
export function makeAdPosterTexture(seed) {
  const rng = makeRng(seed);
  const W = 256, H = 384, c = canvas(W, H), g = c.getContext('2d');
  const hue = Math.floor(rng() * 360);
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, `hsl(${hue},58%,52%)`);
  grd.addColorStop(1, `hsl(${(hue + 48) % 360},62%,34%)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(24, H - 132, W - 48, 12);
  g.fillRect(24, H - 106, W - 90, 12);
  g.beginPath(); g.arc(W / 2, H * 0.36, 62, 0, Math.PI * 2); g.fill();
  g.fillStyle = `hsl(${hue},60%,40%)`;
  g.beginPath(); g.arc(W / 2, H * 0.36, 40, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(24, 28, 96, 10);
  return tex(c, { wrap: THREE.ClampToEdgeWrapping });
}

/* ------------------------------------------------------- foliage cards */

const hsl = (h, s, l) => `hsl(${h},${Math.round(s * 100)}%,${Math.round(l * 100)}%)`;

/**
 * Leaf-cluster card (RGBA, alpha-cut): ~340 overlapping leaves in an irregular blob that fills
 * ~70 % of the quad, back-to-front shaded so the clump reads lit from above. Street trees and
 * hedges are built from these instead of smooth spheres, which is what breaks the silhouette.
 * `shape` 0 = broadleaf clump, 1 = flatter, wider clump (hedge / low crown), 2 = blossom.
 */
export function makeLeafCardTexture(size = 512, seed = 5, hueBase = 102, lightBase = 0.27, shape = 0) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const cx = size * 0.5, cy = size * (shape === 1 ? 0.5 : 0.53);
  const R = size * (shape === 1 ? 0.43 : 0.40);
  const squash = shape === 1 ? 0.62 : 0.88;

  // blob silhouette = 5 overlapping sub-clusters
  const lobes = [{ x: cx, y: cy, r: R * 0.66 }];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 1.2, rr = R * (0.26 + rng() * 0.26);
    lobes.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * squash, r: R * (0.44 + rng() * 0.26) });
  }

  // twigs first, so leaves bury most of them
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI * 0.5 + (rng() - 0.5) * 2.6, len = R * (0.7 + rng() * 0.6);
    g.strokeStyle = hsl(28, 0.28, 0.15);
    g.lineWidth = size * (0.006 + rng() * 0.005);
    g.beginPath();
    g.moveTo(cx + (rng() - 0.5) * 24, cy + R * 0.45);
    g.quadraticCurveTo(cx + Math.cos(a) * len * 0.45, cy + Math.sin(a) * len * 0.5 + 12, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    g.stroke();
  }

  const leaf = (x, y, r, rot, hue, sat, light) => {
    g.save();
    g.translate(x, y); g.rotate(rot);
    const grd = g.createLinearGradient(0, -r, 0, r);
    grd.addColorStop(0, hsl(hue + 4, sat, Math.min(0.92, light * 1.2)));
    grd.addColorStop(1, hsl(hue - 7, sat * 0.92, light * 0.68));
    g.fillStyle = grd;
    g.beginPath();
    if (shape === 2) {                                   // blossom: five little petals
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        g.moveTo(0, 0);
        g.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.52, 0, Math.PI * 2);
      }
    } else {                                             // simple ovate leaf with a midrib
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.76, -r * 0.46, r * 0.7, r * 0.56, 0, r);
      g.bezierCurveTo(-r * 0.7, r * 0.56, -r * 0.76, -r * 0.46, 0, -r);
    }
    g.fill();
    if (shape !== 2) {
      g.strokeStyle = hsl(hue - 12, sat * 0.45, light * 0.46);
      g.lineWidth = Math.max(0.8, r * 0.055);
      g.beginPath(); g.moveTo(0, -r * 0.78); g.lineTo(0, r * 0.78); g.stroke();
    }
    g.restore();
  };

  const count = 340;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const lobe = lobes[(rng() * lobes.length) | 0];
    const a = rng() * Math.PI * 2, rr = lobe.r * Math.sqrt(rng()) * 1.03;
    pts.push({ x: lobe.x + Math.cos(a) * rr, y: lobe.y + Math.sin(a) * rr * squash });
  }
  // paint back-to-front: bottom leaves first (dark), top rim last (bright) → baked top light
  pts.sort((p, q) => (q.y - Math.abs(q.x - cx) * 0.25) - (p.y - Math.abs(p.x - cx) * 0.25));
  pts.forEach((p, i) => {
    const t = i / count;
    const edge = Math.min(1, Math.hypot(p.x - cx, (p.y - cy) / squash) / R);
    const r = size * (0.034 + rng() * 0.024) * (1 - 0.28 * edge);
    const hue = hueBase + (rng() - 0.5) * 20;
    const light = lightBase * (0.74 + 0.5 * t) + (rng() - 0.5) * 0.055;
    leaf(p.x, p.y, r, rng() * Math.PI * 2, hue, 0.38 + rng() * 0.24, Math.max(0.1, light));
  });
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}

/** Cast-iron tree grate: square plate with radial slots (alpha-cut openings + a bolt ring). */
export function makeGrateTexture(size = 256) {
  const c = canvas(size, size), g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, R = size * 0.5;
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#3a3d40';
  g.beginPath(); g.arc(cx, cy, R * 0.99, 0, Math.PI * 2); g.fill();
  // radial slots
  g.globalCompositeOperation = 'destination-out';
  g.lineCap = 'butt';
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    g.strokeStyle = '#000'; g.lineWidth = size * 0.026;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * 0.28, cy + Math.sin(a) * R * 0.28);
    g.lineTo(cx + Math.cos(a) * R * 0.80, cy + Math.sin(a) * R * 0.80);
    g.stroke();
  }
  g.beginPath(); g.arc(cx, cy, R * 0.17, 0, Math.PI * 2); g.fill();     // trunk hole
  g.globalCompositeOperation = 'source-over';
  // speckled cast-iron highlights so the plate is not a flat silhouette
  const rng = makeRng(4242);
  for (let i = 0; i < 320; i++) {
    const a = rng() * Math.PI * 2, rr = R * (0.18 + rng() * 0.78);
    g.fillStyle = `rgba(${180 + rng() * 50 | 0},${180 + rng() * 50 | 0},${182 + rng() * 50 | 0},${0.05 + rng() * 0.1})`;
    g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, size * 0.006 + rng() * size * 0.008, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = 'rgba(210,214,218,0.28)'; g.lineWidth = size * 0.018;
  g.beginPath(); g.arc(cx, cy, R * 0.86, 0, Math.PI * 2); g.stroke();
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}

/**
 * Driveway / forecourt apron: worn asphalt with two faint tyre tracks and a ragged alpha edge, so
 * an off-street parking bay blends into the lawn instead of stamping a hard rectangle on it.
 */
export function makeApronTexture(size = 256, seed = 77) {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  // ragged mask: a rounded rect eaten away at the edges
  g.fillStyle = '#000';
  const inset = size * 0.045;
  g.beginPath();
  g.moveTo(inset, inset);
  const edge = (x0, y0, x1, y1) => {
    const n = 14;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const nx = -(y1 - y0), ny = (x1 - x0);
      const l = Math.hypot(nx, ny) || 1;
      const j = (rng() - 0.5) * size * 0.055;
      g.lineTo(x0 + (x1 - x0) * t + (nx / l) * j, y0 + (y1 - y0) * t + (ny / l) * j);
    }
  };
  edge(inset, inset, size - inset, inset);
  edge(size - inset, inset, size - inset, size - inset);
  edge(size - inset, size - inset, inset, size - inset);
  edge(inset, size - inset, inset, inset);
  g.closePath();
  g.fill();
  // asphalt grain inside the mask
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#3b3d3f';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i++) {
    const l = 26 + rng() * 40;
    g.fillStyle = `rgba(${l | 0},${(l + 2) | 0},${(l + 4) | 0},${0.25 + rng() * 0.5})`;
    g.beginPath();
    g.arc(rng() * size, rng() * size, 0.6 + rng() * 2.1, 0, Math.PI * 2);
    g.fill();
  }
  // two lighter tyre tracks
  for (const tx of [size * 0.31, size * 0.69]) {
    const grd = g.createLinearGradient(tx - size * 0.07, 0, tx + size * 0.07, 0);
    grd.addColorStop(0, 'rgba(120,120,118,0)');
    grd.addColorStop(0.5, 'rgba(120,120,118,0.22)');
    grd.addColorStop(1, 'rgba(120,120,118,0)');
    g.fillStyle = grd;
    g.fillRect(tx - size * 0.07, 0, size * 0.14, size);
  }
  g.globalCompositeOperation = 'source-over';
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}

/* --------------------------------------------- ground cover & ground decals */

const BLADE = [
  // n   height        hue        sat          light        width  bend  dead
  // saturation narrowed ~15% from the first table (p5): the brightest isolated tufts measured
  // saturation p99 = 1.000 — neon-lime sparks against near-black neighbours a metre away
  { n: 46, h: [0.40, 0.74], hue: [86, 118], sat: [0.24, 0.39], lig: [0.24, 0.40], w: 0.030, bend: 0.40, dead: 0.06 },
  { n: 34, h: [0.58, 0.97], hue: [70, 104], sat: [0.20, 0.36], lig: [0.26, 0.43], w: 0.027, bend: 0.58, dead: 0.16 },
  { n: 30, h: [0.30, 0.62], hue: [42, 78], sat: [0.19, 0.34], lig: [0.30, 0.46], w: 0.036, bend: 0.74, dead: 0.44 },
  { n: 36, h: [0.42, 0.78], hue: [82, 114], sat: [0.22, 0.37], lig: [0.25, 0.41], w: 0.029, bend: 0.48, dead: 0.07 },
];

/**
 * Grass / undergrowth card (RGBA, alpha-cut): a fan of tapered blades springing from the bottom
 * edge, root-dark and tip-light so a tuft still reads three-dimensional in shadow. A share of the
 * blades is dead straw, which is what stops a lawn from being one flat green.
 * `style` 0 fine lawn · 1 tall meadow with seed heads · 2 dry weedy clump · 3 flowering.
 */
export function makeGrassCardTexture(size = 256, seed = 7, style = 0) {
  const rng = makeRng(seed);
  const S = BLADE[style];
  const c = canvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const R = (a, b) => a + rng() * (b - a);

  for (let i = 0; i < S.n; i++) {
    const x0 = size * R(0.10, 0.90);
    const h = size * R(S.h[0], S.h[1]);
    const dir = rng() < 0.5 ? -1 : 1;
    const bend = size * S.bend * R(0.25, 1.0) * dir;
    const w = size * S.w * R(0.7, 1.35);
    const dead = rng() < S.dead;
    const hue = dead ? R(36, 52) : R(S.hue[0], S.hue[1]);
    const sat = dead ? R(0.18, 0.30) : R(S.sat[0], S.sat[1]);
    const lig = dead ? R(0.30, 0.44) : R(S.lig[0], S.lig[1]);
    // blade as a tapered ribbon: sample the quadratic spine, offset by the shrinking half-width
    const P = 7, L = [], Rt = [];
    for (let k = 0; k <= P; k++) {
      const t = k / P;
      const sx = x0 + bend * t * t;
      const sy = size - h * t;
      const hw = w * (1 - t) * (1 - t * 0.35);
      L.push([sx - hw, sy]);
      Rt.push([sx + hw, sy]);
    }
    const grd = g.createLinearGradient(0, size, 0, size - h);
    grd.addColorStop(0, hsl(hue, sat, lig * 0.62));
    grd.addColorStop(0.55, hsl(hue, sat, lig));
    // tip boost trimmed (1.55→1.42, cap 0.70→0.62): sunlit blade tips were the top of the tuft
    // brightness histogram — the p5 critic read them as hard bright sparks
    grd.addColorStop(1, hsl(hue + 6, sat * 0.92, Math.min(0.62, lig * 1.42)));
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(L[0][0], L[0][1]);
    for (let k = 1; k <= P; k++) g.lineTo(L[k][0], L[k][1]);
    for (let k = P; k >= 0; k--) g.lineTo(Rt[k][0], Rt[k][1]);
    g.closePath();
    g.fill();
    // seed head on the tall meadow grass
    if (style === 1 && rng() < 0.34) {
      g.fillStyle = hsl(R(38, 54), 0.30, R(0.36, 0.50));
      g.beginPath();
      g.ellipse(x0 + bend, size - h - size * 0.01, w * 0.85, size * R(0.035, 0.06), bend * 0.004, 0, Math.PI * 2);
      g.fill();
    }
  }
  // wildflowers scattered through the clump
  if (style === 3) {
    const cols = ['#e8e3d2', '#e6d271', '#cfa8cf', '#e0e6ea', '#d9c3d8'];
    for (let i = 0; i < 16; i++) {
      const x = size * R(0.12, 0.88), y = size * R(0.16, 0.62);
      const r = size * R(0.014, 0.026);
      g.fillStyle = cols[(rng() * cols.length) | 0];
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        g.beginPath(); g.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.85, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = '#c2a63c';
      g.beginPath(); g.arc(x, y, r * 0.55, 0, Math.PI * 2); g.fill();
    }
  }
  // root shadow: the bottom of every clump sits in its own contact darkness
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, size, 0, size * 0.55);
  sh.addColorStop(0, 'rgba(14,18,10,0.62)');
  sh.addColorStop(1, 'rgba(14,18,10,0)');
  g.fillStyle = sh;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';
  return tex(c, { aniso: 8, wrap: THREE.ClampToEdgeWrapping });
}

/**
 * Tiny procedural surface-detail maps (seeded, deterministic — same pattern as every other canvas
 * texture here). ONE seeded value-noise height field drives BOTH a roughness map (grayscale;
 * three multiplies it by the material's base roughness, so the base value is what the map varies
 * AROUND) and a matching tangent-space normal map. 96 px, RepeatWrapping, NoColorSpace — one pair
 * per material family, shared by every material in it: no draw-call cost, and highlights stop
 * being a smooth wash (p5: 0 of 42 props materials carried any map).
 *
 * `style` 'brushed' directional streaks (poles, sheet metal) · 'speckle' cast-metal grain ·
 * 'mottle' concrete / plaster · 'grain' painted metal & wood. `stretch` = [u,v] noise frequency
 * multipliers (a pole's UV runs u around the circumference, v along the height, so brushed metal
 * wants fast-u / slow-v). Returns { roughMap, normalMap, mean } — `mean` is the roughness map's
 * average so the caller can divide the base roughness by it and keep the effective value on target.
 */
export function makeSurfaceMaps(size = 96, seed = 17, style = 'mottle', { amp = 0.20, normalStrength = 0.4, stretch = [1, 1] } = {}) {
  const rng = makeRng(seed);
  const F = [4, 8, 16];                 // value-noise grid resolution per octave (tiles: wraps at f)
  const W = style === 'speckle' ? [0.35, 0.30, 0.35] : [0.55, 0.30, 0.15];
  const grids = F.map((f) => {
    const g = new Float32Array(f * f);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    return g;
  });
  const sm = (t) => t * t * (3 - 2 * t);
  const sample = (g, f, u, v) => {
    const x = u * f, y = v * f;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = sm(x - ix), fy = sm(y - iy);
    const x0 = ((ix % f) + f) % f, x1 = (x0 + 1) % f;
    const y0 = ((iy % f) + f) % f, y1 = (y0 + 1) % f;
    const a = g[y0 * f + x0], b = g[y0 * f + x1], c = g[y1 * f + x0], d = g[y1 * f + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  const su = stretch[0], sv = stretch[1];
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < 3; o++) v += sample(grids[o], F[o], (x / size) * su, (y / size) * sv) * W[o];
      h[y * size + x] = v;
    }
  }
  const rc = canvas(size, size), rg2 = rc.getContext('2d');
  const nc = canvas(size, size), ng = nc.getContext('2d');
  const rImg = rg2.createImageData(size, size);
  const nImg = ng.createImageData(size, size);
  let mean = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // roughness: [1-amp .. 1], mean ≈ 1 - amp/2 (base value preserved by rescaling the material)
      const r = Math.round(255 * (1 - amp * (1 - h[i])));
      const o = i * 4;
      rImg.data[o] = rImg.data[o + 1] = rImg.data[o + 2] = r;
      rImg.data[o + 3] = 255;
      mean += r / 255;
      // normal: central differences on the wrapped height field, subtle slope
      const hx1 = h[y * size + ((x + 1) % size)], hx0 = h[y * size + ((x - 1 + size) % size)];
      const hy1 = h[((y + 1) % size) * size + x], hy0 = h[((y - 1 + size) % size) * size + x];
      let nx = (hx0 - hx1) * normalStrength, ny = (hy0 - hy1) * normalStrength;
      const il = 1 / Math.hypot(nx, ny, 1);
      nImg.data[o] = Math.round(255 * (nx * il * 0.5 + 0.5));
      nImg.data[o + 1] = Math.round(255 * (ny * il * 0.5 + 0.5));
      nImg.data[o + 2] = Math.round(255 * (1 * il * 0.5 + 0.5));
      nImg.data[o + 3] = 255;
    }
  }
  mean /= size * size;
  rg2.putImageData(rImg, 0, 0);
  ng.putImageData(nImg, 0, 0);
  return { roughMap: tex(rc, { srgb: false }), normalMap: tex(nc, { srgb: false }), mean };
}

/**
 * Contact-occlusion decal: white at the rim, dark in the middle, drawn with MultiplyBlending so it
 * darkens whatever ground it lies on in linear space. This is the AO tucked under every prop that
 * the shadow map is too coarse to resolve.
 */
export function makeContactTexture(size = 128) {
  const c = canvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.00, 'rgb(140,140,142)');
  grd.addColorStop(0.30, 'rgb(168,168,170)');
  grd.addColorStop(0.55, 'rgb(206,206,208)');
  grd.addColorStop(0.78, 'rgb(238,238,239)');
  grd.addColorStop(1.00, 'rgb(255,255,255)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.fill();
  return tex(c, { srgb: true, aniso: 4, wrap: THREE.ClampToEdgeWrapping });
}

/**
 * Warm pool a luminaire lays on the pavement. The falloff lives in the RGB, not the alpha, because
 * the pool is drawn with a MAX blend: overlapping lamps take the brighter pool instead of summing,
 * which is what turned a lit street into one continuous cream wash. Reaching a true black rim also
 * removes the hard polygon edge the critic saw — max(0, dst) is exactly dst.
 */
export function makeLightPoolTexture(size = 256) {
  const c = canvas(size, size), g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // smootherstep-shaped ramp on a warm sodium-white, black well BEFORE the rim: the falloff now
  // completes at 76% of the radius and stays zero to the edge, so the pool blends into the
  // un-pooled pavement over the outer quarter instead of ending in a hard 6.7x rim cliff (p5)
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = Math.min(1, (i / N) / 0.76);
    const f = 1 - t * t * t * (t * (t * 6 - 15) + 10);   // 1 at centre, 0 at 76% radius, C2 at both ends
    const k = Math.pow(Math.max(f, 0), 0.85);
    grd.addColorStop(i / N, `rgb(${Math.round(255 * k)},${Math.round(240 * k)},${Math.round(214 * k)})`);
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return tex(c, { srgb: true, aniso: 4, wrap: THREE.ClampToEdgeWrapping });
}

/** Ragged-edged ground decal: `kind` 'slab' pale stone paving · 'bed' dark planting mulch. */
export function makeGroundDecalTexture(size = 256, seed = 91, kind = 'slab') {
  const rng = makeRng(seed);
  const c = canvas(size, size), g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#000';
  if (kind === 'bed') {
    g.beginPath();
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = size * (0.40 + 0.055 * Math.sin(a * 3 + seed) + rng() * 0.04);
      const x = size / 2 + Math.cos(a) * r, y = size / 2 + Math.sin(a) * r * 0.92;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  } else {
    const inset = size * 0.05;
    g.beginPath();
    g.moveTo(inset, inset);
    const edge = (x0, y0, x1, y1) => {
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        const nx = -(y1 - y0), ny = (x1 - x0), l = Math.hypot(nx, ny) || 1;
        const j = (rng() - 0.5) * size * 0.035;
        g.lineTo(x0 + (x1 - x0) * t + (nx / l) * j, y0 + (y1 - y0) * t + (ny / l) * j);
      }
    };
    edge(inset, inset, size - inset, inset);
    edge(size - inset, inset, size - inset, size - inset);
    edge(size - inset, size - inset, inset, size - inset);
    edge(inset, size - inset, inset, inset);
    g.closePath();
  }
  g.fill();
  g.globalCompositeOperation = 'source-in';
  if (kind === 'bed') {
    g.fillStyle = '#3d3026';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {                       // bark chips
      const l = 26 + rng() * 34;
      g.fillStyle = `rgba(${(l + 22) | 0},${(l + 8) | 0},${(l - 4) | 0},${0.3 + rng() * 0.55})`;
      const x = rng() * size, y = rng() * size, w = 2 + rng() * 6;
      g.save(); g.translate(x, y); g.rotate(rng() * 3.14);
      g.fillRect(-w / 2, -1.2, w, 1.6 + rng() * 1.4);
      g.restore();
    }
  } else {
    g.fillStyle = '#9d9a92';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 2800; i++) {                       // stone grain
      const l = 128 + rng() * 62;
      g.fillStyle = `rgba(${l | 0},${(l - 2) | 0},${(l - 8) | 0},${0.16 + rng() * 0.34})`;
      g.beginPath(); g.arc(rng() * size, rng() * size, 0.6 + rng() * 2.2, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(60,58,54,0.34)';                 // slab joints
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, size * 0.5); g.lineTo(size, size * 0.5);
    g.moveTo(size * 0.5, 0); g.lineTo(size * 0.5, size * 0.5);
    g.stroke();
    for (let i = 0; i < 90; i++) {                         // moss creeping in from the joints
      g.fillStyle = `rgba(72,86,52,${0.10 + rng() * 0.25})`;
      const onH = rng() < 0.5;
      const x = onH ? rng() * size : size * 0.5 + (rng() - 0.5) * 7;
      const y = onH ? size * 0.5 + (rng() - 0.5) * 7 : rng() * size * 0.5;
      g.beginPath(); g.arc(x, y, 1 + rng() * 3, 0, Math.PI * 2); g.fill();
    }
  }
  g.globalCompositeOperation = 'source-over';
  return tex(c, { aniso: 16, wrap: THREE.ClampToEdgeWrapping });
}
