/**
 * demo — procedural facade textures for the landmark buildings.
 *
 * The landmarks the demo builds itself (the stepped tower, the round tower, the twin towers, the
 * station head house) need a facade that holds up at 40 m: real mullion lines, a spandrel band per
 * floor, per-pane colour variation, and an emissive mask so a third of the windows are lit at night.
 * One 24 m square tile per style, drawn on a canvas from a seeded RNG — deterministic per seed.
 */
import * as THREE from 'three';

export const TILE = 24;          // metres covered by one texture repeat, both axes
const PX = 512;
const BAYS = 6;                  // 4.0 m structural bay
const FLOORS = 8;                // 3.0 m floor-to-floor

const cache = new Map();

function ctx2d() {
  const c = document.createElement('canvas');
  c.width = c.height = PX;
  return c.getContext('2d');
}

function jitter(rng, base, amt) {
  const [r, g, b] = base;
  const k = 1 + (rng() - 0.5) * amt;
  return `rgb(${Math.round(Math.min(255, r * k))},${Math.round(Math.min(255, g * k))},${Math.round(Math.min(255, b * k))})`;
}

/**
 * @param {'glass'|'stone'|'brick'} style
 * @returns {{ map: THREE.CanvasTexture, emissiveMap: THREE.CanvasTexture }}
 */
export function facadeTexture(style, seed, maxAniso = 8) {
  const key = style + ':' + seed;
  if (cache.has(key)) return cache.get(key);
  let s = (seed >>> 0) || 1;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const a = ctx2d(), e = ctx2d();
  const bw = PX / BAYS, fh = PX / FLOORS;
  const wall = style === 'glass' ? [58, 64, 72] : style === 'stone' ? [150, 140, 126] : [122, 78, 62];
  const pane = style === 'glass' ? [38, 48, 60] : [30, 33, 38];
  const mull = style === 'glass' ? [128, 132, 136] : [196, 190, 178];

  a.fillStyle = `rgb(${wall[0]},${wall[1]},${wall[2]})`;
  a.fillRect(0, 0, PX, PX);
  e.fillStyle = '#000';
  e.fillRect(0, 0, PX, PX);

  // masonry / panel texture: faint horizontal courses so the wall is never a flat fill
  for (let y = 0; y < PX; y += style === 'brick' ? 6 : 12) {
    a.fillStyle = `rgba(0,0,0,${0.04 + rng() * 0.05})`;
    a.fillRect(0, y, PX, 1);
  }

  for (let f = 0; f < FLOORS; f++) {
    const y0 = f * fh;
    // spandrel band under each window run
    a.fillStyle = jitter(rng, style === 'glass' ? [46, 52, 60] : [132, 122, 108], 0.14);
    a.fillRect(0, y0 + fh * 0.72, PX, fh * 0.28);
    for (let b = 0; b < BAYS; b++) {
      const x0 = b * bw;
      const inset = style === 'glass' ? 3 : bw * 0.22;
      const wx = x0 + inset, wy = y0 + fh * 0.12;
      const ww = bw - inset * 2, wh = fh * 0.58;
      a.fillStyle = jitter(rng, pane, 0.28);
      a.fillRect(wx, wy, ww, wh);
      // mullion / frame
      a.strokeStyle = jitter(rng, mull, 0.12);
      a.lineWidth = style === 'glass' ? 3 : 4;
      a.strokeRect(wx, wy, ww, wh);
      if (style === 'glass') {
        a.fillStyle = jitter(rng, mull, 0.1);
        a.fillRect(wx + ww * 0.5 - 1, wy, 2, wh);
      } else {
        // sill
        a.fillStyle = jitter(rng, [178, 172, 160], 0.1);
        a.fillRect(wx - 3, wy + wh, ww + 6, 4);
      }
      // reflected-sky streak on glass so panes are not uniform
      if (style === 'glass' && rng() < 0.5) {
        a.fillStyle = `rgba(150,170,190,${0.06 + rng() * 0.10})`;
        a.fillRect(wx, wy, ww, wh * (0.2 + rng() * 0.4));
      }
      // night: a third of the panes are lit, warm and uneven
      if (rng() < 0.34) {
        const warm = 0.7 + rng() * 0.3;
        e.fillStyle = `rgb(${Math.round(255 * warm)},${Math.round(212 * warm)},${Math.round(150 * warm)})`;
        e.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
        if (rng() < 0.4) {                 // a blind half-drawn
          e.fillStyle = 'rgba(0,0,0,0.55)';
          e.fillRect(wx + 1, wy + 1, ww - 2, wh * (0.2 + rng() * 0.4));
        }
      }
    }
  }

  const mk = (c) => {
    const t = new THREE.CanvasTexture(c.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
    return t;
  };
  const out = { map: mk(a), emissiveMap: mk(e) };
  cache.set(key, out);
  return out;
}
