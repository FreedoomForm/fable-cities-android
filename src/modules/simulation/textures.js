/**
 * Procedural (canvas) textures for the service-building visuals. Everything is deterministic
 * (seeded) and generated once per session. Colour maps are sRGB, data maps linear.
 *
 *  - makeWindowSet(seed)   ribbon-window band: colour / normal / roughness / emissive maps that
 *                          share ONE pane grid (PANES panes per tile, PANE_W metres each), so the
 *                          lit windows at night are exactly the panes you see by day.
 *  - makeSign(opts)        lettered sign board (colour + emissive-letters map).
 *  - makeRollerDoor()      slatted roller door / louvre (colour + normal + roughness).
 *  - makeGarbage(seed)     landfill litter albedo + normal.
 *  - makeHedge(seed)       clipped hedge foliage albedo + normal.
 *  - makeLightPool()       radial gradient for additive light pools under lamps.
 *  - makeChevron()         retro-reflective rear chevron stripes for emergency apparatus.
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';

export const PANES = 16;      // panes per texture tile
export const PANE_W = 1.5;    // metres per pane
export const BAND_H = 2.0;    // metres per band (one texture row)
export const WINDOW_ROWS = 4; // independent pane rows in the atlas (v = row / WINDOW_ROWS)

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function toTexture(cv, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
const rgb = (r, g, b) => `rgb(${r | 0},${g | 0},${b | 0})`;
const rgba = (r, g, b, a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/** Grey-scale height canvas → tangent-space normal map (OpenGL +Y). `strength` in texels of slope. */
export function heightToNormal(hcv, strength = 2.0, wrap = true) {
  const w = hcv.width, h = hcv.height;
  const src = hcv.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); }
    return src[(y * w + x) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1; // canvas y grows downwards → flip for +Y-up normal maps
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const k = (y * w + x) * 4;
      d[k] = 128 + nx * 127; d[k + 1] = 128 + ny * 127; d[k + 2] = 128 + nz * 127; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Fine grain noise overlay (multiply-ish) for painted / metal surfaces. */
function grain(c, w, h, rng, amount = 0.08, n = 4000) {
  for (let i = 0; i < n; i++) {
    const v = 128 + (rng() - 0.5) * 255 * amount * 2;
    c.fillStyle = rgba(v, v, v, 0.12);
    c.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1 + rng() * 3);
  }
}

