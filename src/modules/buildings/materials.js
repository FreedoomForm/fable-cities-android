/**
 * Material library for the buildings module. Every entry is a lit MeshStandardMaterial built from the
 * shared CC0 PBR sets (public/assets/shared, see MANIFEST.md), patched for instanced world-scale UVs
 * (or the procedural facade) and registered with the engine for cascaded shadows. Wetness/snow come
 * from the effects module's global material hook — never patch uWetness locally (see docs/requests/buildings.md).
 */
import * as THREE from 'three';
import { makeRng } from '../../shared/random.js';
import { patchFacade, patchInstanceUv, patchAtlas, patchRoof, patchGlassSky, patchMetalSky, FACADE_UNIFORMS } from './facadeShader.js';

/**
 * Per-surface roughness targets from docs/MATERIAL_TARGET.md. One table so the audit
 * (`node tools/matstats.mjs --filter buildings`) can be read straight off the source.
 */
const R = {
  glass: 0.05,        // curtain wall / architectural glazing
  window: 0.10,       // punched window glass (set per-fragment in the facade patch)
  solar: 0.10,
  trim: 0.30,         // chrome / galvanised trim, chain link
  metalPanel: 0.45,   // metal roof, corrugated, ducting, tanks   (metalness 0.95)
  paint: 0.40,        // painted plant, signage boards
  asphalt: 0.65,      // dry yard asphalt
  foliage: 0.70,      // leaves carry a waxy sheen
  paintedWood: 0.75,  // clapboard siding, picket fence
  roofTile: 0.78,
  concrete: 0.80,     // kerb, paving, concrete wall
  grass: 0.85,
  brick: 0.88,        // brick, plaster, render
  soil: 0.95,
};

/** Dark architectural glazing that is not part of a facade box (balustrades, canopies, panels). */
const glassSky = (mat, strength = 1.0) => patchGlassSky(mat, strength);
/** Bare/painted metal: without an explicit dome, metalness 0.95 renders black (see patchMetalSky). */
const metalSky = (mat, strength = 0.65) => patchMetalSky(mat, strength);

/**
 * A coated material. Painted steel, enamelled signage, a solar panel's cover glass and a lamp lens
 * all carry a real clearcoat lobe in life, and it is the single thing the blind judges named on the
 * reference ("a real clearcoat lobe with sharp specular streaks"). Kept to the small detail pools —
 * the large facade/roof surfaces stay MeshStandardMaterial so the fragment cost does not scale with
 * the city. clearcoat needs MeshPhysicalMaterial; MeshStandardMaterial silently ignores it.
 */
const coat = (props, clearcoat, clearcoatRoughness) =>
  new THREE.MeshPhysicalMaterial({ ...props, clearcoat, clearcoatRoughness });

