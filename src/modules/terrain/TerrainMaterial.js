/**
 * Splat-mapped PBR terrain material — a MeshStandardMaterial patched via onBeforeCompile so it stays
 * compatible with the engine's cascaded shadow maps, fog, tone mapping and GTAO.
 *
 * Layers (sampler2DArray): 0 grass, 1 dry grass, 2 dirt, 3 rock A, 4 sand, 5 wet mud, 6 rock B,
 * 7 forest floor. Snow is analytic (albedo + rock normals) above a noisy, aspect-dependent snow line.
 *  - weights come from a CPU control map (in-map: two RGBA textures — dry/dirt/sand/rockBoost and
 *    canopy/field/–/curvature; horizon: the `aCtrl` vertex attribute computed by the same GroundControl
 *    rules), per-pixel slope (in-map: heightmap-derived world-normal texture; horizon: interpolated
 *    vertex normal) and a signed shore-distance texture (in-map) so wet band, sand bed and soft shore
 *    are NOT defined by the triangle facets of the mesh
 *  - the SAME splat logic runs inside and outside the playable map → no visible boundary
 *  - rock outcrops from ~30° slope (noise-jittered) everywhere, full rock on cliffs; low steep cut banks
 *    blend rock strata with soil (triplanar, two CC0 rock sets) instead of a flat dirt smear
 *  - each layer is sampled at two scales, blended with a macro noise → no visible tiling
 *  - near the camera (< 300 m) 0.55 m + 2.2 m grass micro-layers and sparse high-frequency scree add structure
 *  - curvature (cavity) shading (half strength): hollows greener, knolls warmer/drier; 100-430 m regional
 *    colour drift so no two hills match; global desaturation towards a warm grey and an albedo ceiling
 *  - the shoreline is a wet DARKENING of whatever cover is there (peaking at the waterline), and the
 *    sand threshold is noise-broken, so beaches never read as a constant-width beige ribbon
 *  - `uNight` (fed from env.nightFactor) makes vegetated ground matte and cool at night — no grazing
 *    specular smears on west-facing slopes
 *  - `uInfoTint` desaturates/darkens the ground while an info view overlay is active
 */
import * as THREE from 'three';
import { LAYERS } from './textures.js';

export function createTerrainMaterial({ albedoArray, normalArray, controlTex, control2Tex, normalTex, noiseTex, shoreTex = null, shoreN = 1, spacing = 2, half, size, waterLevel, horizon = false, globalUniforms = null }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  mat.name = horizon ? 'terrain-splat-horizon' : 'terrain-splat';

  const uniforms = {
    uAlbedo: { value: albedoArray },
    uNormalArr: { value: normalArray },
    uControl: { value: controlTex },
    uControl2: { value: control2Tex },
    uTerrainNormal: { value: normalTex },
    uNoise: { value: noiseTex },
    uShore: { value: shoreTex },
    uShoreN: { value: shoreN },
    uSpacing: { value: spacing },
    uHalf: { value: half },
    uSize: { value: size },
    uWaterLevel: { value: waterLevel },
    uScales: { value: LAYERS.map((l) => l.scale) },
    uDetailFade: { value: new THREE.Vector2(480, 2200) },
    uNearFade: { value: new THREE.Vector2(70, 300) },
    uSnowLine: { value: 172 },
    uInfoTint: { value: 0 },
    uNight: { value: 0 },
    // wired to engine.globalUniforms.uWetness below so rain really drives the specular lobe
    uWetness: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0.3, 0.9, 0.3) },
  };
  mat.userData.uniforms = uniforms;
  mat.defines = mat.defines || {};
  if (horizon) mat.defines.HORIZON_CTRL = 1;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // share the engine's live wetness uniform object so weather really reaches the ground
    if (globalUniforms && globalUniforms.uWetness) shader.uniforms.uWetness = globalUniforms.uWetness;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vTWorld;
varying vec3 vTNormal;
#ifdef HORIZON_CTRL
attribute vec4 aCtrl;
varying vec4 vCtrl;
#endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTNormal = normalize(mat3(modelMatrix) * objectNormal);
#ifdef HORIZON_CTRL
vCtrl = aCtrl;
#endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormalArr;
uniform sampler2D uControl;
uniform sampler2D uControl2;
uniform sampler2D uTerrainNormal;
uniform sampler2D uNoise;
uniform sampler2D uShore;
uniform float uShoreN;
uniform float uSpacing;
uniform float uHalf;
uniform float uSize;
uniform float uWaterLevel;
uniform float uScales[8];
uniform vec2 uDetailFade;
uniform vec2 uNearFade;
uniform float uSnowLine;
uniform float uInfoTint;
uniform float uNight;
uniform float uWetness;
uniform vec3 uMoonDir;
varying vec3 vTWorld;
varying vec3 vTNormal;
#ifdef HORIZON_CTRL
varying vec4 vCtrl;
#endif