// ---------------------------------------------------------------------------------------------
// ribbon windows
// ---------------------------------------------------------------------------------------------
export function makeWindowSet(seed) {
  const ROW_H = 192;
  const W = 2048, H = ROW_H * WINDOW_ROWS;      // 16 panes × 1.5 m  ×  WINDOW_ROWS bands of 2.0 m
  const pw = W / PANES;                        // 128 px per pane
  const pxm = pw / PANE_W;                     // px per metre horizontally
  const mull = Math.round(0.07 * pxm);         // half mullion (frame between panes)
  const frameV = Math.round(0.12 * (ROW_H / BAND_H)); // head/sill frame
  const transomH = Math.round(0.06 * (ROW_H / BAND_H));
  const rng = makeRng(seed);
  // three lamp temperatures (2700 K / 4000 K / 6500 K) in sRGB
  const TEMPS = [[255, 176, 108], [255, 214, 170], [222, 236, 255]];

  const col = canvas(W, H), cc = col.getContext('2d');
  const hgt = canvas(W, H), hc = hgt.getContext('2d');
  const rou = canvas(W, H), rc = rou.getContext('2d');
  const emi = canvas(W, H), ec = emi.getContext('2d');

  // frames
  cc.fillStyle = '#aeb2b6'; cc.fillRect(0, 0, W, H);
  grain(cc, W, H, rng, 0.05, 3000 * WINDOW_ROWS);
  hc.fillStyle = '#ffffff'; hc.fillRect(0, 0, W, H);
  rc.fillStyle = rgb(120, 120, 120); rc.fillRect(0, 0, W, H);
  ec.fillStyle = '#000'; ec.fillRect(0, 0, W, H);

  for (let row = 0; row < WINDOW_ROWS; row++) {
    const yBase = row * ROW_H;
    const transomY = yBase + Math.round(ROW_H * 0.32);
    for (let i = 0; i < PANES; i++) {
      const x0 = i * pw + mull, x1 = (i + 1) * pw - mull;
      const gw = x1 - x0;
      const lit = rng.chance(0.68);
      const temp = TEMPS[rng.chance(0.45) ? 0 : rng.chance(0.75) ? 1 : 2];
      const bright = 0.45 + rng() * 0.55;
      const blinds = rng.chance(0.3) ? rng.range(0.25, 0.6) : 0;
      const tintK = rng.range(-10, 10);
      const drawPane = (y0, y1) => {
        const gh = y1 - y0;
        // glass: cool blue-grey gradient with a soft sky reflection at the top
        const g = cc.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, rgb(86 + tintK, 104 + tintK, 116 + tintK));
        g.addColorStop(0.45, rgb(44 + tintK, 58 + tintK, 68 + tintK));
        g.addColorStop(1, rgb(58 + tintK, 72 + tintK, 80 + tintK));
        cc.fillStyle = g; cc.fillRect(x0, y0, gw, gh);
        // diagonal reflection streak
        cc.save(); cc.beginPath(); cc.rect(x0, y0, gw, gh); cc.clip();
        const s = cc.createLinearGradient(x0, y0, x0 + gw, y1);
        s.addColorStop(0.15, 'rgba(255,255,255,0)'); s.addColorStop(0.32, 'rgba(255,255,255,0.10)'); s.addColorStop(0.45, 'rgba(255,255,255,0)');
        cc.fillStyle = s; cc.fillRect(x0, y0, gw, gh);
        // blinds (day): light horizontal slats in the upper part of the pane
        if (blinds > 0) {
          const bh = gh * blinds;
          cc.fillStyle = 'rgba(214,210,200,0.85)'; cc.fillRect(x0, y0, gw, bh);
          cc.fillStyle = 'rgba(120,118,112,0.55)';
          for (let y = y0 + 3; y < y0 + bh; y += 6) cc.fillRect(x0, y, gw, 2);
        }
        cc.restore();
        // inner frame shadow line
        cc.strokeStyle = 'rgba(0,0,0,0.35)'; cc.lineWidth = 2; cc.strokeRect(x0 + 1, y0 + 1, gw - 2, gh - 2);
        // height: glass recessed
        hc.fillStyle = '#404040'; hc.fillRect(x0, y0, gw, gh);
        // roughness: glass smooth
        rc.fillStyle = rgb(38, 38, 38); rc.fillRect(x0, y0, gw, gh);
        if (blinds > 0) { rc.fillStyle = rgb(150, 150, 150); rc.fillRect(x0, y0, gw, gh * blinds); }
        // emissive: only lit panes, only glass area; colour temperature + brightness per pane
        if (lit) {
          const [r, gg, b] = temp;
          const eg = ec.createLinearGradient(0, y0, 0, y1);
          eg.addColorStop(0, rgba(r, gg, b, bright));
          eg.addColorStop(1, rgba(r, gg, b, bright * 0.7));
          ec.fillStyle = eg; ec.fillRect(x0, y0, gw, gh);
          if (blinds > 0) { ec.fillStyle = 'rgba(0,0,0,0.6)'; ec.fillRect(x0, y0, gw, gh * blinds); }
        }
      };
      drawPane(yBase + frameV, transomY - transomH / 2);
      drawPane(transomY + transomH / 2, yBase + ROW_H - frameV);
    }
  }
  // soften the height map a touch so the frame bevel reads as a small radius
  const hb = canvas(W, H); const hbc = hb.getContext('2d');
  hbc.filter = 'blur(1.2px)'; hbc.drawImage(hgt, 0, 0);
  return {
    map: toTexture(col, { srgb: true, aniso: 16 }),
    normalMap: toTexture(heightToNormal(hb, 2.2), { srgb: false, aniso: 16 }),
    roughnessMap: toTexture(rou, { srgb: false }),
    emissiveMap: toTexture(emi, { srgb: true, aniso: 16 }),
  };
}

// ---------------------------------------------------------------------------------------------
// lettered signs
// ---------------------------------------------------------------------------------------------
/**
 * @param {{text:string, sub?:string, bg:string, fg:string, w:number, h:number, icon?:'cross'|'shield'|'flame'|'drop'|'bolt'|'leaf'|'book', border?:string}} o
 */