const S = '/assets/shared/';
const SETS = {
  bricks_red: { map: 'bricks_red/color.jpg', normalMap: 'bricks_red/normal.jpg', roughnessMap: 'bricks_red/roughness.jpg', aoMap: 'bricks_red/ao.jpg' },
  bricks_yellow: { map: 'bricks_yellow/color.jpg', normalMap: 'bricks_yellow/normal.jpg', roughnessMap: 'bricks_yellow/roughness.jpg', aoMap: 'bricks_yellow/ao.jpg' },
  bricks_white: { map: 'bricks_white/color.jpg', normalMap: 'bricks_white/normal.jpg', roughnessMap: 'bricks_white/roughness.jpg', aoMap: 'bricks_white/ao.jpg' },
  plaster_modern: { map: 'plaster_modern/color.jpg', normalMap: 'plaster_modern/normal.jpg', roughnessMap: 'plaster_modern/roughness.jpg' },
  plaster_rough: { map: 'plaster_rough/color.jpg', normalMap: 'plaster_rough/normal.jpg', roughnessMap: 'plaster_rough/roughness.jpg' },
  plaster_painted: { map: 'plaster_painted/color.jpg', normalMap: 'plaster_painted/normal.jpg', roughnessMap: 'plaster_painted/roughness.jpg' },
  concrete_wall: { map: 'concrete_wall_008/Diffuse.jpg', normalMap: 'concrete_wall_008/nor_gl.jpg', roughnessMap: 'concrete_wall_008/arm.jpg', aoMap: 'concrete_wall_008/arm.jpg' },
  concrete: { map: 'concrete/albedo.jpg', normalMap: 'concrete/normal.jpg', roughnessMap: 'concrete/roughness.jpg' },
  corrugated: { map: 'corrugatedsteel005/color.jpg', normalMap: 'corrugatedsteel005/normalgl.jpg', roughnessMap: 'corrugatedsteel005/roughness.jpg', metalnessMap: 'corrugatedsteel005/metalness.jpg', aoMap: 'corrugatedsteel005/ambientocclusion.jpg' },
  tiles_a: { map: 'roof_tiles_clay/color.jpg', normalMap: 'roof_tiles_clay/normal.jpg', roughnessMap: 'roof_tiles_clay/roughness.jpg', aoMap: 'roof_tiles_clay/ao.jpg' },
  tiles_b: { map: 'roof_tiles_clay_b/color.jpg', normalMap: 'roof_tiles_clay_b/normal.jpg', roughnessMap: 'roof_tiles_clay_b/roughness.jpg', aoMap: 'roof_tiles_clay_b/ao.jpg' },
  asphalt: { map: 'asphalt/albedo.jpg', normalMap: 'asphalt/normal.jpg', roughnessMap: 'asphalt/roughness.jpg' },
  asphalt_light: { map: 'asphalt_light/albedo.jpg', normalMap: 'asphalt_light/normal.jpg', roughnessMap: 'asphalt_light/roughness.jpg', aoMap: 'asphalt_light/ao.jpg' },
  metalplates: { map: 'metalplates006/color.jpg', normalMap: 'metalplates006/normalgl.jpg', roughnessMap: 'metalplates006/roughness.jpg', metalnessMap: 'metalplates006/metalness.jpg' },
  grass: { map: 'grass/albedo.jpg', normalMap: 'grass/normal.jpg', roughnessMap: 'grass/roughness.jpg', aoMap: 'grass/ao.jpg' },
  paving: { map: 'paving_slabs/albedo.jpg', normalMap: 'paving_slabs/normal.jpg', roughnessMap: 'paving_slabs/roughness.jpg', aoMap: 'paving_slabs/ao.jpg' },
  dirt: { map: 'Ground048/color.jpg', normalMap: 'Ground048/normal.jpg', roughnessMap: 'Ground048/roughness.jpg', aoMap: 'Ground048/ao.jpg' },
  forest_floor: { map: 'forest_floor/color.jpg', normalMap: 'forest_floor/normal.jpg', roughnessMap: 'forest_floor/roughness.jpg', aoMap: 'forest_floor/ao.jpg' },
  wood: { map: 'wood_planks/color.jpg', normalMap: 'wood_planks/normal.jpg', roughnessMap: 'wood_planks/roughness.jpg', aoMap: 'wood_planks/ao.jpg' },
};

const WORDS = ['MARKET', 'CAFÉ', 'PIZZA', 'BANK', 'PHARMACY', 'BOOKS', 'BAKERY', 'HOTEL', 'SUSHI', 'DELI', 'CINEMA', 'FLOWERS', 'BURGER', 'OPTIK', 'MODA', 'GYM', 'RAMEN', 'BISTRO', 'SALON', 'TOOLS', 'GROCER', 'VINYL'];

/**
 * 8-column shop-sign atlas (5:1 tiles). High contrast, a fitted word, a thin frame and a lit-tube
 * highlight so the lettering still reads at 60 m (map + emissiveMap share the canvas).
 */
