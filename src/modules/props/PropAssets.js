/**
 * props — asset & material library.
 *
 * Loads the shared CC0 glTF props (bench, trash can, hydrant, planter, classic street lamp,
 * covered car), bakes each into one merged geometry per material, and builds every procedural
 * material used by the module. Every lit material goes through `engine.registerMaterial` before
 * the first render (ARCHITECTURE §3) so CSM shadows and the environment hooks apply.
 *
 * The result is a map of "kinds": id → { parts:[{geometry, material, cast, receive, tint}],
 * lodParts, lodDist, maxDist, cap, radius }. The renderer turns each part into one InstancedMesh.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clusterDecimate, triangleCount } from '../../shared/decimate.js';
import {
  makeLeafCardTexture, makeBarkTexture, makeSoilTexture, makeSignAtlas, makeNameAtlas,
  makeChainLinkTexture, makeHaloTexture, makeAdPosterTexture, makeGrateTexture, makeApronTexture, SIGN_TILES,
  makeGrassCardTexture, makeContactTexture, makeLightPoolTexture, makeGroundDecalTexture,
} from './PropTextures.js';
import {
  makeTree, makeTreePit, makeTrafficSignal, makeSignPost, makeSignPanel, makeNameBlade,
  makeBusShelter, makeHedge, makePicketFence, makeChainFence, makeBollard, makeHaloQuad,
  makeCycleStand, makeNewsBox, makeApron, makeShrub,
} from './PropGeometry.js';
import {
  makeGroundQuad, makeGrassTuft, makeRock, makeMailbox, makeWheelieBin, makeUtilityBox,
  makeAboard, makeGardenShed,
} from './PropDressing.js';
import { makeCar } from './PropCar.js';

const MODELS = '/assets/shared/models/';

/** Decimation grid, as a fraction of the model's bounding-box diagonal (bigger = coarser). */
const DECIMATE = {
  hydrant: 0.03, hydrant_aged: 0.04, bin: 0.036, bin_rust: 0.042,
  planter: 0.04, lamp_classic: 0.024, car_covered: 0.036,
};

/** Scale applied to a baked variant (number = uniform, [x,y,z] = per axis). The CC0 originals are
 *  studio props photographed at their real size; only a few need nudging into street proportions. */
const MODEL_SCALE = {
  bench: [1.50, 1.02, 1.25],      // 1.16 × 0.89 × 0.50 m original → a 1.75 m public bench
  planter: 1.25,
  lamp_classic: 2.35,
};

/** glTF props: url id → how its scene nodes split into variants. */
const GLTF_SPEC = {
  painted_wooden_bench: { variants: { bench: () => true } },
  metal_trash_can: { variants: { bin: (n) => !n.includes('rust'), bin_rust: (n) => n.includes('rust') } },
  fire_hydrant: { variants: { hydrant: (n) => !n.includes('aged'), hydrant_aged: (n) => n.includes('aged') } },
  planter_box_01: { variants: { planter: () => true } },
  street_lamp_02: { variants: { lamp_classic: () => true } },
  covered_car: { variants: { car_covered: () => true } },
};

/**
 * Bake one glTF into merged geometries per material, grouped into variants and re-centred so the
 * origin sits on the ground under the model's centre.
 */
