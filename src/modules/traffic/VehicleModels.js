/**
 * traffic — procedural vehicle bodies.
 *
 * Each type is a lofted shell (rounded-rectangle cross sections swept along +Z = forward) plus a
 * separate lofted greenhouse, with glass / paint / trim / lamps decided per vertex from position
 * and normal. That keeps a whole car in ONE geometry so the fleet renders from a single
 * InstancedMesh, while still giving real windscreens, side glass with A/B/C pillars, circular
 * wheel arches, bumpers, mirrors, lamps and indicators.
 *
 * Local frame: origin on the road surface between the wheels, +Z forward, +Y up.
 * With +Z forward and +Y up the vehicle's LEFT side is +X (Three.js right-handed convention).
 */
import { MeshBuilder, lin } from './Geometry.js';

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- shared surface styles
// `cls` is the flat surface class the vehicle shader reads (see materials.js CLS). It pins the
// specular response per MATERIAL_TARGET.md instead of letting a lofted quad interpolate a
// windscreen into the pillar beside it. Glass is a neutral dark tint at roughness 0.06 — it is
// allowed to reflect the sky and nothing else, and it is NEVER the body colour.
const G = 2, GB = 3, MET = 4, RUB = 5, LMP = 6;
const GLASS = { color: lin(0x0e1216), metal: 0.0, rough: 0.06, cls: G };
const GLASS_DARK = { color: lin(0x0a0d11), metal: 0.0, rough: 0.06, cls: G };
const GLASS_TAIL = { color: lin(0x101418), metal: 0.0, rough: 0.06, cls: G };
// Bus glazing: same pane, plus a light code so the saloon reads as lit after dark.
const GLASS_BUS = { color: lin(0x11161b), metal: 0.0, rough: 0.06, cls: GB, light: 10 };
const GLASS_BUS_D = { color: lin(0x0d1116), metal: 0.0, rough: 0.06, cls: GB, light: 10 };
const SEAL = { color: lin(0x0c0e10), metal: 0.03, rough: 0.70 };
const TRIM = { color: lin(0x23262a), metal: 0.12, rough: 0.55 };
const BUMPER = { color: lin(0x2b2f33), metal: 0.06, rough: 0.60 };
const RUBBER = { color: lin(0x0e1013), metal: 0.0, rough: 0.90, cls: RUB };
const ARCH = { color: lin(0x141619), metal: 0.02, rough: 0.92 };
const SHADOW = { color: lin(0x0a0b0d), metal: 0.0, rough: 0.95 };
const CHROME = { color: lin(0xd2d7dc), metal: 1.0, rough: 0.15, cls: MET };
const GRILLE = { color: lin(0x0f1114), metal: 0.55, rough: 0.35 };
const LAMP_F = { color: lin(0xd4dde6), metal: 0.10, rough: 0.10, cls: LMP, light: 1 };
// Lens albedo stays dark: a bright red base plus emissive clips under AgX and turns salmon.
const LAMP_R = { color: lin(0x520a07), metal: 0.05, rough: 0.10, cls: LMP, light: 2 };
const LAMP_B = { color: lin(0x5c0c08), metal: 0.05, rough: 0.10, cls: LMP, light: 3 };
const LAMP_IL = { color: lin(0x6a3c08), metal: 0.05, rough: 0.10, cls: LMP, light: 5 };  // indicator, left  (+X)
const LAMP_IR = { color: lin(0x6a3c08), metal: 0.05, rough: 0.10, cls: LMP, light: 6 };  // indicator, right (−X)
const LAMP_W = { color: lin(0xb9c0c6), metal: 0.06, rough: 0.10, cls: LMP };    // reverse lamp, unlit lens
const REFLECT = { color: lin(0x5a0d0a), metal: 0.20, rough: 0.14, cls: LMP };   // rear reflector
const LOUVRE = { color: lin(0x0a0c0e), metal: 0.35, rough: 0.55 };              // engine grille slats
const SHUT = { color: lin(0x070809), metal: 0.02, rough: 0.72 };                // panel shut line
const CABIN = { color: lin(0x2c2723), metal: 0.0, rough: 0.85, light: 7 };      // interior, faint night glow
const PLATE = { color: lin(0xdadcd4), metal: 0.04, rough: 0.45 };
// Body paint: roughness 0.30 / metalness 0 / clearcoat 1.0 at ccRoughness 0.05, set in the shader.
const PAINT = { color: [1, 1, 1], paint: 1, metal: 0.0, rough: 0.30, cls: 1 };
const PAINT_L = { color: [1, 1, 1], paint: 1, metal: 0.0, rough: 0.30, cls: 1 };
const PAINT2 = { color: [1, 1, 1], paint2: 1, metal: 0.0, rough: 0.30, cls: 1 };
const CARGO_RIB = { color: [1, 1, 1], paint2: 1, metal: 0.0, rough: 0.34, cls: 1 };

/** Realistic car-colour distribution (weight, sRGB hex).
 *
 *  Real fleets are neutral-dominant with a saturated minority — CS2 reads the same way. The p4
 *  critique found ours had drifted into a 1950s pastel set (powder blue, mint, salmon), so this
 *  is ~62% white/silver/grey/black and the chromatic 38% carries real chroma at lower lightness
 *  rather than a tinted off-white. Under a clearcoat a dark saturated colour is what shows the
 *  specular streak; a pastel just washes out. */
export const PAINT_COLOURS = [
  // neutrals — 62%
  [0.150, 0xe9ecef], [0.055, 0xf6f7f8], [0.120, 0x9aa1a8], [0.070, 0x5b6169],
  [0.130, 0x0e1013], [0.045, 0x373d44], [0.050, 0xc3c7c9],
  // saturated minority — 38%
  [0.065, 0x122a5e], [0.045, 0x14589e], [0.026, 0x2a86cc], [0.060, 0x8e1015],
  [0.038, 0xc4291d], [0.022, 0x5a0f19], [0.038, 0x123f27], [0.022, 0x0d7150],
  [0.024, 0xc38f07], [0.020, 0x7d3d0f], [0.014, 0xc4531a], [0.010, 0x452063],
];
/** Second colours — van bodies, truck cargo boxes, bus roofs. Mostly white fleet livery with a
 *  handful of liveried delivery vans so a queue is not six identical white boxes. */
export const BOX_COLOURS = [
  0xeceded, 0xd9dcda, 0xbcc1c3, 0xe3e6e3, 0xc6ced4, 0xe5e0d3,
  0xcbd2cf, 0x8ea4b6, 0x14508f, 0x9a2b26, 0x1f6440, 0xd09a12,
];

