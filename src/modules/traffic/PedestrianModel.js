/**
 * traffic — instanced pedestrian.
 *
 * One humanoid geometry; the walk cycle runs entirely in the vertex shader (limbs rotate about
 * their pivot, the body bobs), so several hundred walkers cost one draw call. Skin and hair tones
 * are derived in the shader from the per-instance seed so a crowd is not clone-like.
 *
 * aLimb: 0 body · 1 left arm · 2 right arm · 3 left leg · 4 right leg
 *        5 shoulder bag · 6 cap — accessories the vertex shader collapses to a point on the
 *        instances that should not carry them, so one mesh yields several silhouettes
 * aLight: 8 hair · 9 skin (tint codes, not emission)
 */
import { MeshBuilder, lin } from './Geometry.js';

const SKIN = { color: lin(0xd8ab8c), metal: 0, rough: 0.72, light: 9 };
const HAIR = { color: lin(0x6a4a34), metal: 0, rough: 0.80, light: 8 };
const SHIRT = { color: [1, 1, 1], paint: 1, metal: 0, rough: 0.78 };
const PANTS = { color: [1, 1, 1], paint2: 1, metal: 0, rough: 0.82 };
const SHOE = { color: lin(0x26282c), metal: 0.05, rough: 0.52 };
const BAG = { color: lin(0x33302c), metal: 0.02, rough: 0.70 };
const CAP = { color: lin(0x2c3542), metal: 0.02, rough: 0.72 };

/** Elliptical tube along +Y. rings: [{ y, rx, rz, st }]. */
function tubeY(b, rings, sides, opt = {}) {
  const rows = [];
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    const prev = rings[Math.max(0, i - 1)], next = rings[Math.min(rings.length - 1, i + 1)];
    const dy = next.y - prev.y || 1;
    const slope = -((next.rx - prev.rx) / dy);
    const row = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const x = (opt.cx || 0) + c * r.rx, z = (opt.cz || 0) + s * r.rz;
      const l = Math.hypot(c, slope, s * (r.rx / r.rz)) || 1;
      row.push(b.vert(x, r.y, z, c / l, slope / l, (s * (r.rx / r.rz)) / l, r.st));
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const j = (k + 1) % sides;
      b.quad(rows[i][k], rows[i][j], rows[i + 1][j], rows[i + 1][k]);
    }
  }
  for (const [end, ny] of [[0, -1], [rings.length - 1, 1]]) {
    if (opt.caps === false) continue;
    const r = rings[end];
    const c = b.vert(opt.cx || 0, r.y, opt.cz || 0, 0, ny, 0, r.st);
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      ring.push(b.vert((opt.cx || 0) + Math.cos(a) * r.rx, r.y, (opt.cz || 0) + Math.sin(a) * r.rz, 0, ny, 0, r.st));
    }
    for (let k = 0; k < sides; k++) {
      const j = (k + 1) % sides;
      if (ny > 0) b.tri(c, ring[k], ring[j]); else b.tri(c, ring[j], ring[k]);
    }
  }
}

const with_ = (st, limb, pivot) => ({ ...st, limb, pivot });

