/**
 * Wet-look / puddles / rain ripples / snow cover for EVERY lit material in the scene — without
 * cooperation from other modules.
 *
 * Mechanism: `engine.addMaterialHook` (core's sanctioned global material hook). Every material that goes
 * through `engine.registerMaterial` — which every module must call for CSM — receives the patch, existing
 * ones are recompiled by core when the hook is added, and core re-scans the scene for unregistered
 * materials on `markMaterialsDirty()` (we trigger it on modules:ready / game:ready).
 *
 * The injected code is IDENTICAL for every material (cache-key safe); per-material behaviour is a
 * uniform: `material.userData.noWetness = true` → 0, `material.userData.wetness = 0.5` → half strength,
 * names matching water/sky/glass → 0, transmission materials → 0. Puddles are a second per-material
 * uniform: `userData.noPuddles` / `userData.puddles = 0.5`, alpha-tested (foliage) and terrain / vegetation
 * names → 0, so pools form on roads, pavements and roofs but never in the grass. Materials that already use the
 * opt-in helper from src/shared/wetness.js are left alone.
 *
 * Wetness itself is `engine.globalUniforms.uWetness` (0 dry … 1 soaked), written by index.js every
 * frame, so other modules / custom shaders can read the same value.
 *
 * Injection points:
 *  - `#include <lights_physical_fragment>`: `diffuseColor`, `roughnessFactor`, `metalnessFactor`, `normal`
 *    and `nonPerturbedNormal` are in scope and not yet copied into the `material` struct.
 *  - `#include <lights_fragment_end>`: `radiance` (IBL specular) is boosted inside puddles so they mirror
 *    the live sky probe; afterwards a Fresnel-weighted sky term and a blue snow-shadow tint are added
 *    to `reflectedLight`.
 * World position is reconstructed from `vViewPosition`, so vertex shaders are untouched (composes with
 * wind sway, splat maps, road markings).
 *
 * Effect:
 *  - wet: albedo ×0.55 on upward faces (MATERIAL_TARGET), ×0.24 on walls with vertical streak noise, and
 *    **roughness 0.20** — the target number for wet asphalt, up from a 0.28-0.40 floor that read matte.
 *    The normal map is KEPT (flatten ≤ 0.30): damp tarmac must not end up smoother than dry tarmac.
 *  - wet sheen: indirect specular ×1.85 + a Fresnel sky term on wet upward faces, because
 *    `scene.environmentIntensity` is 0.52 and a 0.20-roughness dielectric otherwise returns nothing.
 *  - puddles: on the ROAD they are real geometry (PuddleField.js) in the gutters and wheel ruts; off-road
 *    hard surfaces keep a low-frequency shader field at roughness 0.06 over a ×0.18 bed. The drainage map
 *    (world-space RGBA, R pool / G tyre band / B corridor) keeps the two from overlapping.
 *  - rain ripples: expanding rings perturb the normal ONLY inside puddles (rain only, near the camera)
 *  - snow: upward faces blend to bright snow albedo with noise micro-normals, sparkle glints near the camera,
 *    high roughness and blue-tinted indirect light (shadows on snow read blue)
 */
import * as THREE from 'three';
import { WETNESS, WETNESS_SNOW } from '../../shared/wetness.js';
import { FX_NOISE_GLSL } from './wetGlsl.js';

/** Shared uniform objects (besides engine.globalUniforms.uWetness): every patched material references the same instances. */
export const WET_UNIFORMS = {
  uFxRipple: { value: 0 },      // 0 … 1 current rain intensity (ripples animate only while it rains)
  uFxSnow: { value: 0 },        // 0 … 1 snow cover
  uFxTime: { value: 0 },
  uFxSky: { value: new THREE.Color(0.3, 0.4, 0.6) },   // hemisphere sky radiance (renderer units)
  uFxSun: { value: 0 },         // sun-up factor 0..1 (sparkle needs direct light)
  // World-space drainage map published by PuddleField: R pool, G ploughed tyre band, B road corridor.
  // xf = (originX, originZ, 1/spanMetres, hasMap). Sampled by world XZ, so it composes with every
  // material regardless of that material's own UV convention — see the note on USE_UV below.
  uFxPoolMap: { value: null },
  uFxPoolXf: { value: new THREE.Vector4(0, 0, 0, 0) },
};