export const VEHICLE_SPECS = {
  sedan: {
    id: 'sedan', kind: 'car', len: 4.62, wid: 1.82, fo: 0.86, ro: 1.06, wheelR: 0.325, wheelW: 0.215,
    sill: 0.295, belt: 0.985, roof: 1.465, nose: 0.855, tail: 0.965,
    wsBase: 1.10, roofF: 0.42, roofR: -0.92, blBase: -1.52,
    archR: 1.34, archTop: 2.12, weight: 0.42, vmax: 1.02, mirrors: true, plateY: 0.44,
  },
  hatchback: {
    id: 'hatchback', kind: 'car', len: 4.05, wid: 1.76, fo: 0.80, ro: 0.70, wheelR: 0.305, wheelW: 0.20,
    sill: 0.285, belt: 0.975, roof: 1.505, nose: 0.845, tail: 1.045,
    wsBase: 0.98, roofF: 0.30, roofR: -1.00, blBase: -1.38,
    archR: 1.34, archTop: 2.12, weight: 0.20, mirrors: true, plateY: 0.44, hatch: true,
  },
  suv: {
    id: 'suv', kind: 'car', len: 4.80, wid: 1.94, fo: 0.90, ro: 1.08, wheelR: 0.375, wheelW: 0.245,
    sill: 0.400, belt: 1.135, roof: 1.795, nose: 1.010, tail: 1.175,
    wsBase: 1.06, roofF: 0.34, roofR: -1.14, blBase: -1.60,
    archR: 1.36, archTop: 2.08, weight: 0.20, mirrors: true, cladding: true, plateY: 0.55, vmax: 0.98,
  },
  van: {
    id: 'van', kind: 'box', len: 5.35, wid: 2.02, fo: 0.92, ro: 1.22, wheelR: 0.345, wheelW: 0.225,
    sill: 0.36, belt: 1.08, roof: 2.30, cabEnd: 0.62, noseDrop: 0.16,
    archR: 1.22, archTop: 1.60, weight: 0.10, mirrors: true, cladding: true, plateY: 0.50, vmax: 0.92,
  },
  truck: {
    id: 'truck', kind: 'truck', len: 8.60, wid: 2.48, fo: 1.15, ro: 1.45, wheelR: 0.505, wheelW: 0.285,
    cabZ: [1.05, 4.30], cabRoof: 3.05, boxZ: [-4.30, 0.72], boxTop: 3.62, boxBottom: 1.14,
    weight: 0.05, dualRear: true, vmax: 0.80,
  },
  bus: {
    id: 'bus', kind: 'bus', len: 11.80, wid: 2.55, fo: 2.35, ro: 2.95, wheelR: 0.505, wheelW: 0.285,
    roof: 3.12, floor: 0.60, winLo: 1.44, winHi: 2.42, doorsZ: [3.55, -1.55],
    weight: 0.03, dualRear: true, vmax: 0.78,
  },
};

export const VEHICLE_IDS = Object.keys(VEHICLE_SPECS);

/** Wheel z positions (axle centres). */
export function axlesOf(spec) {
  const front = spec.len * 0.5 - spec.fo;
  const rear = -spec.len * 0.5 + spec.ro;
  return [{ z: front, dual: false, steer: true }, { z: rear, dual: !!spec.dualRear, steer: false }];
}

// ---------------------------------------------------------------- car profile

function carProfile(spec) {
  const hz = spec.len * 0.5;
  const axles = axlesOf(spec);
  const archR = spec.wheelR * spec.archR;
  const archTop = spec.wheelR * spec.archTop;
  const hw0 = spec.wid * 0.5;
  const archY = (z) => {
    let m = 0;
    for (const a of axles) {
      const d = Math.abs(z - a.z) / archR;
      if (d < 1) m = Math.max(m, Math.sqrt(1 - d * d));
    }
    return spec.sill + (archTop - spec.sill) * m;
  };
  const halfw = (z) => {
    const tf = smooth(hz - 1.05, hz, z), tr = smooth(-hz + 1.05, -hz, z);
    return hw0 * (1 - 0.115 * tf * tf - 0.095 * tr * tr);
  };
  const beltAt = (z) => {
    if (z > spec.wsBase) return spec.belt + (spec.nose - spec.belt) * smooth(spec.wsBase, hz, z);
    if (z < spec.blBase) return spec.belt + (spec.tail - spec.belt) * smooth(spec.blBase, -hz, z);
    return spec.belt;
  };
  return { hz, axles, archR, archTop, hw0, archY, halfw, beltAt };
}

/** z sample list: evenly spaced + rows that pin the wheel arches and the belt kinks. */
function carSections(spec, pr, M, detail) {
  const { hz, axles, archR } = pr;
  const zs = [];
  for (let i = 0; i < M; i++) zs.push(-hz + spec.len * (i / (M - 1)));
  for (const a of axles) {
    if (detail) zs.push(a.z - archR + 0.012, a.z, a.z + archR - 0.012);
    else zs.push(a.z - archR + 0.02, a.z, a.z + archR - 0.02);
  }
  zs.push(spec.wsBase, spec.blBase);
  // panel shut lines — a row either side of each cut so the dark band stays a thin line
  if (detail) for (const c of doorCuts(spec)) zs.push(c - 0.030, c, c + 0.030);

  const out = zs.filter((z) => z >= -hz - 1e-4 && z <= hz + 1e-4).sort((a, b) => a - b);
  const uniq = [out[0]];
  for (let i = 1; i < out.length; i++) if (out[i] - uniq[uniq.length - 1] > 0.022) uniq.push(out[i]);
  uniq[uniq.length - 1] = hz;
  uniq[0] = -hz;
  return uniq;
}

/** z of the door / bonnet / boot cuts, so the flank is not one continuous smooth surface. */
function doorCuts(spec) {
  const zB = (spec.roofF + spec.roofR) * 0.5 + 0.34;
  const cuts = [spec.wsBase - 0.05, zB, spec.roofR - 0.16];
  return cuts.filter((z) => z > spec.blBase + 0.10 && z < spec.wsBase + 0.02);
}

function carShell(b, spec, res, M, detail) {
  const pr = carProfile(spec);
  const { hz, hw0, archY, halfw, beltAt } = pr;
  const zs = carSections(spec, pr, M, detail);
  // sharp shoulder along the cabin, rounded over the bonnet and boot
  const secs = zs.map((z) => {
    const endT = Math.max(smooth(spec.wsBase, hz, z), smooth(spec.blBase, -hz, z));
    return { z, hw: halfw(z), y0: archY(z), y1: beltAt(z), rt: hw0 * (0.085 + 0.30 * endT), rb: 0.15 * hw0 };
  });

  const lampY = spec.sill + (spec.belt - spec.sill) * 0.62;
  const tailY = spec.sill + (spec.belt - spec.sill) * 0.66;
  const bumperTop = spec.sill + (spec.belt - spec.sill) * 0.36;
  const cuts = detail ? doorCuts(spec) : [];

  b.loft(secs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      const ay = archY(z);
      // wheel-arch lip — a thin dark line right around the opening
      if (ay > spec.sill + 0.012 && y < ay + 0.052) return spec.cladding ? TRIM : ARCH;
      // rocker / sill
      if (y < spec.sill + 0.115) return spec.cladding ? TRIM : SHADOW;
      if (spec.cladding && y < spec.sill + 0.16) return TRIM;
      // bumpers
      if (y < bumperTop && (z > hz - 0.42 || z < -hz + 0.40)) return BUMPER;
      // door / bonnet / boot shut lines. Without them a lofted flank is one continuous surface and
      // the clearcoat highlight smears across it like an airbrush.
      if (detail && y > ay + 0.06) {
        if (Math.abs(nx) > 0.30) {
          for (let i = 0; i < cuts.length; i++) if (Math.abs(z - cuts[i]) < 0.008) return SHUT;
        }
        if (ny > 0.45 && (Math.abs(z - spec.wsBase) < 0.010 || Math.abs(z - spec.blBase) < 0.010)) return SHUT;
      }
      return y < spec.belt * 0.60 ? PAINT_L : PAINT;
    },
    capStyle: (x, y, z, nx, ny, nz) => {
      if (y < bumperTop) return BUMPER;
      if (nz > 0) {
        // radiator grille sits between the headlights
        if (Math.abs(x) < hw0 * 0.34 && y < lampY + 0.10) return GRILLE;
        return PAINT;
      }
      return PAINT;
    },
  });
  return { ...pr, lampY, tailY, bumperTop };
}

