/**
 * tools/shapes — higher level overlay drawings shared by the tools:
 * ground footprints, holographic selection cages, hatched danger fills and coverage discs.
 */
import { PAL, rectOutline, cornerBrackets, arc } from './gfx.js';

/** Ground footprint: inset outline + optional corner brackets + optional filled interior. */
export function drawFootprint(env, box, color, opts = {}) {
  const { vec, fill, groundY } = env;
  const outline = rectOutline(box.x, box.z, box.w, box.d, box.yaw, groundY, opts.inset || 0, opts.corner != null ? opts.corner : Math.min(box.w, box.d) * 0.16);
  vec.polyline(outline, { color, width: opts.width || 2.4, alpha: opts.alpha == null ? 0.95 : opts.alpha, glow: opts.glow == null ? 0.8 : opts.glow, closed: true, dash: opts.dash || 0 });
  if (opts.brackets) {
    for (const b of cornerBrackets(box.x, box.z, box.w * 1.06, box.d * 1.06, box.yaw, groundY, 0.3)) {
      vec.polyline(b, { color: opts.bracketColor || color, width: 3.4, alpha: 1, glow: 1.4 });
    }
  }
  if (opts.fill) {
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    const hw = box.w / 2, hd = box.d / 2;
    const P = (lx, lz) => { const x = box.x + lx * c - lz * s, z = box.z + lx * s + lz * c; return { x, y: groundY(x, z), z }; };
    const N = Math.max(1, Math.min(6, Math.round(Math.max(box.w, box.d) / 14)));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x0 = -hw + (2 * hw * i) / N, x1 = -hw + (2 * hw * (i + 1)) / N;
      const z0 = -hd + (2 * hd * j) / N, z1 = -hd + (2 * hd * (j + 1)) / N;
      fill.quad(P(x0, z0), P(x1, z0), P(x1, z1), P(x0, z1),
        [i / N * 6, j / N * 6, (i + 1) / N * 6, j / N * 6, (i + 1) / N * 6, (j + 1) / N * 6, i / N * 6, (j + 1) / N * 6],
        color, [opts.fillAlpha == null ? 0.3 : opts.fillAlpha, opts.pattern == null ? 4 : opts.pattern, 0.55, 0]);
    }
  }
  return outline;
}

/** Holographic cage over a volume: vertical corner posts, a top outline and translucent walls. */
export function drawCage(env, box, color, opts = {}) {
  const { vec, fill, groundY } = env;
  const h = Math.max(2, box.height || 10);
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  const hw = box.w / 2, hd = box.d / 2;
  const base = box.y != null ? box.y : groundY(box.x, box.z);
  const corner = (lx, lz) => {
    const x = box.x + lx * c - lz * s, z = box.z + lx * s + lz * c;
    return { x, z, gy: groundY(x, z) };
  };
  const cs = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
  const postH = opts.postFraction != null ? h * opts.postFraction : h;
  // vertical posts
  for (const p of cs) {
    vec.polyline([{ x: p.x, y: p.gy, z: p.z }, { x: p.x, y: base + postH, z: p.z }],
      { color, width: opts.width || 2.6, alpha: 0.9, glow: 1.1 });
  }
  // top outline
  const top = cs.map((p) => ({ x: p.x, y: base + h, z: p.z }));
  vec.polyline(top, { color, width: opts.width || 2.4, alpha: 0.85, glow: 1.0, closed: true });
  if (opts.walls) {
    for (let i = 0; i < 4; i++) {
      const a = cs[i], b = cs[(i + 1) % 4];
      fill.quad(
        { x: a.x, y: a.gy, z: a.z }, { x: b.x, y: b.gy, z: b.z },
        { x: b.x, y: base + h, z: b.z }, { x: a.x, y: base + h, z: a.z },
        [0, 0, 1, 0, 1, 1, 0, 1], color, [opts.wallAlpha == null ? 0.5 : opts.wallAlpha, 5, 4, 0]);
    }
    // roof
    fill.quad(top[0], top[1], top[2], top[3], [0, 1, 1, 1, 1, 1, 0, 1], color, [(opts.wallAlpha == null ? 0.5 : opts.wallAlpha) * 0.8, 5, 4, 0]);
  }
}

/** Ground ring + sweeping tick marks under a selected entity. */
export function drawSelectionRing(env, box, color, time) {
  const { vec, groundY } = env;
  const r = Math.max(box.w, box.d) * 0.72 + 2.5;
  vec.polyline(arc(box.x, box.z, r, 0, Math.PI * 2, groundY), { color, width: 1.8, alpha: 0.5, glow: 0.9, closed: false });
  const t = time * 0.5;
  for (let i = 0; i < 4; i++) {
    const a0 = t + (i * Math.PI) / 2;
    vec.polyline(arc(box.x, box.z, r, a0, a0 + 0.32, groundY), { color, width: 3.2, alpha: 0.95, glow: 1.6 });
  }
}

/**
 * Coverage disc, cached against (x, z, radius) so the terrain is only sampled when it moves.
 * Ring radii are graded towards the rim: the interior is a whisper of colour (a coarse mesh is
 * invisible at 2 % alpha) while the rim band is finely tessellated so it hugs rolling terrain.
 */
const DISC_RINGS = [0, 0.18, 0.34, 0.48, 0.60, 0.70, 0.785, 0.85, 0.895, 0.930, 0.955, 0.974, 0.988, 0.997, 1.004];

export function makeDisc() {
  let cache = null;
  return function disc(env, x, z, radius, color, alpha = 1) {
    const { fill, groundY } = env;
    const key = `${Math.round(x / 2)}_${Math.round(z / 2)}_${Math.round(radius)}`;
    if (!cache || cache.key !== key) {
      const SEG = 144;
      const rings = [];
      for (const t of DISC_RINGS) {
        const rr = radius * t;
        const row = [];
        for (let i = 0; i <= SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
          row.push({ x: px, y: groundY(px, pz) + 0.05, z: pz, t });
        }
        rings.push(row);
      }
      cache = { key, rings };
    }
    const rings = cache.rings;
    for (let r = 0; r < rings.length - 1; r++) {
      const a = rings[r], b = rings[r + 1];
      for (let i = 0; i < a.length - 1; i++) {
        fill.quad(a[i], a[i + 1], b[i + 1], b[i],
          [a[i].t, 0, a[i + 1].t, 0, b[i + 1].t, 1, b[i].t, 1], color, [alpha, 3, 1, 0]);
      }
    }
    return rings[rings.length - 1];
  };
}

export { PAL };