const PARS = /* glsl */ `
uniform float uFxWet;
uniform float uFxWetStrength;
uniform float uFxPuddleStrength;   // per material: 0 on terrain / vegetation (ground cover pokes through pools)
uniform float uFxSnowStrength;     // per material: carriageways keep a partly cleared surface (0.3)
uniform float uFxTrack;            // 1 on carriageway materials: ploughed tyre bands from the drainage map
uniform float uFxRipple;
uniform float uFxSnow;
uniform float uFxTime;
uniform vec3 uFxSky;
uniform float uFxSun;
uniform sampler2D uFxPoolMap;
uniform vec4 uFxPoolXf;
${FX_NOISE_GLSL}
/** (pool, tyre band, road corridor) at a world XZ position; all 0 outside the mapped area. */
vec3 fxDrainage(vec2 xz) {
  if (uFxPoolXf.w < 0.5) return vec3(0.0);
  vec2 uv = (xz - uFxPoolXf.xy) * uFxPoolXf.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  return texture2D(uFxPoolMap, uv).rgb;
}
/** gradient (dh/dx, dh/dz) of a field of expanding rain rings on a 1-unit grid. */
vec2 fxRingGradient(vec2 p, float t, float speed) {
  vec2 g = vec2(0.0);
  vec2 cell = floor(p);
  for (int j = -1; j <= 0; j++) for (int i = -1; i <= 0; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    vec2 h = fxHash2(c);
    vec2 centre = c + 0.5 + (h - 0.5) * 0.9;
    float ph = fract(t * speed + h.x * 7.31 + h.y * 3.17);       // 0..1 over one ring lifetime
    vec2 d = p - centre;
    float r = length(d);
    float ring = ph * 0.8;
    float w = 0.04 + ph * 0.05;
    float x = (r - ring) / w;
    float amp = exp(-x * x) * (1.0 - ph) * (1.0 - ph);
    g += (d / max(r, 1e-3)) * amp * (-2.0 * x / w);
  }
  return g;
}
`;