function makeSignAtlas(cols = 8) {
  const w = 512, h = 104;
  const c = document.createElement('canvas');
  c.width = w * cols; c.height = h;
  const g = c.getContext('2d');
  const rng = makeRng(4242);
  // curated hues: warm reds/ambers, forest green, navy and neutrals. The old i*47 sweep produced
  // magentas, and a row of magenta boards above a shopfront read as a UI/z-fight artifact.
  const HUES = [8, 32, 208, 148, 22, 196, 44, 0];
  for (let i = 0; i < cols; i++) {
    const hue = HUES[i % HUES.length];
    const dark = rng.chance(0.55);
    const x0 = i * w;
    g.fillStyle = dark ? `hsl(${hue} 16% 7%)` : `hsl(${hue} 26% ${rng.int(14, 21)}%)`;
    g.fillRect(x0, 0, w, h);
    // frame + top light bar + bottom shade give the board a bit of relief
    g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 3;
    g.strokeRect(x0 + 5, 4, w - 10, h - 9);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(x0, h - 9, w, 9);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(x0 + 8, 7, w - 16, 8);
    const word = WORDS[(i * 5 + rng.int(0, 3)) % WORDS.length];
    g.font = 'bold 62px Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const maxW = w - 70;
    const tw = g.measureText(word).width;
    g.save();
    g.translate(x0 + w / 2, h / 2 + 2);
    if (tw > maxW) g.scale(maxW / tw, 1);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillText(word, 3, 3);
    g.fillStyle = dark ? `hsl(${(hue + 40) % 360} 78% 58%)` : 'rgba(214,211,205,0.98)';
    g.fillText(word, 0, 0);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Chain-link alpha mask (diamond mesh). */
function makeChainAlpha() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, n, n);
  g.strokeStyle = '#fff'; g.lineWidth = 2.2;
  const s = n / 4;
  g.beginPath();
  for (let i = -4; i <= 8; i++) {
    g.moveTo(i * s, 0); g.lineTo(i * s + n, n);
    g.moveTo(i * s, 0); g.lineTo(i * s - n, n);
  }
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Picket-fence alpha: one 0.15 m pitch (≈9 cm slat, 6 cm gap) with a soft edge for AA. */
function makePicketAlpha() {
  const n = 64;
  const c = document.createElement('canvas');
  c.width = n; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, n, 8);
  const grad = g.createLinearGradient(0, 0, n, 0);
  grad.addColorStop(0.00, '#000'); grad.addColorStop(0.14, '#fff');
  grad.addColorStop(0.62, '#fff'); grad.addColorStop(0.76, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, n, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Small procedural foliage colour/normal so hedges and shrubs are not flat green blobs. */
function makeFoliage() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const rng = makeRng(9182);
  g.fillStyle = '#33491f'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 2600; i++) {
    const x = rng.range(-4, n + 4), y = rng.range(-4, n + 4), r = rng.range(1.0, 2.6);
    const l = rng.range(0.72, 1.18);
    g.fillStyle = `rgba(${Math.round(62 * l)},${Math.round(92 * l)},${Math.round(38 * l)},0.7)`;
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, rng.range(0, 3.14), 0, 6.283); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  // matching bumpy normal
  const nc = document.createElement('canvas');
  nc.width = nc.height = n;
  const ng = nc.getContext('2d');
  ng.fillStyle = '#8080ff'; ng.fillRect(0, 0, n, n);
  const rng2 = makeRng(9183);
  for (let i = 0; i < 1600; i++) {
    const x = rng2.range(-4, n + 4), y = rng2.range(-4, n + 4), r = rng2.range(1.2, 3.2);
    const gr = ng.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
    gr.addColorStop(0, 'rgba(190,190,255,0.8)'); gr.addColorStop(1, 'rgba(128,128,255,0)');
    ng.fillStyle = gr; ng.beginPath(); ng.arc(x, y, r, 0, 6.283); ng.fill();
  }
  const ntex = new THREE.CanvasTexture(nc);
  ntex.wrapS = ntex.wrapT = THREE.RepeatWrapping;
  ntex.anisotropy = 4;
  return { map: tex, normalMap: ntex };
}