function bakeGLTF(gltf, spec, budget = {}) {
  const out = {};
  gltf.scene.updateWorldMatrix(true, true);
  // GLTFLoader names a multi-primitive node's children "<mesh>_0", "<mesh>_1" and hangs them under a
  // Group carrying the *node* name — so a variant has to be matched against the whole ancestor chain.
  const nameOf = (o) => (o && o.name ? o.name : '').toLowerCase().replace(/_\d+$/, '');
  const chain = (o) => {
    const out2 = [];
    for (let p = o; p && p !== gltf.scene; p = p.parent) { const n = nameOf(p); if (n) out2.push(n); }
    return out2;
  };
  for (const [variant, match] of Object.entries(spec.variants)) {
    const byMat = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const ids = chain(o);
      if (!ids.length || !ids.some(match)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat) return;
      const clone = o.geometry.clone();
      clone.applyMatrix4(o.matrixWorld);
      clone.clearGroups();
      if (!byMat.has(mat.uuid)) byMat.set(mat.uuid, { material: mat, geos: [] });
      byMat.get(mat.uuid).geos.push(clone);
    });
    if (!byMat.size) continue;
    const parts = [];
    const bbox = new THREE.Box3();
    for (const { material, geos } of byMat.values()) {
      let geo = geos[0];
      if (geos.length > 1) {
        try { geo = mergeGeometries(geos, false); } catch { geo = geos[0]; }
      }
      if (!geo) continue;
      geo.computeBoundingBox();
      bbox.union(geo.boundingBox);
      parts.push({ geometry: geo, material });
    }
    const cx = (bbox.min.x + bbox.max.x) / 2, cz = (bbox.min.z + bbox.max.z) / 2, y0 = bbox.min.y;
    const ms = MODEL_SCALE[variant] || 1;
    const k = Array.isArray(ms) ? ms : [ms, ms, ms];
    const size = new THREE.Vector3().subVectors(bbox.max, bbox.min).multiply(new THREE.Vector3(k[0], k[1], k[2]));
    // these are photogrammetry props (a hydrant ships 43 k triangles); cluster-decimate them to a
    // grid proportional to the model so a city full of instances stays inside the triangle budget
    const cell = Math.max(0.004, size.length() * (budget[variant] || 0.02));
    let before = 0, after = 0;
    for (const p of parts) {
      p.geometry.translate(-cx, -y0, -cz);
      if (k[0] !== 1 || k[1] !== 1 || k[2] !== 1) p.geometry.scale(k[0], k[1], k[2]);
      before += triangleCount(p.geometry);
      if (triangleCount(p.geometry) > 900) p.geometry = clusterDecimate(p.geometry, cell);
      after += triangleCount(p.geometry);
      p.geometry.computeBoundingSphere();
    }
    out[variant] = { parts, size, tris: after, trisBefore: before };
  }
  return out;
}

/**
 * Materials whose geometry never needs to reach the shadow map: glazing, luminaires, thin trim and
 * anything already inside another part's silhouette. Every caster costs one draw call per cascade.
 */
const NO_CAST = new Set([
  'car_glass', 'car_trim', 'car_tail', 'car_lamp', 'car_tyre', 'car_dark',
  'shelter_glass', 'shelter_ad', 'wood_slat', 'signal_lens', 'signal_board', 'lamp_glow',
  'sign_face', 'name_face', 'soil', 'grate', 'curb_ring', 'concrete', 'fence_chain', 'news_body', 'apron',
  'tuft_a', 'tuft_b', 'tuft_c', 'tuft_flower', 'slab', 'bed', 'contact', 'lightpool', 'stone',
]);

/** Largest distance from the local origin any vertex of the kind reaches (frustum culling). */
function kindRadius(parts) {
  let r = 0;
  for (const p of parts) {
    const bs = p.geometry.boundingSphere;
    if (!bs) continue;
    r = Math.max(r, bs.center.length() + bs.radius);
  }
  return r || 1;
}

/**
 * Vegetation albedo. Two rounds ago foliage measured 4.8x too bright at 1.2x reference chroma;
 * the correction overshot to 2-7x too DARK (crown Y 0.008 against cs2_04's 0.047-0.056). These are
 * the two numbers that land it in the middle — raise them and the whole canopy moves together.
 */
const FOLIAGE_GAIN = 2.05;
const GRASS_GAIN = 1.30;
/** Night ambient floor for vegetation: a crown under a streetlight is dim, never a black cutout. */
const NIGHT_FLOOR = 0.085;
/** Peak linear radiance of a streetlamp's ground pool (MAX-blended, so this is a hard ceiling). */
const POOL_PEAK = 0.05;

export class PropAssets {
  constructor(ctx) {
    this.ctx = ctx;
    this.engine = ctx.engine;
    this.kinds = new Map();
    this.materials = new Map();
    this.nightMaterials = [];      // { mat, intensity } — emissive scaled by nightFactor
    this.shared = {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uWind: { value: new THREE.Vector3(0.7, 0.7, 0.5) },   // xz = direction, z-comp = strength
      uNightFloor: { value: NIGHT_FLOOR },
    };
    this.modelSizes = {};
    this.disposables = [];
  }

  mat(key, material) {
    material.name = 'props/' + key;
    this.engine.registerMaterial(material);
    this.materials.set(key, material);
    return material;
  }