function carCanopy(b, spec, res, M, detail) {
  const pr = carProfile(spec);
  const { hw0, halfw } = pr;
  const z0 = spec.blBase, z1 = spec.wsBase;
  const roofY = (z) => {
    if (z >= spec.roofR && z <= spec.roofF) return spec.roof;
    if (z > spec.roofF) return spec.belt + 0.01 + (spec.roof - spec.belt - 0.01) * (1 - smooth(spec.roofF, z1, z));
    return spec.belt + 0.01 + (spec.roof - spec.belt - 0.01) * (1 - smooth(spec.roofR, z0, z));
  };
  const taper = (z) => {
    if (z > spec.roofF) return 0.955 - 0.16 * smooth(spec.roofF, z1, z);
    if (z < spec.roofR) return 0.955 - 0.16 * smooth(spec.roofR, z0, z);
    return 0.955;
  };
  const zs = [];
  for (let i = 0; i < M; i++) zs.push(z0 + (z1 - z0) * (i / (M - 1)));
  for (const k of [spec.roofF, spec.roofR, spec.roofF + 0.16, spec.roofR - 0.16]) if (k > z0 && k < z1) zs.push(k);
  zs.sort((a, b2) => a - b2);
  const uniq = [zs[0]];
  for (let i = 1; i < zs.length; i++) if (zs[i] - uniq[uniq.length - 1] > 0.03) uniq.push(zs[i]);

  const shoulder = 0.085 * hw0;
  const glassTop = spec.roof - 0.075;
  // rows pinned to the window rubber, the glass band and the roof edge
  const rows = detail
    ? [spec.belt + 0.020, spec.belt + 0.062,
      spec.belt + (glassTop - spec.belt) * 0.40, spec.belt + (glassTop - spec.belt) * 0.72, glassTop]
    : [spec.belt + 0.055, spec.belt + (glassTop - spec.belt) * 0.62];
  const secs = uniq.map((z) => ({
    z, hw: (halfw(z) - shoulder) * taper(z), y0: spec.belt - 0.13, y1: roofY(z),
    rt: 0.20 * hw0, rb: 0.030, ys: rows,
  }));
  const zB = (spec.roofF + spec.roofR) * 0.5 + 0.34;      // B-pillar
  b.loft(secs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      const tY = clamp01((y - spec.belt) / (spec.roof - spec.belt));
      if (y < spec.belt + 0.028) return PAINT;                            // shoulder, hidden in the body
      if (ny > 0.62 && y > glassTop - 0.012) return PAINT;                // roof panel
      // slanted A / C pillar boundaries: vertical at the roof, raked at the beltline
      const zA = spec.roofF + (z1 - spec.roofF) * (1 - tY) * 0.62;
      const zC = spec.roofR - (spec.roofR - z0) * (1 - tY) * 0.58;
      if (nz > 0.30 && z > spec.roofF - 0.02) return y > spec.belt + 0.062 ? GLASS : SEAL;   // windscreen
      if (nz < -0.30 && z < spec.roofR + 0.02) return y > spec.belt + 0.062 ? GLASS : SEAL;  // backlight
      if (Math.abs(nx) > 0.34) {
        if (z > zA || z < zC) return PAINT;                               // A / C pillar
        if (Math.abs(z - zB) < 0.055) return PAINT;                       // B-pillar
        if (y < spec.belt + 0.058) return SEAL;                           // window rubber
        return GLASS;
      }
      return PAINT;
    },
    capStyle: () => PAINT,
  });
}