const INJECT = /* glsl */ `
float fxPuddle = 0.0;
float fxSnowW = 0.0;
float fxNdV = 1.0;
float fxWetSheen = 0.0;
{
  float fxW = uFxWet * uFxWetStrength;
  float fxS = uFxSnow * uFxWetStrength * uFxSnowStrength;
  if (fxW + fxS > 0.002) {
    vec3 fxWorld = cameraPosition + (-vViewPosition) * mat3(viewMatrix);      // view → world (rigid)
    vec3 fxUpV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);      // world up in view space
    vec3 fxN0 = normalize(nonPerturbedNormal);
    float fxUp = clamp(dot(fxN0, fxUpV), 0.0, 1.0);
    float fxFlat = smoothstep(0.80, 0.97, fxUp);
    float fxDist = length(vViewPosition);
    fxNdV = clamp(dot(fxN0, normalize(vViewPosition)), 0.0, 1.0);
    vec3 fxDry = diffuseColor.rgb;

    // ---------- wet ----------
    if (fxW > 0.002) {
      // walls: darker in vertical streaks (run-off), stronger low on the wall; roofs/ground: uniform soak
      float streak = fxValueNoise(vec2(fxWorld.x + fxWorld.z, fxWorld.y * 0.12) * vec2(2.6, 1.0)) * 0.55
                   + fxValueNoise(vec2(fxWorld.x - fxWorld.z, fxWorld.y * 0.35) * vec2(7.0, 1.0)) * 0.45;
      float wallW = fxW * (0.30 + 0.45 * smoothstep(0.35, 0.8, streak));
      float wetW = mix(wallW, fxW, fxUp);
      // Wet asphalt: albedo x0.55 on the flat (docs/MATERIAL_TARGET.md). The previous x0.44 crushed the
      // road into the black floor; the target is a DARK surface with a specular lobe, not a black card.
      diffuseColor.rgb *= 1.0 - mix(0.26, 0.45, fxUp) * wetW;
      // THE number this whole pass exists for: wet asphalt roughness 0.20 (dry is 0.65-0.90). Below ~0.20
      // a normal-mapped surface starts aliasing its own specular into white grains, so the floor rises
      // with distance instead of the grain being erased.
      float fxLod = smoothstep(14.0, 70.0, fxDist);
      float wetRough = mix(0.20, 0.34, fxLod);
      roughnessFactor = mix(roughnessFactor, min(roughnessFactor, wetRough), wetW);
      // Water fills the pores a LITTLE. The old 0.82-0.98 flatten erased the aggregate grain and made the
      // wet road measurably flatter than the dry one (local luminance std 0.218 -> 0.164) — the exact
      // regression the critic named. Damp tarmac keeps its normal map; only standing water is glass.
      normal = normalize(mix(normal, fxN0, wetW * mix(0.16, 0.30, fxLod)));

      // ---- where the water actually stands ----
      // Road pools are GEOMETRY now (PuddleField.js) — real discs in the gutters and wheel ruts, built
      // from world.roads. The drainage map tells us where the road corridor is so this shader-side field
      // does not double up on it; off-road hard surfaces (pavement, forecourts, roofs, yards) still get
      // their pools from here, where there is no polyline to hang geometry off.
      vec3 drain = fxDrainage(fxWorld.xz);
      float offRoad = 1.0 - smoothstep(0.25, 0.65, drain.b);
      float pn = fxValueNoise(fxWorld.xz * 0.20) * 0.70 + fxValueNoise(fxWorld.xz * 0.52 + 17.3) * 0.30;
      float thr = 0.735 - 0.075 * fxW;
      float fill = smoothstep(0.22, 0.70, fxW);
      float rim = smoothstep(thr - 0.09, thr, pn) * fill;
      float mask = smoothstep(thr - 0.005, thr + 0.022, pn) * fill;
      float distF = (1.0 - smoothstep(120.0, 320.0, fxDist)) * uFxPuddleStrength * offRoad;
      fxPuddle = mask * fxFlat * distF;
      rim *= fxFlat * distF;
      if (rim > 0.001) {
        // shore band: saturated, darker than the plain damp ground, still rough (no gloss ring)
        diffuseColor.rgb *= 1.0 - 0.16 * rim;
        roughnessFactor = mix(roughnessFactor, mix(0.22, 0.36, fxLod), rim);
      }
      if (fxPuddle > 0.001) {
        // inside the pool: standing water over a dark bed at the MATERIAL_TARGET puddle roughness of
        // 0.06. The IMAGE in the mirror comes from the sky probe plus the GroundFXPass screen-space
        // march; the material supplies the dark water, the flat normal and the specular lobe.
        diffuseColor.rgb = mix(diffuseColor.rgb, fxDry * 0.18, fxPuddle);
        roughnessFactor = mix(roughnessFactor, 0.06, fxPuddle);
        metalnessFactor = mix(metalnessFactor, 0.0, fxPuddle);
        normal = normalize(mix(normal, fxUpV, fxPuddle * 0.97));
        float rip = uFxRipple * smoothstep(0.2, 0.6, fxPuddle) * (1.0 - smoothstep(26.0, 70.0, fxDist));
        if (rip > 0.002) {
          vec2 g = fxRingGradient(fxWorld.xz * 2.4, uFxTime, 2.4) * 0.6 + fxRingGradient(fxWorld.xz * 1.1 + 5.0, uFxTime, 1.6) * 0.4;
          vec3 gv = mat3(viewMatrix) * vec3(g.x, 0.0, g.y);
          normal = normalize(normal - gv * rip * 0.035);
        }
      }
      // impact rings on the DAMP sheen outside the pools too — wet asphalt within ~26 m of the camera
      // shimmers with rain hits, which is what sells "it is raining" on a close-up street shot
      float ripF = uFxRipple * fxFlat * (1.0 - fxPuddle) * (1.0 - smoothstep(12.0, 34.0, fxDist)) * uFxPuddleStrength;
      if (ripF > 0.002) {
        vec2 g = fxRingGradient(fxWorld.xz * 3.1 + 2.0, uFxTime, 3.0);
        vec3 gv = mat3(viewMatrix) * vec3(g.x, 0.0, g.y);
        normal = normalize(normal - gv * ripF * 0.012);
      }
      // the sheen a wet surface owes the sky. scene.environmentIntensity is 0.52, so a wet road that is
      // physically a 0.20-roughness dielectric still returns almost nothing from the probe — this is the
      // compensation, weighted to flat, upward faces, and it is what makes rain read as WET not matte.
      fxWetSheen = fxW * fxFlat;
    }
    // ---------- snow ----------
    if (fxS > 0.002) {
      // coverage ∝ fxS: a noise height field is thresholded so a 30 % cover (carriageways) really shows
      // ~30 % of the surface white — patchy at low cover, continuous with soft drifts when deep; walls and
      // tank sides stay clean (fxUp > ~0.6)
      // LOW-frequency coverage field: metre-scale drifts, not centimetre speckle. The finest octave is
      // only 15 % of the field so a partly-cleared road reads as smooth patches, never as confetti.
      float sn = fxValueNoise(fxWorld.xz * 0.30) * 0.55 + fxValueNoise(fxWorld.xz * 1.05 + 7.0) * 0.30
               + fxValueNoise(fxWorld.xz * 3.7) * 0.15;
      float drift = fxValueNoise(fxWorld.xz * 0.11 + 41.0);
      float upW = smoothstep(0.50, 0.74, fxUp);
      float cov = clamp(fxS * (0.80 + 0.45 * drift), 0.0, 1.0) * upW;
      float slush = 0.0;
      float band = 0.30;                       // threshold softness → smooth shores
      // Tyre tracks come from the drainage map's G channel — the REAL wheel positions of the REAL lanes,
      // rasterised from world.roads. (The previous version read vUv.x inside an #ifdef USE_UV; three r185
      // never defines USE_UV for a standard material, so that branch never compiled in and every snow
      // frame fell through to the un-ploughed path.)
      if (uFxTrack > 0.5) {
        float g = fxDrainage(fxWorld.xz).g;
        slush = smoothstep(0.18, 0.85, g) * smoothstep(0.02, 0.15, fxS);
        cov *= 1.0 - 0.98 * slush;
        band = mix(band, 0.11, smoothstep(0.1, 0.5, g));
      }
      float thr = 1.0 - cov;
      float snowW = smoothstep(thr - band, thr + 0.10, sn) * smoothstep(0.02, 0.2, fxS) * upW;
      fxSnowW = snowW;
      if (slush > 0.001) {
        // wet dark slush in the wheel grooves
        float sl = slush * (1.0 - snowW) * fxUp;
        diffuseColor.rgb *= 1.0 - 0.40 * sl;
        roughnessFactor = mix(roughnessFactor, 0.5, sl * 0.6);
      }
      if (snowW > 0.001) {
        // fresh snow is one of the brightest natural surfaces (albedo ≈ 0.85): it must reach paper white
        // under sun, with a metre-scale mottle that still reads from the 235 m hero distance
        float mottle = fxValueNoise(fxWorld.xz * 0.22 + 13.0);
        vec3 snowCol = vec3(0.955, 0.965, 0.995) * (0.88 + 0.12 * sn) * (0.93 + 0.09 * drift) * (0.94 + 0.11 * mottle);
        // partly cleared surfaces carry dirty grey slush instead of clean snow
        float dirt = clamp((1.0 - uFxSnowStrength) * 1.2, 0.0, 0.8);
        snowCol = mix(snowCol, vec3(0.52, 0.53, 0.55), dirt * (0.45 + 0.55 * (1.0 - sn)));
        // micro-normals from the noise gradient (finite differences) so the sheet catches light
        float e = 0.08;
        float h0 = fxValueNoise(fxWorld.xz * 3.7) * 0.7 + fxValueNoise(fxWorld.xz * 11.0) * 0.3;
        float hx = fxValueNoise((fxWorld.xz + vec2(e, 0.0)) * 3.7) * 0.7 + fxValueNoise((fxWorld.xz + vec2(e, 0.0)) * 11.0) * 0.3;
        float hz = fxValueNoise((fxWorld.xz + vec2(0.0, e)) * 3.7) * 0.7 + fxValueNoise((fxWorld.xz + vec2(0.0, e)) * 11.0) * 0.3;
        vec2 grad = vec2(hx - h0, hz - h0) / e;
        float nAmp = 0.5 * (1.0 - smoothstep(60.0, 220.0, fxDist));
        // large-scale drift undulation on top of the fine crust
        float dx = fxValueNoise((fxWorld.xz + vec2(0.5, 0.0)) * 0.11 + 41.0) - drift;
        float dz = fxValueNoise((fxWorld.xz + vec2(0.0, 0.5)) * 0.11 + 41.0) - drift;
        vec3 snowN = normalize(mat3(viewMatrix) * vec3(-grad.x * nAmp - dx * 2.0, 1.0, -grad.y * nAmp - dz * 2.0));
        // sparkle: 2-3 % sub-centimetre ice facets, twinkling, in direct sun, fading out by ~90 m
        // cells grow with distance so a facet never falls below a pixel (that is what turns sparkle into
        // aliased white dots), and the whole term is gone by 70 m
        float cellScale = mix(22.0, 5.0, smoothstep(8.0, 70.0, fxDist));
        vec3 cellP = floor(fxWorld * cellScale);
        float gh = fxHash1(cellP.xz * 1.7 + cellP.y * 3.1);
        float tw = 0.5 + 0.5 * sin(uFxTime * 4.0 + gh * 60.0 + fxNdV * 20.0);
        float glint = step(0.974, gh) * tw * (1.0 - smoothstep(12.0, 70.0, fxDist)) * uFxSun * (1.0 - dirt);
        diffuseColor.rgb = mix(diffuseColor.rgb, snowCol + glint * 1.8, snowW);
        roughnessFactor = mix(roughnessFactor, 0.62 + 0.1 * dirt, snowW);
        metalnessFactor = mix(metalnessFactor, 0.0, snowW);
        normal = normalize(mix(normal, mix(nonPerturbedNormal, snowN, fxUp), snowW * 0.85));
      }
    }
  }
}
#include <lights_physical_fragment>
`;