const mat2 ROT2 = mat2(0.8, -0.6, 0.6, 0.8);
const mat2 ROT3 = mat2(0.36, 0.93, -0.93, 0.36);
const vec3 LUMW = vec3(0.3, 0.59, 0.11);

// two-scale anti-tiling sample of one layer (top projection). alb: rgb colour, a AO; nrm: rgb normal, a roughness
void sampleLayer(float layer, vec2 p, float scale, float blend, float macro, out vec4 alb, out vec4 nrm) {
  vec2 uv1 = p / scale;
  vec2 uv2 = (ROT2 * p) / (scale * 4.3);
  vec4 a1 = texture(uAlbedo, vec3(uv1, layer));
  vec4 a2 = texture(uAlbedo, vec3(uv2, layer));
  vec4 n1 = texture(uNormalArr, vec3(uv1, layer));
  vec4 n2 = texture(uNormalArr, vec3(uv2, layer));
  alb = mix(a1, a2, blend);
  nrm = mix(n1, n2, blend);
  // 20x scale of the SAME photographic set. Beyond ~150 m the 1-4 m scales have mipped down to a flat
  // wash (the "airbrush smudge" look); this band keeps real ground structure at aerial distance.
  if (macro > 0.004) {
    vec3 uv3 = vec3((ROT3 * p) / (scale * 20.0) + 0.63, layer);
    vec3 a3 = texture(uAlbedo, uv3).rgb;
    float mean3 = max(dot(textureLod(uAlbedo, uv3, 7.0).rgb, LUMW), 0.02);
    alb.rgb *= mix(vec3(1.0), clamp(a3 / mean3, vec3(0.42), vec3(2.1)), macro);
  }
}

// triplanar sample of one rock layer; returns world-space normal perturbation in nPert
void sampleRockLayer(float layer, vec3 p, vec3 w, float scale, float big, out vec4 alb, out vec3 nPert, out float rough) {
  vec4 aX = texture(uAlbedo, vec3(p.zy / scale, layer));
  vec4 aY = texture(uAlbedo, vec3(p.xz / scale, layer));
  vec4 aZ = texture(uAlbedo, vec3(p.xy / scale, layer));
  vec4 nX = texture(uNormalArr, vec3(p.zy / scale, layer));
  vec4 nY = texture(uNormalArr, vec3(p.xz / scale, layer));
  vec4 nZ = texture(uNormalArr, vec3(p.xy / scale, layer));
  if (big > 0.0) {
    // rotate the macro sample so the two scales never line up into a visible grid
    vec4 aX2 = texture(uAlbedo, vec3((ROT2 * p.zy) / (scale * 3.7) + 0.31, layer));
    vec4 aY2 = texture(uAlbedo, vec3((ROT2 * p.xz) / (scale * 3.7) + 0.11, layer));
    vec4 aZ2 = texture(uAlbedo, vec3((ROT2 * p.xy) / (scale * 3.7) + 0.57, layer));
    aX = mix(aX, aX2, big); aY = mix(aY, aY2, big); aZ = mix(aZ, aZ2, big);
  }
  alb = aX * w.x + aY * w.y + aZ * w.z;
  vec3 tX = nX.xyz * 2.0 - 1.0, tY = nY.xyz * 2.0 - 1.0, tZ = nZ.xyz * 2.0 - 1.0;
  nPert = vec3(0.0, tX.y, tX.x) * w.x + vec3(tY.x, 0.0, tY.y) * w.y + vec3(tZ.x, tZ.y, 0.0) * w.z;
  rough = nX.a * w.x + nY.a * w.y + nZ.a * w.z;
}

vec3 tangentPert(vec4 n) { return (n.xyz * 2.0 - 1.0).xyy * vec3(1.0, 0.0, 1.0); }`)
      .replace('#include <map_fragment>', `