  /**
   * Night ambient floor. Vegetation lit only by the sun goes to pure black the moment the sun sets,
   * and the p4 critic caught crowns rendering as black cutouts beside daylight-green ones in the
   * same frame. This adds a small albedo-scaled term that only exists at night, so a crown outside
   * every light pool still reads as a dim canopy instead of a hole in the sky.
   * Wraps any onBeforeCompile the material already carries (the wind sway).
   */
  nightLit(material) {
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : 'props'}-nl`;
    material.onBeforeCompile = (sh, renderer) => {
      if (prev) prev.call(material, sh, renderer);
      sh.uniforms.uNight = this.shared.uNight;
      sh.uniforms.uNightFloor = this.shared.uNightFloor;
      sh.fragmentShader = `uniform float uNight;\nuniform float uNightFloor;\n${sh.fragmentShader}`
        .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * uNight * uNightFloor;`);
    };
    return material;
  }

  /** Wind sway for card foliage: object-space displacement growing with height, phased by the
   *  instance's world position so a row of street trees never breathes in unison. */
  sway(material, key, amp, minY) {
    material.customProgramCacheKey = () => `props-sway-${key}`;
    material.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.shared.uTime;
      sh.uniforms.uWind = this.shared.uWind;
      sh.vertexShader = `uniform float uTime;\nuniform vec3 uWind;\n${sh.vertexShader}`
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
  #ifdef USE_INSTANCING
    vec3 swayOrigin = instanceMatrix[3].xyz;
  #else
    vec3 swayOrigin = vec3(0.0);
  #endif
  float swayPh = swayOrigin.x * 0.21 + swayOrigin.z * 0.17;
  float swayH = max(0.0, transformed.y - ${minY.toFixed(2)});
  float swayA = ${amp.toFixed(3)} * uWind.z * swayH;
  float swayT = sin(uTime * 1.15 + swayPh) * 0.7 + sin(uTime * 2.31 + swayPh * 1.7) * 0.3;
  transformed.x += swayT * swayA * uWind.x;
  transformed.z += swayT * swayA * uWind.y;`);
    };
    return material;
  }

  async load() {
    const q = this.engine.quality;
    const aniso = this.engine.maxAnisotropy;

    /* ---------------------------------------------------------- textures */
    const leafA = makeLeafCardTexture(512, 2201, 104, 0.28, 0);
    const leafB = makeLeafCardTexture(512, 3307, 86, 0.24, 0);
    const blossom = makeLeafCardTexture(512, 5501, 348, 0.46, 2);
    const hedgeCard = makeLeafCardTexture(512, 4409, 98, 0.31, 1);
    const bark = makeBarkTexture(4111);
    const soil = makeSoilTexture(5197);
    const grate = makeGrateTexture(256);
    const signAtlas = makeSignAtlas();
    const nameAtlas = makeNameAtlas();
    const chain = makeChainLinkTexture();
    const halo = makeHaloTexture();
    const poster = makeAdPosterTexture(919);
    const apron = makeApronTexture(256, 77);
    this.disposables.push(leafA, leafB, blossom, hedgeCard, bark, soil, grate, signAtlas, nameAtlas, chain, halo, poster, apron);
    for (const t of [leafA, leafB, blossom, hedgeCard, grate]) t.anisotropy = aniso;
    bark.repeat.set(1, 1);          // the canvas bark does not tile vertically: >1 shows a hard seam
    soil.repeat.set(2, 2);

    /* --------------------------------------------------------- materials */
    const S = (o) => new THREE.MeshStandardMaterial(o);
    // clearcoat surfaces (car lacquer, sign overlaminate, moulded plastic) need the physical lobe
    const PH = (o) => new THREE.MeshPhysicalMaterial(o);
    this.mat('bark', S({ map: bark, color: 0xcfc4ae, roughness: 0.88, metalness: 0, vertexColors: true }));

    // card foliage: alpha-cut, double sided, vertex colour = baked crown AO (× per-instance tint)
    // roughness 0.70 (MATERIAL_TARGET): a leaf has a waxy cuticle, so the canopy carries a broad
    // specular sheen off the sky probe. At 0.88-0.90 it sampled the PMREM as a uniform blur and the
    // whole crown read as matte cardboard.
    const foliage = (map, colour) => S({
      map, alphaTest: 0.38, side: THREE.DoubleSide, color: colour,
      roughness: 0.70, metalness: 0, vertexColors: true, envMapIntensity: 1.15,
    });
    // albedo is deliberately well under white: CS2 daytime foliage sits near Y 0.05 — near-black in
    // silhouette with colour only on the sunlit tops. White-albedo leaf cards are what made our
    // greens read 4.8x too bright against the reference (LOOK_TARGET rows 4-5).
    const F = (m) => { m.color.multiplyScalar(FOLIAGE_GAIN); return m; };
    this.nightLit(this.sway(this.mat('leaves', F(foliage(leafA, 0xa8c47c))), 'leaf', 0.055, 2.0));
    this.nightLit(this.sway(this.mat('leaves_b', F(foliage(leafB, 0xa2c078))), 'leaf', 0.055, 2.0));
    this.nightLit(this.sway(this.mat('blossom', F(foliage(blossom, 0xcdc6bd))), 'leaf', 0.05, 1.4));
    this.nightLit(this.sway(this.mat('hedge_leaf', F(foliage(hedgeCard, 0xa4c07a))), 'hedge', 0.012, 0.2));
    this.nightLit(this.mat('hedge', S({ color: 0x4a5a34, roughness: 0.70, metalness: 0, vertexColors: true, envMapIntensity: 1.15 })));

    this.mat('soil', S({ map: soil, color: 0x8e8172, roughness: 0.95 }));
    this.mat('grate', S({ map: grate, alphaTest: 0.4, color: 0x6a6d70, roughness: 0.45, metalness: 0.9, side: THREE.DoubleSide }));
    this.mat('curb_ring', S({ color: 0x9a978f, roughness: 0.80, metalness: 0 }));
    this.mat('concrete', S({ color: 0x9d9a93, roughness: 0.80, metalness: 0 }));
    this.mat('post_metal', S({ color: 0x5a6165, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.25 }));
    this.mat('signal_metal', S({ color: 0x32383a, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.25 }));
    this.mat('signal_board', S({ color: 0x1c1f20, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.25 }));
    this.mat('shelter_metal', S({ color: 0x3a4145, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.25 }));
    this.mat('shelter_roof', S({ color: 0x6a7075, roughness: 0.45, metalness: 0.95, envMapIntensity: 1.2 }));
    this.mat('wood_slat', S({ color: 0x9a7550, roughness: 0.70, metalness: 0 }));
    this.mat('fence_wood', S({ color: 0xd9d5c9, roughness: 0.75, metalness: 0 }));
    this.mat('fence_metal', S({ color: 0x9aa0a4, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.25 }));
    this.mat('news_body', PH({ color: 0x2e5b7a, roughness: 0.35, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.10 }));
    const apronMat = this.mat('apron', S({
      map: apron, alphaTest: 0.5, color: 0xffffff, roughness: 0.80, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    apronMat.map.anisotropy = aniso;

    // vehicles
    // MATERIAL_TARGET: body paint 0.30 / metal 0 / clearcoat 1.0 at ccRoughness 0.05 — the second
    // lacquer lobe is what makes car paint read as car paint instead of coloured clay. Glass 0.06 and
    // never body-coloured; chrome 0.15 / 1.0; lenses 0.10 with their own coat.
    this.mat('car_paint', PH({
      color: 0xffffff, roughness: 0.30, metalness: 0.0, envMapIntensity: 1.35,
      clearcoat: 1.0, clearcoatRoughness: 0.05,
    }));
    this.mat('car_glass', S({ color: 0x131a20, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.8 }));
    this.mat('car_dark', S({ color: 0x1d2022, roughness: 0.50, metalness: 0.0 }));
    this.mat('car_tyre', S({ color: 0x121415, roughness: 0.90, metalness: 0 }));
    this.mat('car_trim', S({ color: 0xb6bbc0, roughness: 0.15, metalness: 1.0, envMapIntensity: 1.5 }));
    this.mat('car_lamp', PH({
      color: 0xd7e2ea, roughness: 0.10, metalness: 0.0, envMapIntensity: 1.5,
      clearcoat: 1.0, clearcoatRoughness: 0.06, emissive: 0x9fb4c4, emissiveIntensity: 0.0,
    }));
    this.mat('car_tail', PH({
      color: 0x8e1a1c, roughness: 0.10, metalness: 0.0, envMapIntensity: 1.5,
      clearcoat: 1.0, clearcoatRoughness: 0.06, emissive: 0x8e1010, emissiveIntensity: 0,
    }));
    // NB: car_lamp is NOT a night material — these are parked, unoccupied cars; glowing headlamps
    // and number plates on an empty kerbside car were the giveaway the last critic caught.

    // sign faces: alpha-cut atlas, grey aluminium back, faint retro-reflective glow at night
    // retroreflective sheeting under a glossy overlaminate: roughness 0.35 plus a clearcoat lobe
    const faceOpts = {
      alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.35, metalness: 0.0,
      clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 1.3,
      emissive: 0xffffff, emissiveIntensity: 0,
    };
    const signFace = this.mat('sign_face', PH({ map: signAtlas, emissiveMap: signAtlas, ...faceOpts }));
    const nameFace = this.mat('name_face', PH({ map: nameAtlas, emissiveMap: nameAtlas, ...faceOpts }));
    for (const m of [signFace, nameFace]) {
      m.customProgramCacheKey = () => 'props-signface-v1';
      m.onBeforeCompile = (sh) => {
        // the back of a sign is plain aluminium, not a mirrored face
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  if (!gl_FrontFacing) { diffuseColor.rgb = vec3(0.30); totalEmissiveRadiance = vec3(0.0); }');
      };
      this.nightMaterials.push({ mat: m, intensity: 0.22 });
    }
    this.mat('shelter_glass', S({
      color: 0x9fb6c0, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.26,
      envMapIntensity: 1.8, side: THREE.DoubleSide, depthWrite: false,
    }));
    // the ad panel sits behind glass: a sharp coat lobe, not a matte poster
    this.mat('shelter_ad', PH({
      map: poster, emissiveMap: poster, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: 0.12, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06,
      envMapIntensity: 1.4, side: THREE.FrontSide,
    }));
    this.nightMaterials.push({ mat: this.materials.get('shelter_ad'), intensity: 1.5 });
    const chainMat = this.mat('fence_chain', S({
      map: chain, alphaTest: 0.45, transparent: false,
      color: 0xb7bcc0, roughness: 0.40, metalness: 0.85, envMapIntensity: 1.2, side: THREE.DoubleSide,
    }));
    chainMat.map.repeat.set(2, 2);

    // warm luminaire glow (lamp bulbs, shelter strip, bollard band)
    const glow = this.mat('lamp_glow', S({ color: 0x14140f, roughness: 0.15, metalness: 0, envMapIntensity: 1.4, emissive: 0xffd7a0, emissiveIntensity: 0 }));
    this.nightMaterials.push({ mat: glow, intensity: 6.0 });

    // traffic signal lenses: the lit aspect comes from the cycle phase in the shader
    const lens = this.mat('signal_lens', PH({ color: 0x0b0d0c, roughness: 0.10, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.5 }));
    lens.customProgramCacheKey = () => 'props-signal-v1';
    lens.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.shared.uTime;
      sh.uniforms.uNight = this.shared.uNight;
      sh.vertexShader = `attribute float aLens;\nattribute float aPhase;\nvarying float vLens;\nvarying float vPhase;\n${sh.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLens = aLens;\n  vPhase = aPhase;');
      sh.fragmentShader = `uniform float uTime;\nuniform float uNight;\nvarying float vLens;\nvarying float vPhase;\n${sh.fragmentShader}`
        .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
  float cyc = fract(uTime / 26.0 + vPhase * 0.5);
  float st = cyc < 0.42 ? 2.0 : (cyc < 0.5 ? 1.0 : (cyc < 0.94 ? 0.0 : 1.0));
  float lit = step(abs(vLens - st), 0.4);
  vec3 lensCol = vLens < 0.5 ? vec3(1.0, 0.07, 0.04) : (vLens < 1.5 ? vec3(1.0, 0.52, 0.03) : vec3(0.16, 1.0, 0.34));
  diffuseColor.rgb = mix(lensCol * 0.10, lensCol * 0.55, lit);
  totalEmissiveRadiance += lensCol * lit * (2.6 + 3.0 * uNight);`);
    };

    /* ------------------------------------------- ground cover & lot dressing */
    // four undergrowth species: fine lawn, tall meadow, dry weed, wildflower. A lawn is never one
    // flat green in a reference frame — it is a patchwork of these four at different albedos.
    const TUFTS = ['tuft_a', 'tuft_b', 'tuft_c', 'tuft_flower'];
    const tuftTex = TUFTS.map((_, i) => makeGrassCardTexture(256, 2207 + i * 613, i));
    for (const t of tuftTex) { t.anisotropy = aniso; this.disposables.push(t); }
    TUFTS.forEach((k, i) => {
      this.sway(this.mat(k, S({
        // a low alpha cut keeps thin blades alive through minification: at 0.42 a tuft 30 m away
        // mips away to nothing and the lawn goes back to being one flat green
        map: tuftTex[i], alphaTest: 0.28, side: THREE.DoubleSide,
        color: new THREE.Color(0xcedea4).multiplyScalar(GRASS_GAIN),
        roughness: 0.85, metalness: 0, envMapIntensity: 1.1,
      })), 'tuft', 0.06, 0.0);
      this.nightLit(this.materials.get(k));
    });
    this.mat('stone', S({ color: 0x8a8780, roughness: 0.70, metalness: 0 }));
    this.mat('mail_body', PH({ color: 0x2c4759, roughness: 0.35, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.10 }));
    this.mat('bin_plastic', PH({ color: 0x2c3b30, roughness: 0.45, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.22 }));

    // lit ground decals: garden paths / patios and planting beds
    const slabTex = makeGroundDecalTexture(256, 913, 'slab');
    const bedTex = makeGroundDecalTexture(256, 337, 'bed');
    for (const t of [slabTex, bedTex]) { t.anisotropy = aniso; this.disposables.push(t); }
    // the p4 critic measured these blue-violet (sRGB 69,66,90 — blue 21 above red) where CS2 paving
    // is warm (72,63,53). The tint pulls them back to hue ~44 deg so only the shadows read cool.
    const groundDecal = (map, colour, rough) => S({
      map, color: colour, alphaTest: 0.5, roughness: rough, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mat('slab', groundDecal(slabTex, 0xd7cdbc, 0.80));
    this.mat('bed', groundDecal(bedTex, 0xd2c4b0, 0.90));

    // unlit ground decals. `contact` multiplies the ground in linear space, which is the ambient
    // occlusion a 2 k shadow cascade cannot resolve: it is what stops a prop reading as pasted on.
    // `lightpool` adds the warm pool a luminaire lays on the pavement after dark.
    const contactTex = makeContactTexture(128);
    const poolTex = makeLightPoolTexture(256);
    this.disposables.push(contactTex, poolTex);
    this.contactMaterial = this.mat('contact', new THREE.MeshBasicMaterial({
      map: contactTex, blending: THREE.MultiplyBlending, transparent: true, opacity: 1,
      premultipliedAlpha: true,          // three requires it for MultiplyBlending; alpha is 1 anyway
      depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    // MAX blend, not additive: three overlapping discs per luminaire plus the neighbouring lamps
    // used to stack 4-6 additive layers and blow the pavement to Y 0.35 (CS2 lit asphalt: 0.059).
    // max() makes a pool an upper bound on the pavement, so a street of lamps can never exceed one
    // lamp's brightness however many pools overlap. Strength rides on `color`, not `opacity`.
    this.poolMaterial = this.mat('lightpool', new THREE.MeshBasicMaterial({
      map: poolTex, color: 0x000000, transparent: true, opacity: 1,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));

    // halo billboards around lit luminaires (unlit, additive, NO_AO layer)
    this.haloMaterial = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: halo }, uColor: { value: new THREE.Color(1.0, 0.78, 0.5) }, uIntensity: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          vec4 mv = modelViewMatrix * origin;
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uColor; uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          gl_FragColor = vec4(uColor * t.rgb * t.a * uIntensity, t.a * uIntensity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    /* ------------------------------------------------------------ models */
    const ids = Object.keys(GLTF_SPEC);
    const loaded = await Promise.all(ids.map((id) => this.ctx.assets.loadGLTF(`${MODELS}${id}/${id}_1k.gltf`).catch(() => null)));
    const models = {};
    ids.forEach((id, i) => {
      if (!loaded[i]) return;
      const baked = bakeGLTF(loaded[i], GLTF_SPEC[id], DECIMATE);
      for (const [variant, data] of Object.entries(baked)) {
        models[variant] = data;
        this.modelSizes[variant] = [+data.size.x.toFixed(2), +data.size.y.toFixed(2), +data.size.z.toFixed(2), `${data.trisBefore}→${data.tris} tris`];
        for (const p of data.parts) {
          p.material.name = p.material.name || 'props/gltf';
          if (p.material.map) p.material.map.anisotropy = aniso;
          this.engine.registerMaterial(p.material);
        }
      }
    });
    this.models = models;

    /* ------------------------------------------------------------- kinds */
    const dd = Math.min(1.35, Math.max(0.55, q.density));
    const K = (id, parts, opts = {}) => {
      const list = parts.filter((p) => p.geometry && p.material);
      if (!list.length) return null;
      const kind = {
        id,
        parts: list,
        lodParts: opts.lodParts || null,
        lodDist: (opts.lodDist || 90) * dd,
        maxDist: (opts.maxDist || 150) * dd,
        cap: Math.max(24, Math.round((opts.cap || 400) * dd)),
        radius: kindRadius(list),
        tint: !!opts.tint,
        reflected: !!opts.reflected,
        noAo: !!opts.noAo,
        nightOnly: !!opts.nightOnly,
        items: [],
      };
      this.kinds.set(id, kind);
      return kind;
    };
    const P = (geos, o = {}) => Object.entries(geos).map(([mk, geometry]) => ({
      geometry,
      material: this.materials.get(mk),
      cast: o.cast !== false && !NO_CAST.has(mk),
      receive: o.receive !== false,
      tint: Array.isArray(o.tintMat) ? o.tintMat.includes(mk) : o.tintMat === mk,
    })).filter((p) => p.material);

    // --- street trees: two broadleaf variants, two uprights, one flowering ornamental
    const TREES = [
      ['tree_broad', 0, 17, 'leaves'], ['tree_broad_b', 0, 91, 'leaves_b'],
      ['tree_upright', 1, 41, 'leaves_b'], ['tree_upright_b', 1, 133, 'leaves'],
      ['tree_small', 2, 73, 'blossom'], ['tree_conifer', 3, 209, 'leaves_b'],
    ];
    for (const [id, style, seed, leafMat] of TREES) {
      const remap = (geos) => {
        const o = {};
        for (const [k, g] of Object.entries(geos)) o[k === 'leaves' ? leafMat : k] = g;
        return o;
      };
      K(id, P(remap(makeTree(seed, style)), { tintMat: leafMat }), {
        lodParts: P(remap(makeTree(seed, style, 1)), { tintMat: leafMat }),
        lodDist: 62, maxDist: 430, cap: 380, tint: true,
      });
    }
    K('tree_pit', P(makeTreePit(), { cast: false }), { maxDist: 140, cap: 800 });

    // --- signals, signs, name blades
    for (const [id, kind] of [['traffic_light', 'post'], ['traffic_light_mast', 'mast']]) {
      const signal = K(id, P(makeTrafficSignal(kind)), { maxDist: 300, cap: 160 });
      // the lens part needs a per-instance phase so opposing approaches show opposite aspects
      if (signal) for (const part of signal.parts) if (part.geometry.getAttribute('aLens')) part.attr = 'aPhase';
    }
    K('sign_post', P(makeSignPost()), { maxDist: 210, cap: 800 });
    for (const [id, tile, size] of [
      ['sign_stop', SIGN_TILES.stop, 0.72], ['sign_yield', SIGN_TILES.yield, 0.74],
      ['sign_speed50', SIGN_TILES.speed50, 0.66], ['sign_speed30', SIGN_TILES.speed30, 0.66],
      ['sign_noparking', SIGN_TILES.noParking, 0.6], ['sign_crossing', SIGN_TILES.crossing, 0.62],
      ['sign_parking', SIGN_TILES.parking, 0.6], ['sign_priority', SIGN_TILES.priority, 0.66],
      ['sign_oneway', SIGN_TILES.oneWay, 0.7], ['sign_busstop', SIGN_TILES.busStop, 0.62],
    ]) K(id, P(makeSignPanel(tile, size), { cast: false }), { maxDist: 190, cap: 220 });
    for (let r = 0; r < 4; r++) K(`name_blade_${r}`, P(makeNameBlade(r), { cast: false }), { maxDist: 160, cap: 120 });

    // --- shelters, cars, greenery, fences, clutter
    K('bus_shelter', P(makeBusShelter()), { maxDist: 300, cap: 60, reflected: true });
    for (const style of ['sedan', 'hatch', 'estate', 'van']) {
      K(`car_${style}`, P(makeCar(style), { tintMat: 'car_paint' }), { maxDist: 210, cap: 190, tint: true });
    }
    K('hedge', P(makeHedge(881), { tintMat: ['hedge', 'hedge_leaf'] }), { maxDist: 220, cap: 1500, tint: true });
    K('fence_picket', P(makePicketFence()), { maxDist: 210, cap: 1000 });
    K('fence_chain', P(makeChainFence()), { maxDist: 210, cap: 800 });
    K('bollard', P(makeBollard(), { cast: false }), { maxDist: 120, cap: 300 });
    K('cycle_stand', P(makeCycleStand(), { cast: false }), { maxDist: 120, cap: 220 });
    K('news_box', P(makeNewsBox()), { maxDist: 120, cap: 160 });
    K('driveway', P(makeApron(), { cast: false }), { maxDist: 180, cap: 500 });
    // shrubs: procedural card domes (the CC0 bush is a photogrammetry card cluster that cannot be
    // decimated without turning to mush, and undecimated it costs more than a whole street tree)
    K('bush_a', P(makeShrub(311, 0), { cast: false, tintMat: 'hedge_leaf' }), { maxDist: 165, cap: 700, tint: true });
    K('bush_b', P(makeShrub(733, 1), { cast: false, tintMat: 'hedge_leaf' }), { maxDist: 165, cap: 700, tint: true });

    // --- glTF props
    const M = (variant, o = {}) => {
      const m = models[variant];
      if (!m) return null;
      return m.parts.map((p) => {
        const n = (p.material.name || '').toLowerCase();
        const thin = n.includes('glass') || n.includes('bulb');
        return { geometry: p.geometry, material: p.material, cast: o.cast !== false && !thin, receive: true, tint: false };
      });
    };
    // a shadow caster costs one draw call per cascade — only props with a shadow worth seeing cast
    const gk = (id, variant, opts = {}) => { const p = M(variant, opts); if (p) K(id, p, opts); };
    gk('bench', 'bench', { maxDist: 190, cap: 340 });
    gk('bin', 'bin', { cast: false, maxDist: 140, cap: 300 });
    gk('bin_rust', 'bin_rust', { cast: false, maxDist: 140, cap: 200 });
    gk('hydrant', 'hydrant', { cast: false, maxDist: 120, cap: 240 });
    gk('hydrant_aged', 'hydrant_aged', { cast: false, maxDist: 120, cap: 160 });
    gk('planter', 'planter', { cast: false, maxDist: 175, cap: 300 });
    gk('lamp_classic', 'lamp_classic', { maxDist: 330, cap: 180 });
    gk('car_covered', 'car_covered', { maxDist: 200, cap: 90 });

    // --- ground cover: short-range, hard-capped, per-instance tinted
    TUFTS.forEach((k, i) => {
      K(k, P(makeGrassTuft(1301 + i * 197, i, k), { cast: false, tintMat: k }),
        { maxDist: 80, cap: 3000, tint: true, noAo: true });
    });
    K('rock_small', P(makeRock(457), { cast: false }), { maxDist: 95, cap: 260 });

    // --- lot dressing
    K('mailbox', P(makeMailbox(), { cast: false }), { maxDist: 125, cap: 320 });
    K('wheelie_bin', P(makeWheelieBin(), { cast: false }), { maxDist: 135, cap: 340 });
    K('utility_box', P(makeUtilityBox(), { cast: false }), { maxDist: 155, cap: 220 });
    K('a_board', P(makeAboard(), { cast: false }), { maxDist: 110, cap: 180 });
    K('garden_shed', P(makeGardenShed()), { maxDist: 175, cap: 160 });
    K('slab', P(makeGroundQuad('slab'), { cast: false }), { maxDist: 135, cap: 1100, noAo: true });
    K('bed', P(makeGroundQuad('bed'), { cast: false }), { maxDist: 135, cap: 460, noAo: true });
    K('contact', P(makeGroundQuad('contact'), { cast: false, receive: false }),
      { maxDist: 130, cap: 2000, noAo: true });
    K('lightpool', P(makeGroundQuad('lightpool'), { cast: false, receive: false }),
      { maxDist: 260, cap: 700, noAo: true, nightOnly: true });

    // halo billboards (own kind, unlit + additive)
    K('halo', [{ geometry: makeHaloQuad(), material: this.haloMaterial, cast: false, receive: false, tint: false }],
      { maxDist: 340, cap: 320 });

    return this.kinds;
  }

  /** Drive night state: emissive luminaires, halo strength, signal cycle time, wind. */
  setNight(nightFactor, elapsed, env) {
    this.shared.uNight.value = nightFactor;
    this.shared.uTime.value = elapsed;
    if (env && env.wind) {
      const s = typeof env.windStrength === 'number' ? env.windStrength : 0.6;
      this.shared.uWind.value.set(env.wind.x || 0.7, env.wind.y || 0.7, 0.35 + 0.9 * s);
    }
    for (const { mat, intensity } of this.nightMaterials) mat.emissiveIntensity = intensity * nightFactor;
    if (this.haloMaterial) this.haloMaterial.uniforms.uIntensity.value = 0.55 * nightFactor;
    // linear peak radiance of a pool; CS2's lit night asphalt measures Y 0.059, p90 0.149
    if (this.poolMaterial) this.poolMaterial.color.setRGB(1.0, 0.86, 0.66).multiplyScalar(POOL_PEAK * nightFactor);
  }

  dispose() {
    for (const t of this.disposables) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    if (this.haloMaterial) this.haloMaterial.dispose();
    for (const k of this.kinds.values()) {
      for (const p of k.parts) p.geometry.dispose();
      if (k.lodParts) for (const p of k.lodParts) p.geometry.dispose();
    }
    this.kinds.clear();
  }
}