// before the indirect light is applied: puddles mirror the live sky probe
const INJECT_RADIANCE = /* glsl */ `
#include <lights_fragment_end>
{
  if (fxWetSheen > 0.001) {
    // THE fix for "it is raining hard and the asphalt has zero specular reflection". A 0.20-roughness
    // dielectric should return a bright, Fresnel-weighted sky; scene.environmentIntensity is 0.52, so it
    // returns half of one. Restore the missing half on wet, upward faces only — grazing angles brightest,
    // which is exactly where a wet street reads as wet.
    float Fw = 0.04 + 0.96 * pow(1.0 - fxNdV, 5.0);
    reflectedLight.indirectSpecular *= 1.0 + 0.40 * fxWetSheen;
    reflectedLight.indirectSpecular += uFxSky * Fw * fxWetSheen * 0.045;
  }
  if (fxPuddle > 0.001) {
    // Fresnel-weighted sky term: a pool mirrors the sky even when the scene has no environment probe,
    // and at grazing angles (F → 1) it goes bright — which is what makes a puddle READ as standing water
    float F = 0.03 + 0.97 * pow(1.0 - fxNdV, 4.0);
    reflectedLight.indirectSpecular += uFxSky * F * fxPuddle * 0.15;
  }
  if (fxSnowW > 0.001) {
    // snow shadows read blue: tint the indirect (sky) light, leave the direct sun white
    reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.80, 0.88, 1.16), fxSnowW);
    reflectedLight.indirectSpecular *= mix(vec3(1.0), vec3(0.88, 0.94, 1.10), fxSnowW);
  }
}
`;