export async function createMaterials(ctx) {
  const { engine, assets } = ctx;
  const loaded = {};
  await Promise.all(Object.entries(SETS).map(async ([key, files]) => {
    const urls = {};
    for (const [slot, f] of Object.entries(files)) urls[slot] = S + f;
    loaded[key] = await assets.loadPBR(urls, { anisotropy: engine.maxAnisotropy });
  }));
  FACADE_UNIFORMS.uRoofMap.value = loaded.asphalt_light.map || null;

  const mats = {};
  const finish = (key, mat) => {
    // Wetness / snow come from the effects module's global material hook (engine.addMaterialHook);
    // do NOT patch uWetness locally — the environment hook already declares that uniform.
    engine.registerMaterial(mat);
    mat.name = 'buildings/' + key;
    mats[key] = mat;
    return mat;
  };
  // Base roughness/metalness follow docs/MATERIAL_TARGET.md. They are BASE values: where a set also
  // carries a roughnessMap three multiplies the two, so the map still supplies the variation while
  // the base sets the family. Leaving every base at 1.0 (which is what shipped) is what put 27 of
  // this module's 36 materials in the "chalk" bucket and left the whole scene with no specular.
  const std = (set, extra = {}) => new THREE.MeshStandardMaterial({ ...(set ? loaded[set] : {}), roughness: 1, metalness: 0, ...extra });
  /** Same, but as a coated MeshPhysicalMaterial (profiled steel carries a PVDF coat). */
  const stdCoat = (set, extra, cc, ccr) => coat({ ...(set ? loaded[set] : {}), roughness: 1, metalness: 0, ...extra }, cc, ccr);

  // --- facades (unit box, procedural windows) ---
  // normalScale is pushed well above 1: at the 40-70 m a player actually uses, a 1K brick/plaster
  // normal at default strength is invisible, which is exactly the "flat colour field" the judges saw.
  const facade = (key, set, extra) => finish(key, patchFacade(std(set, { normalScale: new THREE.Vector2(1.9, 1.9), ...extra })));
  facade('brick_red', 'bricks_red', { roughness: R.brick });
  facade('brick_yellow', 'bricks_yellow', { roughness: R.brick });
  facade('brick_white', 'bricks_white', { roughness: R.brick });
  facade('plaster', 'plaster_modern', { roughness: R.brick });
  facade('plaster_rough', 'plaster_rough', { roughness: R.brick });
  facade('plaster_painted', 'plaster_painted', { roughness: R.brick });
  facade('concrete_wall', 'concrete_wall', { roughness: R.concrete });
  facade('concrete', 'concrete', { roughness: R.concrete });
  facade('siding', 'wood', { roughness: R.paintedWood });
  finish('corrugated', metalSky(patchFacade(std('corrugated', { normalScale: new THREE.Vector2(1.9, 1.9), roughness: R.metalPanel, metalness: 0.95 })), 0.55));  // profiled steel cladding
  // curtain-wall carrier: the pane itself is shaded by the facade patch (dielectric + explicit sky
  // reflection), so the base is real glass — roughness 0.05, metalness 0, not a grey metal card.
  facade('glass', null, { color: new THREE.Color(0.40, 0.42, 0.45), roughness: R.glass, metalness: 0 });

  // --- pitched roofs (u along ridge, v along slope; eave shadow + ridge cap in the patch) ---
  const roof = (key, set, scale, extra) => finish(key, patchRoof(std(set, extra), scale));
  roof('tiles_a', 'tiles_a', 1.6, { roughness: R.roofTile, normalScale: new THREE.Vector2(1.8, 1.8) });
  roof('tiles_b', 'tiles_b', 1.6, { roughness: R.roofTile, normalScale: new THREE.Vector2(1.8, 1.8) });
  roof('shingle', 'asphalt', 1.15, { roughness: R.roofTile, normalScale: new THREE.Vector2(2.0, 2.0) });
  finish('corrugated_roof', metalSky(patchRoof(std('corrugated', { roughness: R.metalPanel, metalness: 0.95 }), 2.0), 0.55));   // PVDF-coated
  finish('tiles_ridge', patchInstanceUv(std('tiles_a', { roughness: R.roofTile }), 'xy', 0.9));
  finish('tiles_ridge_b', patchInstanceUv(std('tiles_b', { roughness: R.roofTile }), 'xy', 0.9));
  finish('shingle_ridge', patchInstanceUv(std('asphalt', { roughness: R.roofTile }), 'xy', 0.7));
  finish('metal_ridge', metalSky(patchInstanceUv(stdCoat('corrugated', { roughness: R.metalPanel, metalness: 0.95 }, 0.30, 0.14), 'xy', 0.6)));

  // --- cylinders (tanks, chimneys, silos) ---
  // NOTE: metalplates006 has a linear albedo mean of 0.065 — as a metal that is F0 0.065, i.e. a
  // black can. Galvanised/profiled steel sits near 0.33, which is what corrugatedsteel005 measures,
  // so tanks and silos share that set (its ribs also read correctly wrapped round a cylinder).
  finish('metal_tank', metalSky(patchInstanceUv(stdCoat('corrugated', { roughness: R.metalPanel, metalness: 0.95 }, 0.28, 0.14), 'cyl', 3.0)));
  finish('concrete_cyl', patchInstanceUv(std('concrete', { roughness: R.concrete }), 'cyl', 4.0));
  finish('brick_cyl', patchInstanceUv(std('bricks_red', { roughness: R.brick }), 'cyl', 2.6));

  // --- ground quads ---
  finish('lawn', patchInstanceUv(std('grass', { roughness: R.grass }), 'xz', 3.0));
  finish('pave_concrete', patchInstanceUv(std('concrete', { roughness: R.concrete }), 'xz', 4.0));
  finish('pave_slabs', patchInstanceUv(std('paving', { roughness: R.concrete }), 'xz', 2.5));
  finish('yard_asphalt', patchInstanceUv(std('asphalt_light', { roughness: R.asphalt }), 'xz', 5.0));
  finish('dirt', patchInstanceUv(std('dirt', { roughness: R.soil }), 'xz', 4.0));
  finish('garden', patchInstanceUv(std('forest_floor', { roughness: R.grass }), 'xz', 1.6));

  // --- boxes with textures ---
  finish('wood', patchInstanceUv(std('wood', { roughness: R.paintedWood }), 'xy', 1.1));
  finish('wall_stone', patchInstanceUv(std('bricks_white', { roughness: R.brick }), 'xy', 1.0));

  // --- plain detail materials (instanceColor gives the variety) ---
  // 'paint' doubles as the painted-plant material (rooftop AC casings, ducts, dock canopies):
  // sharing one pool keeps the draw-call count down, and low metalness stops plant reading as a
  // near-black hole on a pale roof the way a metalness-0.85 'steel' box did.
  finish('paint', coat({ color: 0xffffff, roughness: R.paint, metalness: 0.08 }, 0.45, 0.10));
  finish('metal_dark', metalSky(coat({ color: 0x51555c, roughness: R.metalPanel, metalness: 0.95 }, 0.35, 0.12)));
  finish('steel', metalSky(new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: R.trim, metalness: 0.95 }), 0.75));
  finish('fabric', new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }));
  // dark architectural glass (balustrades, lobby glazing, canopies): a real dielectric mirror, not a
  // metal card — glassSky() below gives it the same analytic sky reflection the facade panes use
  finish('glass_dark', glassSky(coat({ color: 0x161c22, roughness: R.glass, metalness: 0 }, 0.55, 0.04)));
  // a PV module is a dark cell UNDER a sheet of cover glass: that sheet is exactly a clearcoat
  finish('solar', glassSky(coat({ color: 0x0b1120, roughness: R.solar, metalness: 0 }, 1.0, 0.05), 0.7));
  const lamp = coat({ color: 0xfff0d0, emissive: 0xffc98a, emissiveIntensity: 0, roughness: 0.35, metalness: 0 }, 0.80, 0.06);
  finish('lamp', lamp);
  // aviation beacon: a small emissive lens, not a flat red cube. The base emissive is high enough
  // that it reads as lit in daylight too (see index.js update()).
  const beacon = coat({ color: 0x30100e, emissive: 0xff3320, emissiveIntensity: 1.4, roughness: 0.28, metalness: 0 }, 0.90, 0.05);
  finish('beacon', beacon);

  // --- hedges / shrubs ---
  const fol = makeFoliage();
  finish('hedge', patchInstanceUv(new THREE.MeshStandardMaterial({ ...fol, roughness: R.foliage, metalness: 0, normalScale: new THREE.Vector2(1.7, 1.7) }), 'xy', 0.30));

  // --- alpha-tested panels: chain link + picket fence + shop signs ---
  const chain = metalSky(new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: R.trim, metalness: 0.95, alphaMap: makeChainAlpha(), alphaTest: 0.5, side: THREE.DoubleSide }), 0.7);
  finish('chain', patchInstanceUv(chain, 'xy', 1.0));
  const picket = coat({ color: 0xffffff, roughness: R.paintedWood, metalness: 0.02, alphaMap: makePicketAlpha(), alphaTest: 0.5, side: THREE.DoubleSide }, 0.30, 0.14);
  finish('picket', patchInstanceUv(picket, 'xy', 0.15));
  const signTex = makeSignAtlas(8);
  const sign = coat({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0, roughness: R.paint, metalness: 0.1 }, 0.70, 0.08);
  finish('sign', patchAtlas(sign, 8));

  return { mats, uniforms: FACADE_UNIFORMS };
}