// ---------------------------------------------------------------- terrain splat -----------------
vec3 tAlbedo; vec3 tNormalWorld; float tRough; float tAO; vec3 tNightFill;
{
  vec2 uvW = (vTWorld.xz + uHalf) / uSize;
  vec4 nzMacro = texture(uNoise, vTWorld.xz / 95.0 + 0.29);     // 30-95 m ground-cover patches
  vec4 nzMid = texture(uNoise, vTWorld.xz / 43.0 + 0.37);
  vec4 nzHuge = texture(uNoise, vTWorld.xz / 1150.0 + 0.71);
  vec4 nzReg = texture(uNoise, vTWorld.xz / 430.0 + 0.13);      // 100-430 m regional colour
  vec4 nzSmall = texture(uNoise, vTWorld.xz / 19.0 + 0.83);     // 6-19 m cover mottling
#ifdef HORIZON_CTRL
  vec3 gN = normalize(vTNormal);
  vec4 ctrl = vec4(vCtrl.x, vCtrl.y, 0.0, vCtrl.w);
  float canopy = vCtrl.z * 0.7;
  float curv = 0.5;
#else
  vec3 gN = normalize(texture(uTerrainNormal, uvW).xyz * 2.0 - 1.0);
  vec4 ctrl = texture(uControl, uvW);
  vec4 ctrl2 = texture(uControl2, uvW);
  float canopy = ctrl2.r;
  float curv = ctrl2.a;                                           // 0.5 flat, < 0.5 hollow, > 0.5 knoll
#endif
  float slope = 1.0 - gN.y;
  float grade = length(gN.xz) / max(gN.y, 0.05);
  // 40 m planform curvature straight off the world-normal map: > 0 in hollows/gullies, < 0 on ridges.
  // This is the landform itself, so the pattern it drives reads as drainage geology, not as airbrush.
  float conc = 0.0;
#ifndef HORIZON_CTRL
  {
    float e = 40.0 / uSize;
    float gx = texture(uTerrainNormal, uvW + vec2(e, 0.0)).r - texture(uTerrainNormal, uvW - vec2(e, 0.0)).r;
    float gz = texture(uTerrainNormal, uvW + vec2(0.0, e)).b - texture(uTerrainNormal, uvW - vec2(0.0, e)).b;
    conc = -(gx + gz) * 3.0;
  }
#endif
  float valleyF = smoothstep(0.03, 0.45, conc);
  float ridgeF = smoothstep(0.03, 0.45, -conc);
  float hAbove = vTWorld.y - uWaterLevel;
  // signed distance to the waterline (+ land). In-map from the distance texture (smooth across facets)
#ifdef HORIZON_CTRL
  float shoreD = clamp(hAbove / max(grade, 0.03), -8.0, 32.0);
#else
  vec2 uvS = ((vTWorld.xz + uHalf) / uSpacing + 0.5) / uShoreN;
  float shoreD = (texture(uShore, uvS).r * 255.0 - 128.0) * 0.25;
#endif
  float viewDist = length(vViewPosition);
  float detail = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, viewDist);
  float nearF = 1.0 - smoothstep(uNearFade.x, uNearFade.y, viewDist);
  float midF = 1.0 - smoothstep(90.0, 260.0, viewDist);
  float blend = smoothstep(0.32, 0.68, nzMid.g);
  float macroW = 1.0 * smoothstep(60.0, 260.0, viewDist);

  // --- weights ---
  float jitter = (nzMid.b - 0.5) * 0.10;
  float highland = smoothstep(14.0, 42.0, hAbove);
  // rock outcrops from ~36°, solid rock by ~53°; hills expose more than the low banks
  float rockSlope = smoothstep(0.19 + jitter, 0.40 + jitter, slope);
  // break the soil/rock boundary with high-frequency noise so hillsides never read as a soft grey smear
  rockSlope *= smoothstep(0.20, 0.66, 0.42 + 0.8 * (nzMid.b - 0.5) + 0.6 * (nzMacro.g - 0.5) + 1.1 * smoothstep(0.28, 0.50, slope));
  float steep = smoothstep(0.30, 0.47, slope);
  float cut = smoothstep(0.26, 0.44, slope) * (1.0 - highland);   // low, steep river bluffs / cut banks
  // turf and scrub still hold on below ~50°, so rock is not a solid slab on every moderate slope
  float rock = rockSlope * mix(0.62, 1.0, highland) * mix(0.55, 1.0, smoothstep(0.26, 0.46, slope));
  rock = max(rock, ridgeF * smoothstep(0.28, 0.50, slope) * highland * 0.55
    * smoothstep(0.38, 0.74, 0.45 + 0.7 * (nzMid.b - 0.5) + 0.5 * (nzMacro.g - 0.5)));   // broken outcrop on convex breaks
  rock = max(rock, ctrl.a * smoothstep(0.06, 0.20, slope + ctrl.a * 0.3));
  // cut banks: rock strata broken by noise instead of a smooth beige dirt ribbon
  float cutRock = cut * smoothstep(0.32, 0.62, 0.45 + 0.55 * nzMid.r + 0.3 * (nzMacro.b - 0.5));
  rock = max(rock, cutRock * 0.45);
  // scree / thin turf: only on genuinely steep ground, and broken up so it never smears over hillsides
  float scree = smoothstep(0.17, 0.30, slope) * (1.0 - rockSlope) * smoothstep(0.38, 0.68, 0.5 + 0.6 * (nzMacro.g - 0.5) + 0.5 * (nzMid.b - 0.5));
  float bankDirt = cut * 0.38 + scree * 0.14;
  // wet band: a darkening of whatever lies at the waterline (not its own dark mud layer)
  float wetK = (1.0 - smoothstep(0.15, 2.2 + 1.3 * nzMid.r, shoreD)) * smoothstep(-1.1, -0.05, shoreD);
  float bed = smoothstep(0.15, -2.2, shoreD);                      // river / sea bed: silt
  // sand: noise-broken threshold, so beaches have ragged fingers instead of a constant-width ribbon
  float sandBreak = smoothstep(0.30, 0.72, ctrl.b * 1.45 + 0.42 * (nzMid.b - 0.5) + 0.34 * (nzMacro.b - 0.5));
  float sand = sandBreak * (1.0 - smoothstep(0.10, 0.24, slope));
  // snow: line wanders ±50 m at 600-1500 m, lower on north-facing slopes, none on cliffs; wide,
  // soft transition, accumulation in hollows, wind-scoured knolls
  vec4 nzSnowA = texture(uNoise, vTWorld.xz / 1500.0 + 0.23);
  vec4 nzSnowB = texture(uNoise, vTWorld.xz / 620.0 + 0.61);
  float northness = clamp(-gN.z * 2.5, 0.0, 1.0) * smoothstep(0.06, 0.25, slope);
  float snowLine = uSnowLine + 100.0 * (nzSnowA.r - 0.5) + 44.0 * (nzSnowB.r - 0.5) + 14.0 * (nzMid.g - 0.5) - 25.0 * northness + 30.0 * (curv - 0.5);
  float snowSlope = 1.0 - smoothstep(0.16, 0.62, slope + 0.16 * (nzMid.r - 0.5) + 0.12 * (nzMacro.g - 0.5));
  float snow = smoothstep(snowLine - 70.0, snowLine + 80.0, vTWorld.y) * snowSlope;
  // wind-blown transition: ragged fingers of snow reaching down, bare rock reaching up
  snow *= smoothstep(0.24, 0.78, 0.30 + 0.70 * (nzMid.b * 0.5 + nzSmall.r * 0.3 + nzMacro.g * 0.2)
    + 1.30 * smoothstep(snowLine - 5.0, snowLine + 95.0, vTWorld.y));
  float patches = smoothstep(snowLine - 95.0, snowLine - 10.0, vTWorld.y)
    * smoothstep(0.46, 0.92, nzMid.r * 0.5 + nzSnowB.g * 0.5 + 0.18 * (1.0 - smoothstep(0.05, 0.2, slope)) + 0.25 * (0.5 - curv))
    * (1.0 - smoothstep(0.12, 0.30, slope));
  snow = max(snow, patches * 0.9);
  float farFade = 1.0 - 0.55 * smoothstep(150.0, 600.0, viewDist);
  float wMud = bed * 0.55 * (1.0 - sand) * farFade;
  float wSand = sand * (1.0 - wMud);
  float wRock = rock * (1.0 - wMud - wSand);
  float rest = max(0.0, 1.0 - wMud - wSand - wRock);
  float wForest = smoothstep(0.25, 0.85, canopy) * (0.42 + 0.38 * smoothstep(0.35, 0.7, nzMid.b)) * rest;
  float wDirt = clamp(max(ctrl.g, bankDirt), 0.0, 1.0) * (rest - wForest);
  float wDry = clamp(ctrl.r * 0.52 + scree * 0.10, 0.0, 1.0) * (rest - wForest - wDirt);
  float wGrass = max(0.0, rest - wForest - wDirt - wDry);
  // snow replaces everything but a little rock
  float snowW = snow * (1.0 - 0.42 * wRock);
  float keep = 1.0 - snowW;
  wMud *= keep; wSand *= keep; wRock *= keep; wForest *= keep; wDirt *= keep; wDry *= keep; wGrass *= keep;

  // regional colour drift: cool damp green ↔ warm olive/khaki over 100-430 m, so no two hills match
  vec3 region = mix(vec3(0.95, 1.00, 0.94), vec3(1.03, 1.00, 0.90), smoothstep(0.30, 0.72, nzReg.r * 0.65 + nzHuge.g * 0.35));
  region *= 0.96 + 0.08 * nzReg.g;

  vec3 alb = vec3(0.0); vec3 nP = vec3(0.0); float rgh = 0.0; float ao = 0.0;
  vec4 a, n;
  if (wGrass > 0.004) {
    sampleLayer(0.0, vTWorld.xz, uScales[0], blend, macroW, a, n);
    // olive meadow ↔ straw in 30-95 m patches; hollows keep more moisture, knolls burn off
    vec3 tint = mix(vec3(0.44, 0.50, 0.32), vec3(0.60, 0.58, 0.37), smoothstep(0.30, 0.78, nzMacro.r * 0.7 + 0.3 * curv));
    tint = mix(tint, tint * vec3(0.88, 1.02, 0.92), smoothstep(0.5, 0.18, curv));
    alb += a.rgb * tint * region * wGrass; nP += tangentPert(n) * 1.35 * wGrass; rgh += mix(0.94, 1.06, n.a) * wGrass;                    // grass 0.85 ao += a.a * wGrass;
  }
  if (wDry > 0.004) {
    sampleLayer(1.0, vTWorld.xz, uScales[1], blend, macroW, a, n);
    vec3 tint = mix(vec3(0.44, 0.46, 0.32), vec3(0.56, 0.54, 0.38), nzMacro.g);
    alb += a.rgb * tint * region * wDry; nP += tangentPert(n) * 1.35 * wDry; rgh += (0.95 + 0.13 * n.a) * wDry;                       // dry cover 0.86 ao += a.a * wDry;
  }
  if (wDirt > 0.004) {
    sampleLayer(2.0, vTWorld.xz, uScales[2], blend, macroW, a, n);
    // bank / trail soil is damp brown, not pale beige
    vec3 tint = mix(vec3(0.46, 0.40, 0.31), vec3(0.63, 0.57, 0.45), nzMacro.b * 0.6 + 0.4 * (1.0 - cut));
    alb += a.rgb * tint * wDirt; nP += tangentPert(n) * 1.4 * wDirt; rgh += (1.06 + 0.12 * n.a) * wDirt;                      // bare soil 0.95 ao += a.a * wDirt;
  }
  if (wForest > 0.004) {
    sampleLayer(7.0, vTWorld.xz, uScales[7], blend, macroW, a, n);
    vec3 tint = mix(vec3(0.26, 0.25, 0.18), vec3(0.38, 0.35, 0.25), nzMacro.b);
    alb += a.rgb * tint * wForest; nP += tangentPert(n) * wForest; rgh += (0.98 + 0.11 * n.a) * wForest;                    // forest floor 0.88 ao += a.a * wForest;
  }
  if (wRock > 0.004 || snowW > 0.004) {
    vec3 w3 = pow(abs(gN), vec3(5.0)); w3 /= (w3.x + w3.y + w3.z);
    vec3 rpA, rpB; float rrA, rrB; vec4 aA, aB;
    float bigF = 0.42 * (1.0 - smoothstep(260.0, 850.0, viewDist));   // the macro rock scale would moire at range
    sampleRockLayer(3.0, vTWorld, w3, uScales[3], bigF, aA, rpA, rrA);
    sampleRockLayer(6.0, vTWorld, w3, uScales[6], 0.0, aB, rpB, rrB);
    // two rock sets blended by altitude + huge noise: warm ochre gneiss low down, cooler grey up high
    float rockMix = clamp(smoothstep(0.35, 0.65, nzHuge.b + 0.35 * (nzMid.r - 0.5)) * 0.6 + 0.55 * smoothstep(30.0, 150.0, hAbove), 0.0, 1.0);
    vec4 ar = mix(aA, aB, rockMix); vec3 rp = mix(rpA, rpB, rockMix); float rr = mix(rrA, rrB, rockMix);
    // strata: horizontal banding on steep faces (stronger on cut banks)
    // the analytic strata band has no mip chain — fade it out before it aliases into a moire grid
    float strataF = smoothstep(0.3, 0.55, slope) * (1.0 - smoothstep(180.0, 620.0, viewDist));
    float strata = 1.0 - (0.16 + 0.14 * cut) * strataF + (0.30 + 0.20 * cut) * strataF * smoothstep(0.25, 0.75, fract(vTWorld.y * 0.11 + nzMid.g * 0.5));
    vec3 lowTint = vec3(0.86, 0.79, 0.66);          // warm ochre / buff
    vec3 highTint = vec3(0.92, 0.90, 0.93);         // cool grey granite — kept light so faces are not charcoal
    vec3 tint = mix(lowTint, highTint, smoothstep(20.0, 130.0, hAbove)) * mix(0.90, 1.10, nzMacro.r) * strata;
    tint *= mix(1.0, 0.95, smoothstep(0.62, 0.88, slope));
    // low cut banks: exposed soil / clay between the rock strata
    tint = mix(tint, vec3(0.98, 0.84, 0.66) * strata, cut * (0.35 + 0.35 * smoothstep(0.7, 0.3, fract(vTWorld.y * 0.11 + nzMid.g * 0.5 + 0.5))));
    // lichen / moss on gentler rock
    tint = mix(tint, tint * vec3(0.70, 0.90, 0.58), smoothstep(0.42, 0.78, nzMid.r * 0.6 + nzMacro.g * 0.4) * (1.0 - smoothstep(0.32, 0.55, slope)) * 0.75);
    alb += ar.rgb * tint * wRock; nP += rp * (1.5 + 1.0 * steep) * wRock; rgh += mix(0.88, 1.00, clamp(rr, 0.0, 1.0)) * wRock;     // rock 0.80 ao += mix(1.0, ar.a, 0.7) * wRock;
    // snow: bright, slightly blue, follows the rock relief faintly; wind-scoured on ridges, rock
    // pokes through on the steepest faces so the caps never end in a hard bright edge
    float scour = smoothstep(0.15, 0.3, slope) * 0.14 + smoothstep(0.6, 0.85, curv) * 0.08;
    vec3 snowCol = vec3(0.74, 0.78, 0.85) * (0.84 + 0.16 * nzMid.b) * (1.0 - scour);
    alb += snowCol * snowW; nP += rp * 0.4 * snowW; rgh += (0.44 + 0.14 * nzMid.b) * snowW;                  // snow 0.42 - snow has a sheen ao += mix(1.0, ar.a, 0.35) * snowW;
  }
  if (wSand > 0.004) {
    sampleLayer(4.0, vTWorld.xz, uScales[4], blend, macroW, a, n);
    vec3 tint = mix(vec3(0.44, 0.40, 0.33), vec3(0.58, 0.53, 0.43), nzMacro.g);
    alb += a.rgb * tint * wSand; nP += tangentPert(n) * 1.2 * wSand; rgh += (1.00 + 0.11 * n.a) * wSand;                      // sand 0.90 ao += a.a * wSand;
  }
  if (wMud > 0.004) {
    sampleLayer(5.0, vTWorld.xz, uScales[5], blend, macroW, a, n);
    alb += a.rgb * vec3(0.52, 0.48, 0.40) * wMud; nP += tangentPert(n) * 1.1 * wMud; rgh += (0.62 + 0.18 * n.a) * wMud;                       // wet river bed 0.60 ao += a.a * wMud;
  }

  // --- near-field micro detail ------------------------------------------------------------------
  float grassLike = wGrass + wDry + wForest * 0.6;
  if (nearF > 0.01 && grassLike > 0.02) {
    // 0.55 m grass structure: local contrast (sample / local mean) keeps the macro colour, adds blades
    vec3 duv = vec3(vTWorld.xz / 0.55, 0.0);
    vec4 dA = texture(uAlbedo, duv);
    vec4 dN = texture(uNormalArr, duv);
    float lumMean = max(dot(textureLod(uAlbedo, duv, 6.0).rgb, LUMW), 0.01);
    float ratio = clamp(pow(dot(dA.rgb, LUMW) / lumMean, 1.7), 0.35, 1.7);
    float k = nearF * clamp(grassLike, 0.0, 1.0);
    alb *= mix(1.0, ratio, k * 1.0);
    nP += tangentPert(dN) * 3.6 * k;
    ao = mix(ao, ao * dA.a, k * 0.55);
    // a second, 2.2 m clumping octave so the near ground is not a single frequency
    vec3 duv2 = vec3(vTWorld.xz / 2.2 + 0.41, 0.0);
    vec4 d2 = texture(uAlbedo, duv2);
    alb *= mix(1.0, clamp(0.70 + 0.75 * dot(d2.rgb, LUMW) / max(lumMean, 0.02), 0.72, 1.35), k * 0.4);
    nP += tangentPert(texture(uNormalArr, duv2)) * 1.0 * k;
  }
  if (midF > 0.01 && (wGrass + wDry) > 0.02) {
    // sparse, high-frequency scree / worn dirt where the turf is thin — small and broken, never a blotch
    vec4 nzFine = texture(uNoise, vTWorld.xz / 6.0 + 0.13);
    vec4 nzFine2 = texture(uNoise, vTWorld.xz / 2.1 + 0.63);
    float wornP = smoothstep(0.70, 0.86, nzFine.g * 0.45 + nzFine2.b * 0.35 + nzMid.b * 0.2 + 0.10 * wDry + 0.10 * smoothstep(0.04, 0.14, grade)) * clamp(wGrass + wDry, 0.0, 1.0) * midF;
    if (wornP > 0.003) {
      vec3 puv = vec3(vTWorld.xz / 2.2 + 0.2, 2.0);
      vec4 pA = texture(uAlbedo, puv);
      vec4 pN = texture(uNormalArr, puv);
      alb = mix(alb, pA.rgb * vec3(0.70, 0.63, 0.51), wornP * 0.55);
      nP = mix(nP, tangentPert(pN) * 1.8, wornP * 0.7);
      rgh = mix(rgh, 1.06 + 0.10 * pN.a, wornP * 0.6);         // worn soil 0.95
    }
  }

  // --- geology, not airbrush ---------------------------------------------------------------------
  // (a) drainage: hollows hold water — darker, greener, and they READ as a network because curv comes
  //     from the real 8 m Laplacian of the heightmap, so the pattern follows the actual landform
  float cav = (curv - 0.5) * 2.0;
  float turf = clamp(wGrass + wDry + wForest, 0.0, 1.0);
  alb *= mix(vec3(1.0), vec3(0.70, 0.79, 0.66), clamp(-cav, 0.0, 1.0) * 0.45 * turf);
  alb *= mix(vec3(1.0), vec3(0.60, 0.72, 0.56), valleyF * 0.62 * turf);          // gullies / drainage lines
  // (b) ridges dry out, but only slightly — the old +10 % pale wash is what read as chalk streaks
  alb *= mix(vec3(1.0), vec3(1.05, 1.02, 0.94), clamp(cav, 0.0, 1.0) * 0.30 * turf);
  alb *= mix(vec3(1.0), vec3(1.03, 1.01, 0.96), ridgeF * 0.20 * turf);
  // (c) contour bedding / soil-creep terracettes: horizontal banding that follows the CONTOURS, which
  //     is what makes a real hillside read as geology instead of a smooth painted gradient
  // NOTE the distance fade. band is fract() of the *interpolated* world Y, which on a chunk-LOD
  // mesh is piecewise linear — so past a few hundred metres the contour lines kink at every triangle
  // edge and the 3.3 m period drops below the pixel footprint. That is the diagonal "diamond mesh
  // moiré" on the dark mountain faces: it is this band, not shadow acne (raising the CSM normal bias
  // 8x and setting shadow.intensity = 0 both leave it untouched). Gone by 520 m, amplitude halved.
  float bedF = smoothstep(0.10, 0.30, slope) * (1.0 - smoothstep(140.0, 520.0, viewDist));
  float band = fract(vTWorld.y * 0.30 + nzMacro.r * 1.7 + nzMid.g * 0.6);
  float bedBand = smoothstep(0.18, 0.46, band) - smoothstep(0.56, 0.86, band);
  alb *= 1.0 + (bedBand - 0.28) * 0.10 * bedF;
  alb *= mix(vec3(1.0), vec3(1.03, 0.99, 0.93), max(bedBand - 0.3, 0.0) * bedF * 0.7);
  alb *= 0.97 + 0.06 * nzMid.r;
  // (d) 6-19 m cover mottling: patchy sward, richer in the hollows (fades out past ~350 m)
  float small = (nzSmall.b * 0.55 + nzSmall.g * 0.45 - 0.5) * (1.0 - smoothstep(120.0, 380.0, viewDist));
  alb *= mix(vec3(1.0), vec3(0.88, 0.98, 0.84), clamp(small * 1.5, 0.0, 1.0) * (wGrass + wDry));
  alb *= mix(vec3(1.0), vec3(1.05, 1.02, 0.93), clamp(-small * 1.5, 0.0, 1.0) * (wGrass + wDry));
  // rain: wet ground is darker and MUCH glossier. Until now uWetness only touched albedo, which is
  // why our rain frames read as "a matte pale-tan surface with zero specular reflection".
  float wetRain = uWetness * (1.0 - 0.55 * snowW);
  alb *= mix(1.0, 0.70, wetRain);
  rgh = mix(rgh, 0.26, wetRain * 0.88);
  // wet shoreline band: darken and smooth whatever cover is there, peaking exactly at the waterline
  float wetShore = wetK * farFade;
  alb *= mix(1.0, 0.62, wetShore);
  // wet sand is glossy in daylight only — at night that gloss was the brightest thing on the map
  rgh = mix(rgh, 0.235, wetShore * 0.92 * (1.0 - 0.55 * uNight));   // wet sand 0.20
  // global slight desaturation towards a warm grey — natural ground is never fully saturated
  alb = mix(alb, vec3(dot(alb, LUMW)) * vec3(1.04, 1.0, 0.92), 0.24);
  // night: vegetated ground goes fully matte (no grazing specular smears) and takes a cool cast
  float veg = clamp(wGrass + wDry + wForest, 0.0, 1.0);
  rgh = mix(rgh, max(rgh, 1.06), uNight * veg * 0.85 * (1.0 - uWetness));
  alb *= mix(vec3(1.0), vec3(0.90, 0.96, 1.14), uNight * 0.5);
  // sand / silt no longer form a pale glowing ribbon along every shore after dark
  // the beach must never be the brightest thing on the map after dark (the "glowing shoreline")
  float shoreCover = clamp(wSand + wMud + wetShore + snowW * 0.5, 0.0, 1.0);
  alb = mix(alb, alb * vec3(0.17, 0.20, 0.25), uNight * shoreCover);
  // moonlit modelling: without this the whole landscape is a flat dark grey-green with no readable form
  float moonWrap = clamp(dot(gN, normalize(uMoonDir)) * 0.62 + 0.38, 0.0, 1.0);
  alb *= mix(1.0, 0.88 + 0.30 * moonWrap * moonWrap, uNight);
  // info-view overlay: desaturate + darken so coloured overlays read clearly
  if (uInfoTint > 0.0) { float l = dot(alb, LUMW); alb = mix(alb, vec3(l) * 0.75, uInfoTint * 0.7); }

  // real ground never reflects more than ~55 % (only snow goes higher) — keeps sunlit sand/rock from blowing out
  alb = min(alb, vec3(0.32) + vec3(0.34) * snowW);
  tAlbedo = alb;
  tRough = clamp(rgh, mix(mix(0.24, 0.80, veg), 0.90, uNight * veg), 1.28);
  tAO = mix(1.0, ao, 0.8);
  // Night sky bounce. At 21:00 the engine hands the terrain an ambient of 0.10 x sky (0.05,0.07,0.13):
  // essentially nothing, so without this the landscape is literally black. Its directionality (sky
  // visibility + the twilight glow behind the sun) is what puts modelling back into the relief.
  {
    float tw = clamp(dot(gN, normalize(uMoonDir)) * 0.5 + 0.5, 0.0, 1.0);
    tNightFill = vec3(0.160, 0.196, 0.300) * uNight * (0.30 + 0.50 * clamp(gN.y, 0.0, 1.0) + 0.55 * tw * tw)
      * (1.0 - 0.55 * shoreCover);
  }
  // final world normal: geometric normal + detail perturbation (xz components), faded with distance
  vec3 pert = vec3(nP.x, 0.0, nP.z) * (0.9 * detail * detail);
  tNormalWorld = normalize(gN + pert);
}
diffuseColor.rgb *= tAlbedo;
// ------------------------------------------------------------------------------------------------`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * tRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNormalWorld, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse *= tAO;
reflectedLight.indirectSpecular *= tAO;
// night sky bounce: nearly achromatic, so it models the relief without painting the ground green
reflectedLight.indirectDiffuse += mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, 0.3) * tNightFill;
#if NUM_DIR_LIGHTS > 0
// daytime sky/bounce fill: shadowed ground must read as shadow, not as a hole punched in the frame
reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * 0.038 * tAO;
#endif
#if NUM_HEMI_LIGHTS > 0
// hard sky-bounce floor. CS2 measures 0.00% pure-black pixels in every reference frame; our near
// bank measured 27%. Ground under an open sky cannot be darker than the bounce it receives.
{
  vec3 skyFill = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, 0.66);
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, diffuseColor.rgb * skyFill * 0.85 * tAO);
  vec3 albMin = max(diffuseColor.rgb, diffuseColor.rgb * 0.80 + vec3(0.030, 0.034, 0.024));
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, albMin * skyFill * 1.95 * tAO);
}
#endif`);
  };
  mat.customProgramCacheKey = () => (horizon ? 'fable-terrain-horizon-v20' : 'fable-terrain-splat-v20');
  return mat;
}