const SKIP_NAME = /sky|cloud|water|glass|window|ocean|river|lake/i;
const NO_PUDDLE_NAME = /terrain|ground|grass|veg|verge|median|leaf|leaves|foliage|tree|bark|undergrowth|plant|flower|hedge|lawn|impostor|dirt|gravel/i;

/** Snow cover per material: carriageways 48 % with ploughed tyre bands, pavements / kerbs 92 %, everything else the full sheet. */
function snowStrengthFor(material) {
  const ud = material.userData || {};
  if (typeof ud.snow === 'number') return Math.max(0, Math.min(1, ud.snow));
  const n = material.name || '';
  if (/^roads\/asphalt/.test(n)) return 0.48;
  if (/^roads\/(sidewalk|curb|kerb|apron|verge|path|barrier)/.test(n)) return 0.92;
  if (/^roads\//.test(n)) return 0.85;
  return 1;
}
/** Tyre tracks only on carriageway materials (the drainage map supplies the real wheel positions). */
function trackFor(material) {
  const ud = material.userData || {};
  if (typeof ud.snowTracks === 'number') return ud.snowTracks;
  return material.name && /^roads\/asphalt/.test(material.name) ? 1 : 0;
}

/** Puddles only on hard surfaces: never on terrain / vegetation (ground cover pokes through the pools). */
function puddleStrengthFor(material) {
  const ud = material.userData || {};
  if (ud.noPuddles) return 0;
  if (typeof ud.puddles === 'number') return Math.max(0, Math.min(1, ud.puddles));
  if (material.alphaTest > 0) return 0;
  if (material.name && NO_PUDDLE_NAME.test(material.name)) return 0;
  return 1;
}

/** Per-material wetness strength (uniform, so shared programs stay valid). */
function strengthFor(material) {
  const ud = material.userData || {};
  if (ud.noWetness) return 0;
  if (typeof ud.wetness === 'number') return Math.max(0, Math.min(1, ud.wetness));
  if (material.transmission > 0) return 0;
  if (material.name && SKIP_NAME.test(material.name)) return 0;
  return 1;
}

/**
 * Install the automatic path via engine.addMaterialHook.
 * Returns { state:{patched}, sweep(), update(...), dispose() }.
 */
export function installWetSurfaces(engine, scene, events) {
  const state = { patched: 0 };
  const seen = new WeakSet();
  const G = engine.globalUniforms;

  const hook = (shader, material) => {
    if (!material || !(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return;
    if (material.userData && material.userData.__wetness) return;          // opted into src/shared/wetness.js already
    if (material.userData && material.userData.fxSkipHook) return;         // effects' own water/decal materials
    const fs = shader.fragmentShader;
    if (fs.indexOf('#include <lights_physical_fragment>') < 0 || fs.indexOf('#include <lights_fragment_end>') < 0 || fs.indexOf('uFxWet') >= 0) return;
    shader.uniforms.uFxWet = G.uWetness;
    shader.uniforms.uFxWetStrength = { value: strengthFor(material) };
    shader.uniforms.uFxPuddleStrength = { value: puddleStrengthFor(material) };
    shader.uniforms.uFxSnowStrength = { value: snowStrengthFor(material) };
    shader.uniforms.uFxTrack = { value: trackFor(material) };
    shader.uniforms.uFxRipple = WET_UNIFORMS.uFxRipple;
    shader.uniforms.uFxSnow = WET_UNIFORMS.uFxSnow;
    shader.uniforms.uFxTime = WET_UNIFORMS.uFxTime;
    shader.uniforms.uFxSky = WET_UNIFORMS.uFxSky;
    shader.uniforms.uFxSun = WET_UNIFORMS.uFxSun;
    shader.uniforms.uFxPoolMap = WET_UNIFORMS.uFxPoolMap;
    shader.uniforms.uFxPoolXf = WET_UNIFORMS.uFxPoolXf;
    const hasGeomNormal = fs.indexOf('#include <normal_fragment_begin>') >= 0 || fs.indexOf('nonPerturbedNormal') >= 0;
    const inject = hasGeomNormal ? INJECT : INJECT.replace(/nonPerturbedNormal/g, 'normal');
    shader.fragmentShader = fs
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <lights_physical_fragment>', inject)
      .replace('#include <lights_fragment_end>', INJECT_RADIANCE);
    if (!seen.has(material)) { seen.add(material); state.patched++; }
  };
  const off = engine.addMaterialHook(hook);

  // Materials that were registered AND compiled before this hook existed keep their cached program:
  // three.js reuses a material's program when its cache key is unchanged, so core's recompile request
  // (needsUpdate) alone never re-runs onBeforeCompile. Bump their cache key once so they really recompile.
  const bump = (m) => {
    if (!m || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) || m.userData.__fxWetKey) return;
    m.userData.__fxWetKey = true;
    const prev = m.customProgramCacheKey;
    const isDefault = !prev || prev === THREE.Material.prototype.customProgramCacheKey;
    m.customProgramCacheKey = function () { return (isDefault ? '' : String(prev.call(this))) + '|fxwet5'; };
    m.needsUpdate = true;
  };
  const registered = engine._registeredList instanceof Set ? Array.from(engine._registeredList) : [];
  if (registered.length) registered.forEach(bump);
  else scene.traverse((o) => { const m = o.material; if (Array.isArray(m)) m.forEach(bump); else bump(m); });

  // core re-scans the scene and registers anything a module forgot → the hook reaches it
  const sweep = () => { engine.markMaterialsDirty(); return state.patched; };
  const offs = [events.on('modules:ready', sweep), events.on('game:ready', sweep), events.on('terrain:ready', sweep)];

  return {
    state,
    sweep,
    /** Per-frame driver. */
    update(wet, rain, snow, time, skyRadiance, sunUp) {
      G.uWetness.value = wet;
      WET_UNIFORMS.uFxRipple.value = rain;
      WET_UNIFORMS.uFxSnow.value = snow;
      WET_UNIFORMS.uFxTime.value = time;
      if (skyRadiance) WET_UNIFORMS.uFxSky.value.copy(skyRadiance);
      WET_UNIFORMS.uFxSun.value = sunUp ?? 1;
      // keep the round-1 shared helper alive for modules that adopted it
      WETNESS.value = wet;
      WETNESS_SNOW.value = snow;
    },
    dispose() {
      for (const o of offs) o();
      off();
    },
  };
}