export function makeSign(o) {
  const W = 1024, H = Math.max(96, Math.round(W * o.h / o.w));
  const col = canvas(W, H), c = col.getContext('2d');
  const emi = canvas(W, H), e = emi.getContext('2d');
  const pad = Math.round(H * 0.12);
  // background panel with a subtle vertical gradient and a lighter inner border
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(o.bg, 1.12)); g.addColorStop(1, shade(o.bg, 0.86));
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = o.border || 'rgba(255,255,255,0.35)'; c.lineWidth = Math.max(3, H * 0.035);
  c.strokeRect(pad * 0.55, pad * 0.55, W - pad * 1.1, H - pad * 1.1);
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  // faint panel glow at night
  e.fillStyle = shade(o.bg, 0.22); e.fillRect(pad * 0.55, pad * 0.55, W - pad * 1.1, H - pad * 1.1);

  let x0 = pad * 1.2;
  if (o.icon) {
    const s = H - pad * 2.2, cx = x0 + s / 2, cy = H / 2;
    drawIcon(c, o.icon, cx, cy, s, o.fg);
    drawIcon(e, o.icon, cx, cy, s, o.fg);
    x0 += s + pad * 0.9;
  }
  const avail = W - x0 - pad * 1.2;
  const lines = o.sub ? [[o.text, 0.56], [o.sub, 0.30]] : [[o.text, 0.68]];
  let y = o.sub ? pad * 0.9 : (H - H * 0.68) / 2;
  for (const [txt, frac] of lines) {
    const size = fitFont(c, txt, avail, H * frac);
    for (const ctx of [c, e]) {
      ctx.font = `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillStyle = o.fg;
      const spacing = size * 0.06;
      // manual letter spacing
      let x = x0 + (avail - measureSpaced(ctx, txt, spacing)) / 2;
      for (const ch of txt) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + spacing; }
    }
    y += H * frac * 1.08;
  }
  return { map: toTexture(col, { srgb: true, repeat: false, aniso: 16 }), emissiveMap: toTexture(emi, { srgb: true, repeat: false, aniso: 16 }) };
}
function measureSpaced(ctx, txt, spacing) {
  let w = 0;
  for (const ch of txt) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}
function fitFont(ctx, txt, maxW, maxH) {
  let size = maxH;
  ctx.font = `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  while (size > 8 && measureSpaced(ctx, txt, size * 0.06) > maxW) {
    size *= 0.94;
    ctx.font = `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  }
  return Math.floor(size);
}
function shade(hex, k) {
  const c = new THREE.Color(hex);
  return rgb(Math.min(255, c.r * 255 * k), Math.min(255, c.g * 255 * k), Math.min(255, c.b * 255 * k));
}
function drawIcon(c, kind, cx, cy, s, color) {
  c.save();
  c.fillStyle = color; c.strokeStyle = color; c.lineWidth = s * 0.09; c.lineJoin = 'round';
  const r = s / 2;
  switch (kind) {
    case 'cross': {
      const t = s * 0.3;
      c.fillRect(cx - t / 2, cy - r * 0.92, t, r * 1.84);
      c.fillRect(cx - r * 0.92, cy - t / 2, r * 1.84, t);
      break;
    }
    case 'shield':
      c.beginPath(); c.moveTo(cx, cy - r); c.lineTo(cx + r * 0.85, cy - r * 0.6); c.lineTo(cx + r * 0.7, cy + r * 0.3);
      c.quadraticCurveTo(cx + r * 0.3, cy + r * 0.95, cx, cy + r); c.quadraticCurveTo(cx - r * 0.3, cy + r * 0.95, cx - r * 0.7, cy + r * 0.3);
      c.lineTo(cx - r * 0.85, cy - r * 0.6); c.closePath(); c.stroke();
      c.beginPath(); c.arc(cx, cy - r * 0.05, r * 0.28, 0, Math.PI * 2); c.fill();
      break;
    case 'flame':
      c.beginPath(); c.moveTo(cx, cy - r); c.bezierCurveTo(cx + r * 1.1, cy - r * 0.1, cx + r * 0.8, cy + r, cx, cy + r);
      c.bezierCurveTo(cx - r * 0.8, cy + r, cx - r * 1.1, cy - r * 0.1, cx, cy - r); c.fill();
      break;
    case 'drop':
      c.beginPath(); c.moveTo(cx, cy - r); c.bezierCurveTo(cx + r * 0.9, cy + r * 0.1, cx + r * 0.7, cy + r, cx, cy + r);
      c.bezierCurveTo(cx - r * 0.7, cy + r, cx - r * 0.9, cy + r * 0.1, cx, cy - r); c.fill();
      break;
    case 'bolt':
      c.beginPath(); c.moveTo(cx + r * 0.25, cy - r); c.lineTo(cx - r * 0.55, cy + r * 0.12); c.lineTo(cx - r * 0.02, cy + r * 0.12);
      c.lineTo(cx - r * 0.3, cy + r); c.lineTo(cx + r * 0.6, cy - r * 0.18); c.lineTo(cx + r * 0.05, cy - r * 0.18); c.closePath(); c.fill();
      break;
    case 'leaf':
      c.beginPath(); c.moveTo(cx - r * 0.9, cy + r * 0.9); c.bezierCurveTo(cx - r * 0.9, cy - r * 0.8, cx + r * 0.3, cy - r, cx + r * 0.95, cy - r * 0.95);
      c.bezierCurveTo(cx + r, cy, cx + r * 0.2, cy + r * 0.9, cx - r * 0.9, cy + r * 0.9); c.fill();
      break;
    case 'book':
      c.beginPath(); c.moveTo(cx - r, cy - r * 0.7); c.lineTo(cx, cy - r * 0.45); c.lineTo(cx + r, cy - r * 0.7); c.lineTo(cx + r, cy + r * 0.75);
      c.lineTo(cx, cy + r); c.lineTo(cx - r, cy + r * 0.75); c.closePath(); c.stroke();
      c.beginPath(); c.moveTo(cx, cy - r * 0.45); c.lineTo(cx, cy + r); c.stroke();
      break;
    default:
      c.beginPath(); c.arc(cx, cy, r * 0.8, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

// ---------------------------------------------------------------------------------------------
// roller door / louvre — 1 m × 1 m tile, 3 slats per metre
// ---------------------------------------------------------------------------------------------
export function makeRollerDoor(baseColor = '#b4b8bb', seed = 7) {
  const S = 512, rng = makeRng(seed);
  const col = canvas(S, S), c = col.getContext('2d');
  const hgt = canvas(S, S), h = hgt.getContext('2d');
  const rou = canvas(S, S), r = rou.getContext('2d');
  c.fillStyle = baseColor; c.fillRect(0, 0, S, S);
  h.fillStyle = '#808080'; h.fillRect(0, 0, S, S);
  r.fillStyle = rgb(135, 135, 135); r.fillRect(0, 0, S, S);
  const slats = 3, sh = S / slats;
  for (let i = 0; i < slats; i++) {
    const y0 = i * sh;
    const g = c.createLinearGradient(0, y0, 0, y0 + sh);
    g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.35, 'rgba(255,255,255,0.02)'); g.addColorStop(0.85, 'rgba(0,0,0,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0.42)');
    c.fillStyle = g; c.fillRect(0, y0, S, sh);
    const hg = h.createLinearGradient(0, y0, 0, y0 + sh);
    hg.addColorStop(0, '#9a9a9a'); hg.addColorStop(0.5, '#c8c8c8'); hg.addColorStop(0.92, '#8a8a8a'); hg.addColorStop(1, '#303030');
    h.fillStyle = hg; h.fillRect(0, y0, S, sh);
    // seam line
    c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(0, y0 + sh - 3, S, 3);
  }
  grain(c, S, S, rng, 0.07, 2500);
  // vertical panel joints every 0.5 m
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(S / 2 - 1, 0, 2, S); c.fillRect(0, 0, 2, S);
  return {
    map: toTexture(col, { srgb: true }),
    normalMap: toTexture(heightToNormal(hgt, 1.8), { srgb: false }),
    roughnessMap: toTexture(rou, { srgb: false }),
  };
}

// ---------------------------------------------------------------------------------------------
// landfill litter — 8 m tile
// ---------------------------------------------------------------------------------------------
export function makeGarbage(seed) {
  const S = 1024, rng = makeRng(seed);
  const col = canvas(S, S), c = col.getContext('2d');
  const hgt = canvas(S, S), h = hgt.getContext('2d');
  c.fillStyle = '#4e4437'; c.fillRect(0, 0, S, S);
  h.fillStyle = '#707070'; h.fillRect(0, 0, S, S);
  // dirt mottling
  for (let i = 0; i < 2600; i++) {
    const v = rng();
    c.fillStyle = rgba(70 + v * 60, 58 + v * 48, 42 + v * 34, 0.55);
    const x = rng() * S, y = rng() * S, rx = 6 + rng() * 40, ry = 4 + rng() * 22;
    c.beginPath(); c.ellipse(x, y, rx, ry, rng() * Math.PI, 0, Math.PI * 2); c.fill();
  }
  // litter: bags, cardboard, plastic, scrap
  const palette = [
    [22, 22, 26, 0.95], [22, 22, 26, 0.95], [30, 30, 34, 0.9],       // black bags
    [214, 212, 204, 0.9], [200, 200, 196, 0.9],                      // white bags
    [46, 92, 150, 0.9], [56, 110, 170, 0.9],                         // blue plastic
    [168, 124, 72, 0.95], [150, 108, 60, 0.95], [190, 150, 96, 0.9], // cardboard
    [76, 124, 58, 0.85], [200, 60, 50, 0.85], [230, 190, 60, 0.8],   // green, red, yellow
  ];
  for (let i = 0; i < 900; i++) {
    const p = palette[Math.floor(rng() * palette.length)];
    const x = rng() * S, y = rng() * S, w = 10 + rng() * 34, d = 8 + rng() * 22, a = rng() * Math.PI;
    c.save(); c.translate(x, y); c.rotate(a);
    c.fillStyle = rgba(p[0], p[1], p[2], p[3]);
    if (rng() < 0.5) { c.beginPath(); c.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); c.fill(); }
    else c.fillRect(-w / 2, -d / 2, w, d);
    // highlight edge
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(-w / 2, -d / 2, w, 2);
    c.restore();
    h.save(); h.translate(x, y); h.rotate(a);
    const v = 150 + rng() * 90;
    h.fillStyle = rgb(v, v, v);
    h.beginPath(); h.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); h.fill();
    h.restore();
  }
  const hb = canvas(S, S); const hbc = hb.getContext('2d'); hbc.filter = 'blur(2px)'; hbc.drawImage(hgt, 0, 0);
  return { map: toTexture(col, { srgb: true }), normalMap: toTexture(heightToNormal(hb, 3.2), { srgb: false }) };
}

// ---------------------------------------------------------------------------------------------
// hedge foliage — 1 m tile
// ---------------------------------------------------------------------------------------------
export function makeHedge(seed) {
  const S = 512, rng = makeRng(seed);
  const col = canvas(S, S), c = col.getContext('2d');
  const hgt = canvas(S, S), h = hgt.getContext('2d');
  c.fillStyle = '#1f3a18'; c.fillRect(0, 0, S, S);
  h.fillStyle = '#404040'; h.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const x = rng() * S, y = rng() * S, r = 3 + rng() * 9, a = rng() * Math.PI;
    const v = rng();
    c.fillStyle = rgba(40 + v * 60, 92 + v * 70, 30 + v * 40, 0.9);
    c.save(); c.translate(x, y); c.rotate(a); c.beginPath(); c.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2); c.fill(); c.restore();
    const hv = 90 + v * 150;
    h.fillStyle = rgb(hv, hv, hv);
    h.save(); h.translate(x, y); h.rotate(a); h.beginPath(); h.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2); h.fill(); h.restore();
  }
  return { map: toTexture(col, { srgb: true }), normalMap: toTexture(heightToNormal(hgt, 2.5), { srgb: false }) };
}

// ---------------------------------------------------------------------------------------------
// additive light pool
// ---------------------------------------------------------------------------------------------
export function makeLightPool() {
  const S = 256;
  const cv = canvas(S, S), c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgb(255,255,255)');
  g.addColorStop(0.25, 'rgb(150,150,150)');
  g.addColorStop(0.6, 'rgb(40,40,40)');
  g.addColorStop(1, 'rgb(0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  const t = toTexture(cv, { srgb: true, repeat: false, aniso: 4 });
  return t;
}

/** Simple two-tone city flag (used on the wavy flag geometry). */
export function makeFlag() {
  const W = 256, H = 160;
  const cv = canvas(W, H), c = cv.getContext('2d');
  c.fillStyle = '#1f3d7a'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f2f2ee'; c.fillRect(0, H * 0.42, W, H * 0.16);
  c.beginPath(); c.arc(W * 0.3, H * 0.5, H * 0.19, 0, Math.PI * 2); c.fillStyle = '#f2b73a'; c.fill();
  return toTexture(cv, { srgb: true, repeat: false });
}

/** Retro-reflective rear chevrons (red / lemon), as used on fire and utility apparatus. */
export function makeChevron() {
  const W = 256, H = 64;
  const cv = canvas(W, H), c = cv.getContext('2d');
  c.fillStyle = '#c8161d'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f2e14a';
  c.save();
  for (let i = -2; i < 10; i++) {
    c.beginPath();
    const x = i * 28;
    c.moveTo(x, H); c.lineTo(x + 14, 0); c.lineTo(x + 28, 0); c.lineTo(x + 14, H);
    c.closePath(); c.fill();
  }
  c.restore();
  c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 2; c.strokeRect(1, 1, W - 2, H - 2);
  return toTexture(cv, { srgb: true, repeat: false });
}