function carDetails(b, spec, ctx, lod) {
  const { hz, hw0, halfw, lampY, tailY, bumperTop, archY } = ctx;
  const fhw = halfw(hz - 0.12), rhw = halfw(-hz + 0.12);
  const hl = { w: fhw * 0.50, h: (spec.belt - spec.sill) * 0.20 };
  // --- headlights: a lens box flush with the nose, indicator strip at its outer end
  for (const sx of [-1, 1]) {
    const cx = sx * (fhw - hl.w * 0.5 - 0.055);
    b.box(cx, lampY, hz - 0.085, hl.w, hl.h, 0.20, (f) => (f === 4 ? LAMP_F : TRIM));
    if (lod === 0) {
      b.box(sx * (fhw - 0.055), lampY - hl.h * 0.20, hz - 0.115, 0.055, hl.h * 0.55, 0.14,
        (f) => ((f === 4 || f === (sx > 0 ? 0 : 1)) ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
    }
  }
  // --- tail lights + rear indicator
  const tl = { w: rhw * 0.44, h: (spec.belt - spec.sill) * 0.26 };
  for (const sx of [-1, 1]) {
    const cx = sx * (rhw - tl.w * 0.5 - 0.045);
    b.box(cx, tailY, -hz + 0.075, tl.w, tl.h, 0.17, (f) => (f === 5 ? LAMP_R : TRIM));
    if (lod === 0) {
      b.box(sx * (rhw - 0.05), tailY - tl.h * 0.30, -hz + 0.10, 0.05, tl.h * 0.42, 0.12,
        (f) => ((f === 5 || f === (sx > 0 ? 0 : 1)) ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
    }
  }
  if (lod === 0) {
    // high-level brake light at the top of the backlight
    b.box(0, spec.roof - 0.10, spec.roofR - 0.055, hw0 * 0.46, 0.045, 0.07, (f) => (f === 5 ? LAMP_B : TRIM));
    // number plates
    b.box(0, spec.plateY, hz - 0.005, 0.48, 0.115, 0.03, (f) => (f === 4 ? PLATE : TRIM));
    b.box(0, spec.plateY + 0.10, -hz + 0.005, 0.48, 0.115, 0.03, (f) => (f === 5 ? PLATE : TRIM));
    // cabin floor / seats seen through the glass (and a faint glow at night)
    b.box(0, spec.belt - 0.06, (spec.roofF + spec.roofR) * 0.5, spec.wid * 0.74, 0.10, (spec.roofF - spec.roofR) + 0.9, CABIN);
    // door mirrors on the A-pillar base
    if (spec.mirrors) {
      const mz = spec.wsBase - 0.30, mhw = halfw(mz);
      for (const sx of [-1, 1]) {
        b.box(sx * (mhw + 0.045), spec.belt + 0.055, mz, 0.10, 0.055, 0.075, TRIM);
        b.box(sx * (mhw + 0.105), spec.belt + 0.075, mz - 0.02, 0.045, 0.105, 0.155,
          (f) => (f === (sx > 0 ? 0 : 1) ? CHROME : TRIM));
      }
    }
    // window belt strip + door handles
    const dz0 = spec.roofR + 0.10, dz1 = spec.roofF + 0.10;
    for (const sx of [-1, 1]) {
      const hwd = halfw((dz0 + dz1) * 0.5) - 0.012;
      b.box(sx * hwd, spec.belt - 0.012, (dz0 + dz1) * 0.5, 0.026, 0.030, (dz1 - dz0) * 0.92, CHROME);
      b.box(sx * hwd, spec.belt - 0.185, dz1 - 0.30, 0.032, 0.036, 0.155, CHROME);
      b.box(sx * hwd, spec.belt - 0.185, dz0 + 0.34, 0.032, 0.036, 0.155, CHROME);
    }
    // exhaust
    b.box(-hw0 * 0.52, spec.sill * 0.62, -hz + 0.03, 0.075, 0.075, 0.11, CHROME);
  }
  // inner wheel housings + underbody so the arches are not see-through
  if (lod === 0) {
    for (const ax of ctx.axles) {
      const top = archY(ax.z);
      b.box(0, (spec.sill * 0.30 + top) * 0.5, ax.z, spec.wid * 0.62, top - spec.sill * 0.30, spec.wheelR * 1.70, ARCH);
    }
  } else {
    b.box(0, (spec.sill * 0.30 + archY(ctx.axles[0].z)) * 0.5, 0, spec.wid * 0.62,
      archY(ctx.axles[0].z) - spec.sill * 0.30, spec.len * 0.80, ARCH);
    bakeWheels(b, spec, ctx.axles);
  }
  b.box(0, spec.sill * 0.52, 0, spec.wid * 0.84, 0.08, spec.len * 0.78, RUBBER);
}

/** Far LOD: static wheel blocks baked into the body so the fleet needs no wheel instances. */
function bakeWheels(b, spec, axles) {
  const TYRE = { color: lin(0x141619), metal: 0.0, rough: 0.90, cls: 5 };
  const hw = spec.wid * 0.5 - spec.wheelW * 0.5 - 0.012;
  for (const ax of axles) {
    for (const sx of [-1, 1]) {
      b.box(sx * hw, spec.wheelR, ax.z, spec.wheelW, spec.wheelR * 1.94, spec.wheelR * 1.94, TYRE);
    }
  }
}


/** A rear lamp cluster on a recessed dark panel: brake / indicator / reverse in one housing.
 *  Rear-facing only (−Z), so the housing is sunk towards +Z, *behind* the lenses. */
function lampCluster(b, cx, cy, cz, w, h, sx) {
  b.box(cx, cy, cz + 0.045, w * 1.22, h * 1.22, 0.07, TRIM);                       // housing surround
  b.box(cx, cy + h * 0.30, cz, w, h * 0.40, 0.06, (f) => (f === 5 ? LAMP_R : TRIM));
  b.box(cx, cy - h * 0.06, cz, w, h * 0.28, 0.06,
    (f) => (f === 5 ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
  b.box(cx, cy - h * 0.36, cz, w, h * 0.26, 0.06, (f) => (f === 5 ? LAMP_W : TRIM));
}

// ---------------------------------------------------------------- van

function vanShell(b, spec, res, M, lod) {
  const axles = axlesOf(spec);
  const hw0 = spec.wid * 0.5;
  const L = spec.len, hz = L * 0.5;
  const archR = spec.wheelR * spec.archR;
  const archTop = spec.wheelR * spec.archTop;
  const archY = (z) => {
    let m = 0;
    for (const a of axles) { const d = Math.abs(z - a.z) / archR; if (d < 1) m = Math.max(m, Math.sqrt(1 - d * d)); }
    return spec.sill + (archTop - spec.sill) * m;
  };
  const cabEnd = spec.cabEnd;
  const wsZ0 = cabEnd + 1.05;          // base of the windscreen
  const halfw = (z) => {
    const tf = smooth(hz - 0.75, hz, z), tr = smooth(-hz + 0.55, -hz, z);
    return hw0 * (1 - 0.14 * tf * tf - 0.045 * tr * tr);
  };
  const roofY = (z) => spec.roof - (spec.roof - spec.belt - 0.02) * smooth(wsZ0 + 0.10, hz - 0.10, z) - 0.09 * smooth(-hz * 0.90, -hz, z);
  const zs = [];
  for (let i = 0; i < M; i++) zs.push(-hz + L * (i / (M - 1)));
  for (const a of axles) zs.push(a.z - archR + 0.012, a.z - archR * 0.66, a.z, a.z + archR * 0.66, a.z + archR - 0.012);
  zs.push(wsZ0, cabEnd, hz - 0.14);
  zs.sort((a, b2) => a - b2);
  const uniq = [-hz];
  for (const z of zs) if (z > uniq[uniq.length - 1] + 0.025 && z < hz - 0.01) uniq.push(z);
  uniq.push(hz);
  const vrows = lod === 0
    ? [spec.belt + 0.02, spec.belt + 0.09, spec.belt + 0.42, spec.belt + 0.72, spec.belt + 0.80]
    : [spec.belt + 0.09, spec.belt + 0.72];
  const secs = uniq.map((z) => ({ z, hw: halfw(z), y0: archY(z), y1: roofY(z), rt: 0.24 * hw0, rb: 0.15 * hw0, ys: vrows }));
  b.loft(secs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      const ay = archY(z);
      if (ay > spec.sill + 0.012 && y < ay + 0.05) return TRIM;
      if (y < spec.sill + 0.05) return SHADOW;
      if (y < spec.sill + 0.20) return TRIM;
      if (y < spec.belt * 0.44 && (z > hz - 0.44 || z < -hz + 0.34)) return BUMPER;
      // windscreen: the raked front face above the bonnet line
      if (z > wsZ0 - 0.06 && y > spec.belt + 0.04 && nz > 0.22) return GLASS;
      // cab side windows
      if (z > cabEnd - 0.05 && z < wsZ0 + 0.20 && y > spec.belt + 0.08 && y < spec.belt + 0.75 && Math.abs(nx) > 0.5) return GLASS;
      // rear doors get a small window band
      if (z < -hz + 0.14 && nz < -0.4 && y > spec.roof - 1.05 && y < spec.roof - 0.42 && Math.abs(x) < hw0 * 0.78) return GLASS_DARK;
      if (y < spec.belt + 0.06 && y > spec.belt - 0.06) return TRIM;   // waist rub strip
      return y > spec.belt ? PAINT2 : PAINT;
    },
    capStyle: (x, y, z, nx, ny, nz) => {
      if (y < spec.belt * 0.44) return BUMPER;
      if (nz > 0 && Math.abs(x) < hw0 * 0.36 && y < spec.belt * 0.80) return GRILLE;
      if (nz > 0 && y > spec.belt + 0.04) return GLASS;
      return PAINT;
    },
  });
  const fhw = halfw(hz - 0.14);
  const lampY = spec.belt * 0.68;
  for (const sx of [-1, 1]) {
    b.box(sx * (fhw - fhw * 0.24 - 0.05), lampY, hz - 0.09, fhw * 0.44, 0.20, 0.19, (f) => (f === 4 ? LAMP_F : TRIM));
    b.box(sx * (fhw - 0.05), lampY - 0.09, hz - 0.12, 0.05, 0.11, 0.13,
      (f) => ((f === 4 || f === (sx > 0 ? 0 : 1)) ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
    lampCluster(b, sx * hw0 * 0.78, spec.roof - 1.20, -hz + 0.005, hw0 * 0.24, 0.86, sx);
    b.box(sx * hw0 * 0.48, spec.belt * 0.42, -hz + 0.005, 0.12, 0.09, 0.05, REFLECT);
  }
  b.box(0, spec.plateY, hz + 0.005, 0.48, 0.115, 0.03, (f) => (f === 4 ? PLATE : TRIM));
  // rear doors: centre seam, handles, plate, step bumper
  b.box(0, (spec.sill + spec.roof) * 0.5, -hz - 0.008, 0.05, spec.roof - spec.sill - 0.35, 0.04, TRIM);
  b.box(0, spec.plateY + 0.02, -hz - 0.020, 0.50, 0.125, 0.03, (f) => (f === 5 ? PLATE : TRIM));
  b.box(0, spec.sill + 0.14, -hz - 0.045, spec.wid * 0.80, 0.17, 0.10, BUMPER);
  if (lod === 0) {
    for (const sx of [-1, 1]) b.box(sx * 0.13, spec.belt + 0.10, -hz - 0.030, 0.045, 0.05, 0.16, CHROME);
    for (const sx of [-1, 1]) {
      b.box(sx * (halfw(wsZ0) + 0.075), spec.belt + 0.36, wsZ0 - 0.06, 0.10, 0.24, 0.085, TRIM);
      b.box(sx * (halfw(cabEnd + 0.30) - 0.012), spec.belt + 0.02, cabEnd + 0.30, 0.032, 0.036, 0.155, CHROME);
      // sliding-door seams and a waist crease: the van flank was one blank white panel
      const sdz = cabEnd + 0.62;
      b.box(sx * (halfw(sdz) - 0.004), (spec.belt + spec.roof) * 0.5 - 0.10, sdz, 0.014, spec.roof - spec.belt - 0.42, 0.022, SEAL);
      b.box(sx * (halfw(-1.2) - 0.004), (spec.belt + spec.roof) * 0.5 - 0.10, -1.2, 0.014, spec.roof - spec.belt - 0.42, 0.022, SEAL);
      b.box(sx * (halfw(-hz + 0.30) - 0.004), (spec.belt + spec.roof) * 0.5 - 0.10, -hz + 0.30, 0.014, spec.roof - spec.belt - 0.42, 0.022, SEAL);
      b.box(sx * (halfw(-0.3) - 0.006), spec.belt + 0.62, -0.3, 0.020, 0.030, spec.len * 0.52, SEAL);
    }
    b.box(0, spec.roof + 0.035, -hz * 0.30, hw0 * 0.66, 0.07, 0.5, TRIM);
  }
  b.box(0, spec.sill * 0.50, 0, spec.wid * 0.84, 0.06, spec.len * 0.82, RUBBER);
  b.box(0, spec.belt + 0.28, cabEnd + 0.55, spec.wid * 0.80, 0.56, 1.10, CABIN);   // cab interior
  if (lod === 0) {
    for (const ax of axles) {
      const top = archY(ax.z);
      b.box(0, (spec.sill * 0.30 + top) * 0.5, ax.z, spec.wid * 0.66, top - spec.sill * 0.30, spec.wheelR * 2.0, ARCH);
    }
  } else bakeWheels(b, spec, axles);
  return { axles, sillBase: spec.sill, hw0, hz };
}

// ---------------------------------------------------------------- truck

function truckShell(b, spec, res, M, lod) {
  const axles = axlesOf(spec);
  const hw0 = spec.wid * 0.5;
  const hz = spec.len * 0.5;
  const sillBase = spec.wheelR * 0.86;
  const [cz0, cz1] = spec.cabZ;
  const [bz0, bz1] = spec.boxZ;
  // --- cab
  const cabSecs = [];
  const CM = Math.max(8, Math.round(M * 0.8));
  const archR = spec.wheelR * 1.32, archTop = spec.wheelR * 2.05, skirt = sillBase * 0.52;
  const archY = (z) => {
    const d = Math.abs(z - axles[0].z) / archR;
    return d < 1 ? skirt + (archTop - skirt) * Math.sqrt(1 - d * d) : skirt;
  };
  const rows = [1.02, 1.58, 1.64, 2.30];
  const zks = [];
  for (let i = 0; i < CM; i++) zks.push(cz0 + (cz1 - cz0) * (i / (CM - 1)));
  zks.push(axles[0].z - archR + 0.02, axles[0].z, axles[0].z + archR - 0.02);
  zks.sort((a, b2) => a - b2);
  const cu = [cz0];
  for (const z of zks) if (z > cu[cu.length - 1] + 0.04 && z < cz1 - 0.02) cu.push(z);
  cu.push(cz1);
  for (const z of cu) {
    const t = (z - cz0) / (cz1 - cz0);
    const hw = hw0 * (1 - 0.09 * smooth(0.78, 1.0, t) * smooth(0.78, 1.0, t));
    const roof = spec.cabRoof - 0.50 * smooth(0.82, 1.0, t);
    cabSecs.push({ z, hw, y0: archY(z), y1: roof, rt: 0.30, rb: 0.18, ys: rows });
  }
  const wsT = 0.72;
  b.loft(cabSecs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      const t = (z - cz0) / (cz1 - cz0);
      const ay = archY(z);
      if (ay > skirt + 0.02 && y < ay + 0.06) return ARCH;
      if (y < skirt + 0.10) return SHADOW;
      if (y < 1.05 && t > 0.86) return BUMPER;
      if (nz > 0.30 && t > wsT && y > 1.60 && y < spec.cabRoof - 0.16) return GLASS;
      if (Math.abs(nx) > 0.55 && t > 0.34 && y > 1.64 && y < spec.cabRoof - 0.28) return GLASS;
      if (nz > 0.4 && y > 1.05 && y < 1.58 && Math.abs(x) < hw0 * 0.7) return GRILLE;
      return PAINT;
    },
    capStyle: (x, y, z, nx, ny, nz) => (y < 1.05 ? BUMPER : (nz > 0 && y > 1.62 ? GLASS : PAINT)),
  });
  // --- cargo box
  const boxSecs = [];
  for (let i = 0; i < 4; i++) {
    const z = bz0 + (bz1 - bz0) * (i / 3);
    boxSecs.push({ z, hw: hw0 * 0.995, y0: spec.boxBottom, y1: spec.boxTop, rt: 0.13, rb: 0.05 });
  }
  b.loft(boxSecs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      if (y < spec.boxBottom + 0.15) return TRIM;
      if (ny > 0.6) return CARGO_RIB;
      return PAINT2;
    },
    capStyle: (x, y, z, nx, ny, nz) => (nz < 0 ? CARGO_RIB : PAINT2),
  });
  b.box(0, spec.boxBottom - 0.28, (bz0 + bz1) * 0.5, spec.wid * 0.76, 0.34, (bz1 - bz0) * 0.96, RUBBER);
  b.box(0, spec.boxTop - 0.02, cz1 - 0.35, hw0 * 1.3, 0.30, 0.55, PAINT);  // roof deflector
  for (const sx of [-1, 1]) {
    b.box(sx * hw0 * 0.68, 1.02, cz1 + 0.03, hw0 * 0.34, 0.25, 0.15, (f) => (f === 4 ? LAMP_F : TRIM));
    b.box(sx * hw0 * 0.92, 1.02, cz1 + 0.02, 0.055, 0.18, 0.13,
      (f) => ((f === 4 || f === (sx > 0 ? 0 : 1)) ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
    lampCluster(b, sx * hw0 * 0.74, spec.boxBottom - 0.44, bz0 - 0.045, hw0 * 0.26, 0.74, sx);
    b.box(sx * hw0 * 0.44, spec.boxBottom - 0.88, bz0 - 0.045, 0.13, 0.10, 0.05, REFLECT);
    if (lod === 0) {
      b.box(sx * (hw0 + 0.10), 2.32, cz1 - 0.32, 0.12, 0.44, 0.10, TRIM);   // mirrors
      b.box(sx * hw0 * 0.62, spec.cabRoof + 0.12, cz1 - 1.35, 0.11, 0.24, 0.11, CHROME);  // stacks
    }
  }
  b.box(0, 0.72, cz1 + 0.12, spec.wid * 0.92, 0.36, 0.22, BUMPER);  // front bumper
  b.box(0, spec.plateY || 0.72, cz1 + 0.24, 0.48, 0.115, 0.03, (f) => (f === 4 ? PLATE : TRIM));
  // rear of the cargo box: doors, hinges, underrun bar, plate and mud flaps
  b.box(0, (spec.boxBottom + spec.boxTop) * 0.5, bz0 - 0.020, 0.055, spec.boxTop - spec.boxBottom - 0.16, 0.04, TRIM);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.box(sx * (hw0 * 0.94), spec.boxBottom + 0.35 + i * 0.85, bz0 - 0.020, 0.10, 0.16, 0.05, TRIM);
    }
    b.box(sx * 0.14, (spec.boxBottom + spec.boxTop) * 0.5 - 0.30, bz0 - 0.055, 0.05, 0.85, 0.05, TRIM);   // door bars
    if (lod === 0) b.box(sx * hw0 * 0.72, spec.wheelR * 0.55, bz0 + 0.55, 0.02, spec.wheelR * 1.1, 0.34, RUBBER);
  }
  b.box(0, spec.boxBottom - 0.70, bz0 - 0.06, spec.wid * 0.86, 0.16, 0.10, BUMPER);   // rear underrun bar
  b.box(hw0 * 0.20, spec.boxBottom - 0.90, bz0 - 0.06, 0.50, 0.12, 0.03, (f) => (f === 5 ? PLATE : TRIM));
  if (lod !== 0) bakeWheels(b, spec, axles);
  return { axles, sillBase, hw0, hz };
}

// ---------------------------------------------------------------- bus

function busShell(b, spec, res, M, lod) {
  const axles = axlesOf(spec);
  const hw0 = spec.wid * 0.5;
  const L = spec.len, hz = L * 0.5;
  const skirt = 0.34;
  const archR = spec.wheelR * 1.34, archTop = spec.wheelR * 2.12;
  const archY = (z) => {
    let m = 0;
    for (const a of axles) { const d = Math.abs(z - a.z) / archR; if (d < 1) m = Math.max(m, Math.sqrt(1 - d * d)); }
    return skirt + (archTop - skirt) * m;
  };
  // rows pinned to the skirt line and both edges of the window band
  const rows = lod === 0
    ? [spec.floor + 0.02, spec.winLo - 0.03, spec.winLo + 0.03,
      (spec.winLo + spec.winHi) * 0.5, spec.winHi - 0.03, spec.winHi + 0.03]
    : [spec.winLo + 0.03, spec.winHi - 0.03];
  const zs = [];
  for (let i = 0; i < M; i++) zs.push(-hz + L * (i / (M - 1)));
  for (const a of axles) {
    if (lod === 0) zs.push(a.z - archR + 0.02, a.z - archR * 0.6, a.z, a.z + archR * 0.6, a.z + archR - 0.02);
    else zs.push(a.z - archR + 0.03, a.z, a.z + archR - 0.03);
  }
  if (lod === 0) for (const dz of spec.doorsZ) zs.push(dz - 0.56, dz - 0.48, dz + 0.48, dz + 0.56);
  zs.sort((a, b2) => a - b2);
  const uniq = [-hz];
  for (const z of zs) if (z > uniq[uniq.length - 1] + 0.03 && z < hz - 0.02) uniq.push(z);
  uniq.push(hz);
  const secs = uniq.map((z) => {
    const tf = smooth(hz - 0.9, hz, z), tr = smooth(-hz + 0.9, -hz, z);
    const hw = hw0 * (1 - 0.055 * tf * tf - 0.05 * tr * tr);
    const roof = spec.roof - 0.14 * tf * tf - 0.10 * tr * tr;
    return { z, hw, y0: archY(z), y1: roof, rt: 0.30, rb: 0.16, ys: rows };
  });
  const isDoor = (z) => { for (const dz of spec.doorsZ) if (Math.abs(z - dz) < 0.52) return true; return false; };
  const pillarAt = (z) => { const p = ((z + hz) / 1.72) % 1; return p < 0.085 || p > 0.945; };
  b.loft(secs, {
    res,
    style: (x, y, z, nx, ny, nz) => {
      const ay = archY(z);
      if (ay > skirt + 0.02 && y < ay + 0.06) return ARCH;
      if (y < spec.floor) return SHADOW;                                   // skirt
      if (y < spec.winLo - 0.03 && (z > hz - 0.62 || z < -hz + 0.5)) return BUMPER;
      if (Math.abs(nx) > 0.5 && isDoor(z) && y > spec.floor + 0.06 && y < spec.winHi) return GLASS_BUS_D;
      if (nz > 0.35 && z > hz - 0.62 && y > spec.winLo - 0.30 && y < spec.winHi + 0.24) return GLASS_BUS;
      if (nz < -0.35 && z < -hz + 0.52 && y > spec.winLo && y < spec.winHi) return GLASS_BUS;
      if (Math.abs(nx) > 0.5 && y > spec.winLo && y < spec.winHi && z < hz - 0.62 && z > -hz + 0.5 && !pillarAt(z)) return GLASS_BUS;
      // livery: a second-colour band under the window line so a fleet is not six white slabs
      if (y > spec.floor + 0.12 && y < spec.winLo - 0.16) return PAINT2;
      return PAINT;
    },
    capStyle: (x, y, z, nx, ny, nz) => (y < spec.winLo - 0.20 ? BUMPER : PAINT),
  });
  // windscreen and rear window as flat panels on the end caps
  b.box(0, (spec.winLo + spec.winHi) * 0.5 + 0.08, hz - 0.018, hw0 * 1.72, spec.winHi - spec.winLo + 0.46, 0.07,
    (f) => (f === 4 ? GLASS : TRIM));
  b.box(0, (spec.winLo + spec.winHi) * 0.5, -hz + 0.018, hw0 * 1.55, spec.winHi - spec.winLo - 0.12, 0.07,
    (f) => (f === 5 ? GLASS_BUS : TRIM));
  for (const sx of [-1, 1]) {
    b.box(sx * hw0 * 0.62, spec.floor + 0.20, hz - 0.08, hw0 * 0.34, 0.22, 0.16, (f) => (f === 4 ? LAMP_F : TRIM));
    b.box(sx * hw0 * 0.90, spec.floor + 0.20, hz - 0.10, 0.055, 0.17, 0.13,
      (f) => ((f === 4 || f === (sx > 0 ? 0 : 1)) ? (sx > 0 ? LAMP_IL : LAMP_IR) : TRIM));
    // full rear cluster — the old bus showed a bare grey slab with two dots
    lampCluster(b, sx * hw0 * 0.66, spec.winLo - 0.60, -hz - 0.010, hw0 * 0.30, 0.86, sx);
    b.box(sx * hw0 * 0.90, spec.floor + 0.10, -hz - 0.010, 0.11, 0.11, 0.05, REFLECT);
    if (lod === 0) b.box(sx * (hw0 + 0.09), spec.winHi - 0.18, hz - 0.40, 0.12, 0.36, 0.09, TRIM);
  }
  // rear apron: engine louvres, bumper bar, plate and a hatch seam
  b.box(0, spec.floor + 0.30, -hz - 0.012, hw0 * 1.10, 0.44, 0.05, LOUVRE);
  for (let i = 0; i < 3; i++) {
    b.box(0, spec.floor + 0.16 + i * 0.14, -hz - 0.038, hw0 * 1.12, 0.045, 0.03, TRIM);
  }
  b.box(0, spec.floor - 0.06, -hz - 0.040, spec.wid * 0.96, 0.26, 0.14, BUMPER);
  b.box(hw0 * 0.34, spec.winLo - 0.30, -hz - 0.030, 0.52, 0.125, 0.03, (f) => (f === 5 ? PLATE : TRIM));
  if (lod === 0) {
    b.box(0, spec.winHi + 0.06, -hz - 0.012, hw0 * 1.50, 0.05, 0.04, TRIM);        // hatch seam, top
    b.box(0, spec.winLo - 0.14, -hz - 0.012, hw0 * 1.50, 0.05, 0.04, TRIM);        // hatch seam, bottom
    b.box(0, spec.winLo + 0.14, -hz - 0.055, 0.035, 0.60, 0.035, TRIM);            // rear wiper
    b.box(0, spec.roof + 0.02, -hz + 0.30, hw0 * 0.5, 0.10, 0.30, TRIM);           // rear roof vent
  }
  // Interior: without it the glass is a void and the bus reads as a black hole at night. A dull
  // panel behind the windows, a row of seat backs and a ceiling strip that lights up after dark.
  b.box(0, (spec.winLo + spec.winHi) * 0.5, 0, hw0 * 1.45, spec.winHi - spec.winLo, L * 0.94,
    { color: lin(0x565c62), metal: 0.0, rough: 0.85 });
  if (lod === 0) {
    for (let i = -3; i <= 3; i++) {
      b.box(0, spec.winLo + 0.24, i * 1.3, hw0 * 1.5, 0.42, 0.14, { color: lin(0x2f4258), metal: 0, rough: 0.85 });
    }
  }
  b.box(0, spec.winHi - 0.05, 0, hw0 * 1.4, 0.06, L * 0.80, { color: lin(0xf4e8cf), metal: 0, rough: 0.7, light: 4 });
  if (lod === 0) b.box(0, spec.roof + 0.07, -hz * 0.22, hw0 * 0.9, 0.16, 1.6, TRIM);   // roof HVAC
  b.box(0, spec.floor * 0.44, 0, spec.wid * 0.86, 0.08, L * 0.86, RUBBER);
  if (lod !== 0) bakeWheels(b, spec, axles);
  return { axles, sillBase: skirt, hw0, hz };
}

// ---------------------------------------------------------------- public builders

const RES = [{ nb: 2, ns: 3, nt: 3 }, { nb: 1, ns: 1, nt: 1 }];
const SECTIONS = [11, 5];

export function buildVehicleGeometry(id, lod = 0) {
  const spec = VEHICLE_SPECS[id];
  const b = new MeshBuilder();
  const res = RES[lod], M = SECTIONS[lod];
  if (spec.kind === 'car') {
    const ctx = carShell(b, spec, res, M, lod === 0);
    carCanopy(b, spec, res, lod === 0 ? 9 : 4, lod === 0);
    carDetails(b, spec, ctx, lod);
  } else if (spec.kind === 'box') {
    vanShell(b, spec, res, M + 1, lod);
  } else if (spec.kind === 'truck') {
    truckShell(b, spec, res, M, lod);
  } else {
    busShell(b, spec, res, M + 2, lod);
  }
  return b.geometry();
}

/** Unit wheel: radius 1 in the YZ plane, width 1 along X, spins about +X.
 *
 *  A car wheel is the part a street-level camera is closest to, so this is not a disc: the tyre has
 *  a crowned tread band with shoulder chamfers and a lettered sidewall step, and the face carries a
 *  recessed alloy — five spokes standing proud of a dark barrel with a brake disc and caliper
 *  visible through the gaps, a rim flange and a centre cap. Only the near LOD uses it.
 */
/**
 * A 24-triangle stand-in used ONLY in the shadow cascades.
 *
 * Every visible vehicle has to throw a sun shadow — the p4 critic found the whole fleet casting
 * none past 50 m — but pushing the real far-LOD shell through four cascades costs ~2 M triangles
 * a frame. This derives a two-box silhouette (body + greenhouse) from the shell's own bounding
 * box, which at 50 m+ is indistinguishable from the real shadow and costs ~0.4% of it.
 */
export function buildShadowProxyGeometry(src) {
  src.computeBoundingBox();
  const bb = src.boundingBox;
  const w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y, l = bb.max.z - bb.min.z;
  const cx = (bb.max.x + bb.min.x) * 0.5, cz = (bb.max.z + bb.min.z) * 0.5;
  const belt = bb.min.y + h * 0.56;
  // Deliberately a touch fatter and taller than the shell. The cascades apply a normal bias of
  // ~1.9 texels, which at 100 m+ erodes the shadow of anything as low as a car until it vanishes;
  // padding the caster keeps a readable footprint on the road after that erosion.
  const top = bb.max.y + h * 0.12;
  const st = { color: [0, 0, 0], metal: 0, rough: 1 };
  const b = new MeshBuilder();
  b.box(cx, (bb.min.y + belt) * 0.5, cz, w * 1.06, belt - bb.min.y, l * 1.02, st);
  b.box(cx, (belt + top) * 0.5, cz - l * 0.06, w * 0.90, top - belt, l * 0.58, st);
  const g = b.geometry();
  g.deleteAttribute('color'); g.deleteAttribute('aSurf');
  g.deleteAttribute('aLight'); g.deleteAttribute('aClass'); g.deleteAttribute('normal');
  return g;
}

export function buildWheelGeometry(lod = 0) {
  const b = new MeshBuilder();
  const sides = lod === 0 ? 14 : 8;
  const tread = { color: lin(0x121417), metal: 0.0, rough: 0.90, cls: 5 };
  const tyre = { color: lin(0x16191d), metal: 0.0, rough: 0.90, cls: 5 };
  const wall = { color: lin(0x1c2025), metal: 0.0, rough: 0.90, cls: 5 };
  const rim = { color: lin(0xc6ccd2), metal: 1.0, rough: 0.15, cls: 4 };
  const spoke = { color: lin(0xb8c0c7), metal: 1.0, rough: 0.15, cls: 4 };
  const hub = { color: lin(0x6c737a), metal: 1.0, rough: 0.28, cls: 4 };
  const disc = { color: lin(0x44484c), metal: 1.0, rough: 0.35, cls: 4 };
  const barrel = { color: lin(0x0a0b0d), metal: 0.10, rough: 0.80 };
  const cal = { color: lin(0x6d2320), metal: 0.35, rough: 0.45 };

  const ring = (x, r, st, nx, ny) => {
    const ids = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      ids.push(b.vert(x, c * r, sn * r, nx, ny * c, ny * sn, st));
    }
    return ids;
  };
  const band = (A, B, flip) => {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (flip) b.quad(A[j], B[j], B[i], A[i]); else b.quad(A[i], B[i], B[j], A[j]);
    }
  };
  const wx = 0.5;
  if (lod === 0) {
    // --- tyre: shoulder chamfer, crowned tread, shoulder chamfer
    const rShoulder = 0.955, rTread = 1.0;
    const shL = ring(-wx, rShoulder, tyre, 0, 1), trL = ring(-wx * 0.80, rTread, tread, 0, 1);
    const trR = ring(wx * 0.80, rTread, tread, 0, 1), shR = ring(wx, rShoulder, tyre, 0, 1);
    band(shL, trL, false); band(trL, trR, false); band(trR, shR, false);
    for (const sx of [-1, 1]) {
      const x = sx * wx, nx = sx;
      // sidewall: shoulder -> lettering step -> bead
      const s1 = ring(x, rShoulder, tyre, nx, 0);
      const s2 = ring(x, 0.80, wall, nx, 0);
      const s3 = ring(x, 0.635, tyre, nx, 0);
      if (sx > 0) { band(s1, s2, true); band(s2, s3, true); }
      else { band(s1, s2, false); band(s2, s3, false); }
      // rim flange, then the dark barrel dropping back into the wheel
      const f1 = ring(x, 0.635, rim, nx, 0);
      const f2 = ring(x, 0.575, rim, nx, 0);
      const b1 = ring(x - sx * 0.13, 0.42, barrel, nx, 0);
      if (sx > 0) { band(f1, f2, true); band(f2, b1, true); }
      else { band(f1, f2, false); band(f2, b1, false); }
      // brake disc + caliper sitting behind the spokes
      const d1 = ring(x - sx * 0.15, 0.50, disc, nx, 0);
      const d2 = ring(x - sx * 0.15, 0.22, disc, nx, 0);
      if (sx > 0) band(d1, d2, true); else band(d1, d2, false);
      b.box(x - sx * 0.20, 0.40, 0.0, 0.10, 0.30, 0.16, cal);
      // five spokes standing proud of the barrel
      const NS = 5;
      for (let k = 0; k < NS; k++) {
        const a0 = (k / NS) * Math.PI * 2 + 0.25, w0 = 0.30, w1 = 0.145;
        const px = x - sx * 0.035;
        const p = (r, da) => b.vert(px, Math.cos(a0 + da) * r, Math.sin(a0 + da) * r, nx, 0, 0, spoke);
        const i0 = p(0.20, -w0), i1 = p(0.20, w0), o1 = p(0.565, w1), o0 = p(0.565, -w1);
        if (sx > 0) b.quad(i0, o0, o1, i1); else b.quad(i1, o1, o0, i0);
      }
      // centre cap
      const c1 = ring(x - sx * 0.02, 0.205, hub, nx, 0);
      const cc = b.vert(x + sx * 0.012, 0, 0, nx, 0, 0, hub);
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        if (sx > 0) b.tri(cc, c1[i], c1[j]); else b.tri(cc, c1[j], c1[i]);
      }
    }
  } else {
    b.tube(-0.5, 0.5, 1, 1, sides, tyre);
    for (const sx of [-1, 1]) {
      const x = sx * 0.5, nx = sx;
      const rings = [[0, 0.52, rim], [0.52, 1.0, wall]];
      for (const [r0, r1, st] of rings) {
        const inner = [], outer = [];
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          const c = Math.cos(a), sn = Math.sin(a);
          if (r0 > 0) inner.push(b.vert(x, c * r0, sn * r0, nx, 0, 0, st));
          outer.push(b.vert(x, c * r1, sn * r1, nx, 0, 0, st));
        }
        if (r0 === 0) {
          const c0 = b.vert(x, 0, 0, nx, 0, 0, st);
          for (let i = 0; i < sides; i++) {
            const j = (i + 1) % sides;
            if (sx > 0) b.tri(c0, outer[i], outer[j]); else b.tri(c0, outer[j], outer[i]);
          }
        } else {
          for (let i = 0; i < sides; i++) {
            const j = (i + 1) % sides;
            if (sx > 0) b.quad(inner[i], outer[i], outer[j], inner[j]);
            else b.quad(inner[j], outer[j], outer[i], inner[i]);
          }
        }
      }
    }
  }
  return b.geometry();
}