export function buildPedestrianGeometry(lod = 0) {
  const b = new MeshBuilder();
  const sides = lod === 0 ? 8 : 5;
  const hipY = 0.90, shoulderY = 1.43, headY = 1.545;

  // legs
  for (const sx of [-1, 1]) {
    const limb = sx < 0 ? 3 : 4;
    const px = sx * 0.093;
    const pv = [px, hipY, 0];
    const p = (st) => with_(st, limb, pv);
    const rings = lod === 0
      ? [{ y: 0.075, rx: 0.066, rz: 0.072 }, { y: 0.44, rx: 0.073, rz: 0.082 }, { y: 0.70, rx: 0.092, rz: 0.101 }, { y: hipY, rx: 0.108, rz: 0.116 }]
      : [{ y: 0.075, rx: 0.070, rz: 0.075 }, { y: hipY, rx: 0.108, rz: 0.116 }];
    tubeY(b, rings.map((r) => ({ ...r, st: p(PANTS) })), sides, { cx: px, caps: false });
    b.box(px, 0.034, 0.030, 0.115, 0.068, 0.255, p(SHOE));
  }

  // torso
  // Shoulders about 0.42 m across and a chest 0.26 m deep — the previous 0.32 m shoulders read as
  // a totem pole next to a 1.8 m-wide car.
  const torso = lod === 0
    ? [{ y: 0.86, rx: 0.152, rz: 0.112 }, { y: 1.06, rx: 0.172, rz: 0.122 }, { y: 1.28, rx: 0.206, rz: 0.134 }, { y: shoulderY, rx: 0.200, rz: 0.124 }]
    : [{ y: 0.86, rx: 0.154, rz: 0.114 }, { y: 1.28, rx: 0.204, rz: 0.134 }, { y: shoulderY, rx: 0.196, rz: 0.124 }];
  tubeY(b, torso.map((r) => ({ ...r, st: SHIRT })), sides, {});

  // neck + head
  tubeY(b, [{ y: shoulderY - 0.02, rx: 0.056, rz: 0.053, st: SKIN }, { y: headY, rx: 0.052, rz: 0.050, st: SKIN }], sides, { caps: false });
  const hr = 0.105;
  const lat = lod === 0 ? [0.14, 0.38, 0.62, 0.86] : [0.32, 0.68];
  const headRings = lat.map((t) => {
    const a = (t - 0.5) * Math.PI;
    return { y: headY + 0.10 + Math.sin(a) * hr * 1.10, rx: Math.cos(a) * hr, rz: Math.cos(a) * hr * 0.94, st: t > 0.70 ? HAIR : SKIN };
  });
  tubeY(b, headRings, sides, { caps: false });
  // crown + chin caps
  const crown = b.vert(0, headY + 0.10 + hr * 1.12, 0, 0, 1, 0, HAIR);
  const chin = b.vert(0, headY + 0.10 - hr * 1.12, 0, 0, -1, 0, SKIN);
  {
    const topRing = [], botRing = [];
    const t0 = lat[0], t1 = lat[lat.length - 1];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const mk = (t, st) => {
        const la = (t - 0.5) * Math.PI;
        return b.vert(Math.cos(a) * Math.cos(la) * hr, headY + 0.10 + Math.sin(la) * hr * 1.12, Math.sin(a) * Math.cos(la) * hr * 0.94,
          Math.cos(a) * Math.cos(la), Math.sin(la), Math.sin(a) * Math.cos(la), st);
      };
      topRing.push(mk(t1, HAIR));
      botRing.push(mk(t0, SKIN));
    }
    for (let k = 0; k < sides; k++) {
      const j = (k + 1) % sides;
      b.tri(crown, topRing[k], topRing[j]);
      b.tri(chin, botRing[j], botRing[k]);
    }
  }
  // hair sweep at the back of the head
  if (lod === 0) b.box(0, headY + 0.140, -0.056, 0.158, 0.125, 0.068, HAIR);

  // arms
  for (const sx of [-1, 1]) {
    const limb = sx < 0 ? 1 : 2;
    const px = sx * 0.242;
    const pv = [px, shoulderY - 0.03, 0];
    const p = (st) => with_(st, limb, pv);
    const rings = lod === 0
      ? [{ y: 0.945, rx: 0.042, rz: 0.042, st: p(SKIN) }, { y: 1.050, rx: 0.049, rz: 0.049, st: p(SKIN) },
         { y: 1.135, rx: 0.055, rz: 0.055, st: p(SHIRT) }, { y: 1.250, rx: 0.062, rz: 0.062, st: p(SHIRT) },
         { y: shoulderY - 0.01, rx: 0.079, rz: 0.074, st: p(SHIRT) }]
      : [{ y: 0.97, rx: 0.048, rz: 0.048, st: p(SKIN) }, { y: shoulderY - 0.01, rx: 0.072, rz: 0.070, st: p(SHIRT) }];
    tubeY(b, rings, Math.max(5, sides - 1), { cx: px, caps: false });
  }

  // --- accessories. Marked with limb codes the vertex shader can collapse per instance, so the
  //     same draw call yields bare walkers, walkers with a shoulder bag, and walkers in a cap.
  if (lod === 0) {
    const bagPv = [0.24, 1.30, 0];
    b.box(0.272, 1.05, -0.040, 0.090, 0.32, 0.22, with_(BAG, 5, bagPv));
    b.box(0.248, 1.25, 0.005, 0.038, 0.32, 0.038, with_(BAG, 5, bagPv));
    const capPv = [0, headY + 0.10, 0];
    b.box(0, headY + 0.222, -0.008, 0.218, 0.058, 0.218, with_(CAP, 6, capPv));
    b.box(0, headY + 0.184, 0.104, 0.196, 0.030, 0.100, with_(CAP, 6, capPv));
  }

  return b.geometry();
}
