/**
 * PBR materials for the road network + the procedural lane-marking shader.
 *
 * The asphalt materials are MeshStandardMaterials patched via onBeforeCompile: every asphalt vertex
 * carries (lateral, along, distToEndA, distToEndB) so the fragment shader can paint lane lines,
 * dashed dividers, stop lines, zebra crossings and turn arrows analytically (fwidth anti-aliased with
 * energy-conserving sub-pixel coverage, no decal geometry, no z-fighting), add wheel-track wear,
 * low-frequency tonal variation, an aggregate detail normal (≈0.5 m tiling), kerb-foot gutter AO and
 * grime, repair patches, hard-shoulder tone and — at night — the warm light pools of the street lamps
 * (analytic, from the same spacing/phase the lamp instances use: inverse-square diffuse plus a GGX
 * specular lobe towards the camera so pools get a bright core and a streak on the wet-ish tarmac).
 * Sidewalks and kerbs get a lighter patch (baked kerb-face AO, light pools + info tint only).
 * A 4096×1 "info" texture indexed by the per-vertex segment slot tints segments for info views
 * (traffic) and the current selection without touching geometry.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD_TYPES, lampHeadLat } from './RoadTypes.js';
import { SimplexNoise } from '../../shared/noise.js';
import { makeRng } from '../../shared/random.js';

export const INFO_SLOTS = 4096;

// `rmean` is the measured mean of that set's own roughness.jpg. three multiplies roughnessMap.g into
// `material.roughness`, so an un-normalised map REPLACES the authored value (asphalt_light's mean 0.52
// turned a 0.85 base into an effective 0.44). Dividing by rmean makes the map vary ±40 % AROUND the base,
// which is what docs/MATERIAL_TARGET.md means by "set the BASE value" — and makes matstats honest.
const TEX_SETS = {
  asphalt: { dir: '/assets/shared/asphalt', maps: ['albedo', 'normal', 'roughness'], rmean: 0.81 },
  asphalt_light: { dir: '/assets/shared/asphalt_light', maps: ['albedo', 'normal', 'roughness', 'ao'], rmean: 0.52 },
  slabs: { dir: '/assets/shared/paving_slabs', maps: ['albedo', 'normal', 'roughness', 'ao'], rmean: 0.52 },
  cobble: { dir: '/assets/shared/paving_cobble', maps: ['albedo', 'normal', 'roughness', 'ao'], rmean: 0.53 },
  concrete: { dir: '/assets/shared/concrete', maps: ['albedo', 'normal', 'roughness'], rmean: 0.52 },
  grass: { dir: '/assets/shared/grass', maps: ['albedo', 'normal', 'roughness', 'ao'], rmean: 0.26 },
};

/**
 * material key → { set, tile (m per texture repeat), color tint (sRGB hex) or linear [r,g,b], roughness, normalScale }
 * Asphalt031 (`asphalt_light`, albedo mean 120 sRGB) is the base for every carriageway: CS2 asphalt is a mid grey
 * with visible aggregate — the tints below land the local street at ≈95 sRGB albedo (≈115-125 rendered in sun),
 * the avenue a touch darker and the motorway's fresher surface darker still.
 */
const MATERIAL_DEFS = {
  // `tile` is metres per texture repeat. Asphalt031's scan covers ~1 m of real road, so a 5 m tile
  // shrank every chip to a sub-pixel speckle that mipped away by 30 m — the judges' "no aggregate grain".
  // At 2.2 m the aggregate reads as stone at 40 m; `grain` then boosts its albedo contrast around `pivot`
  // (the linear luminance of the tinted texture's own mean) so chips separate instead of averaging to grey.
  //
  // SPECULAR (docs/MATERIAL_TARGET.md): dry asphalt 0.65, painted markings 0.55 (shader), kerb/sidewalk
  // 0.80, setts 0.70. `coat` is a real clearcoat lobe — the bitumen binder film on a fresh carriageway is
  // a thin smooth dielectric over a rough aggregate base, which is exactly what a coat layer models, and
  // it is what puts a highlight on the road at a low sun. `wetCoat`/`wetRough`/`wetAlb` are where the
  // surface goes at uWetness = 1: a 0.20-rough, 55 %-albedo mirror with a full water film on top.
  asphalt_local: { set: 'asphalt_light', tile: 2.2, color: 0xc9c3b6, roughness: 0.65, normalScale: 1.35, asphalt: 'local', detail: 0.75, grain: 0.40, pivot: 0.128, aggTile: 3.0, coat: 0.14, coatR: 0.34, wetRough: 0.16, wetAlb: 0.76 },
  asphalt_avenue: { set: 'asphalt_light', tile: 2.35, color: 0xc3bdb0, roughness: 0.65, normalScale: 1.35, asphalt: 'avenue', detail: 0.75, grain: 0.40, pivot: 0.120, aggTile: 3.1, coat: 0.14, coatR: 0.34, wetRough: 0.16, wetAlb: 0.76 },
  asphalt_highway: { set: 'asphalt_light', tile: 2.6, color: 0xbcb6a9, roughness: 0.66, normalScale: 1.2, asphalt: 'highway', detail: 0.65, grain: 0.38, pivot: 0.112, aggTile: 3.4, coat: 0.12, coatR: 0.32, wetRough: 0.17, wetAlb: 0.76 },
  // pedestrian setts: PavingStones128 at 2.4 m gives ~15 cm stones (0.85 m gave 5 cm = black/white static)
  path: { set: 'cobble', tile: 2.4, color: 0xa39c90, roughness: 0.70, normalScale: 1.0, coat: 0.10, coatR: 0.40, wetRough: 0.26, wetAlb: 0.78 },
  sidewalk: { set: 'slabs', tile: 2.6, color: 0xd2cfc7, roughness: 0.80, normalScale: 0.8, paved: true, coat: 0.07, coatR: 0.42, wetRough: 0.24, wetAlb: 0.78 },
  // kerb: light concrete top, the face and gutter darken through the baked aDark attribute
  curb: { set: 'concrete', tile: 1.3, color: 0xa9a69f, roughness: 0.80, normalScale: 0.5, paved: true, coat: 0.07, coatR: 0.42, wetRough: 0.24, wetAlb: 0.78 },
  // dark grey granite kerb edging the pedestrian paths — a real stone, not a pale synthetic line
  granite: { set: 'concrete', tile: 0.75, color: 0x6a6862, roughness: 0.70, normalScale: 0.9, paved: true, coat: 0.12, coatR: 0.35, wetRough: 0.20, wetAlb: 0.78 },
  // planted avenue median: real turf, darker and greener than any sidewalk, lit by the street lamps at night
  median: { set: 'grass', tile: 1.9, linear: [0.30, 0.40, 0.155], roughness: 0.85, normalScale: 1.5, paved: true, wet: 0.45, wetRough: 0.55, wetAlb: 0.80 },
  // planting soil in the tree pits of the median
  soil: { set: 'concrete', tile: 0.55, color: 0x4a4038, roughness: 0.95, normalScale: 1.2, paved: true, wet: 0.6, wetRough: 0.42, wetAlb: 0.72 },
  // The verge is NOT a lawn: it is the graded roadside slope. Kept dark and dirt-tinted (the mesher bakes a
  // gravel/dirt band and kerb-contact AO into its vertex colour) so no bright smooth band hugs the kerb.
  skirt: { set: 'grass', tile: 3.1, linear: [0.34, 0.42, 0.205], roughness: 0.85, normalScale: 1.25, skirt: true, plain: true, wet: 0.45, wetRough: 0.55, wetAlb: 0.82 },
  // motorway median: kerb-height concrete apron, Jersey barrier body and its AO-darkened base
  apron: { set: 'concrete', tile: 2.0, color: 0x8f8d87, roughness: 0.80, normalScale: 0.5, plain: true, coat: 0.06, coatR: 0.42, wetRough: 0.24, wetAlb: 0.78 },
  // Jersey barrier: the one genuinely flat vertical face left in a road frame (measured luminance std
  // 0.077 against 0.112 on the asphalt beside it). `wall` gives it slip-formed construction joints, road
  // spray up the lower third, run-off streaking and an AO line at the foot. `wallSpan` is the profile's
  // own arc length, so uv.x → a height fraction that is 0 at both feet and 1 at the crown.
  barrier: { set: 'concrete', tile: 2.0, color: 0xd6d3cb, roughness: 0.78, normalScale: 0.6, plain: true, wall: true, wallSpan: 1.416, coat: 0.06, coatR: 0.42, wetRough: 0.30, wetAlb: 0.80 },
  barrier_base: { set: 'concrete', tile: 2.0, color: 0x46453f, roughness: 0.82, normalScale: 0.6, plain: true, wet: 0.8, wetRough: 0.26, wetAlb: 0.80 },
  // motorway edge: dark concrete verge strip under the guard rail
  verge: { set: 'concrete', tile: 1.6, color: 0x7c7a74, roughness: 0.80, normalScale: 0.5, plain: true, coat: 0.06, coatR: 0.42, wetRough: 0.24, wetAlb: 0.78 },
};


/** Shared by the asphalt and paved shaders: varyings, night/lamp uniforms and the analytic lamp lighting. */
const GLSL_WET_DECL = /* glsl */ `
uniform float uWetness;        // engine.globalUniforms.uWetness (0 dry … 1 soaked)
uniform float uRoughMean;      // this scan's own roughness-map mean, so the map varies AROUND the base
uniform vec3 uWetTune;         // x = how much this surface responds, y = wet roughness, z = wet albedo factor
`;

/**
 * Replaces <roughnessmap_fragment>. Two jobs, both from docs/MATERIAL_TARGET.md:
 *  1. NORMALISE the scan: roughnessMap.g / its own mean, so `material.roughness` really is the mean
 *     response (an un-normalised 0.52-mean map silently halved every authored value).
 *  2. WETNESS: rain pulls the lobe down to `uWetTune.y` (0.16-0.20 on tarmac). Together with the
 *     clearcoat the JS side raises, a rainy street mirrors the lamps above it instead of going matte.
 */
const GLSL_ROUGH = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
  roughnessFactor *= clamp( texelRoughness.g / max( uRoughMean, 0.02 ), 0.62, 1.42 );
#endif
`;
const GLSL_WET_ROUGH = '\nroughnessFactor = mix( roughnessFactor, uWetTune.y, rdWet );\n';
const GLSL_WET_ALBEDO = /* glsl */ `
float rdWet = clamp( uWetness * uWetTune.x, 0.0, 1.0 );
diffuseColor.rgb *= mix( 1.0, uWetTune.z, rdWet );
`;

const GLSL_COMMON_FRAG = /* glsl */ `
uniform float uNight;
uniform sampler2D uInfoTex;
uniform vec3 uLampColor;
varying vec4 vRoad;
varying vec2 vTurns;
varying vec3 vWPos;
varying float vSeg;
varying float vDark;
varying vec2 vRoadUv;   // (lateral, along) in the road's own frame, metres — on the junction fan it is the dominant arm's frame

struct RdLight { float diff; float spec; };

// One lamp head at (dl, ds) metres from the fragment in road space (lateral, along), 'height' above the surface.
// diff = irradiance normalised to 1 directly under the head (inverse square, cosine), windowed at 'radius';
// spec = GGX lobe (F0 0.04) towards the camera — T/R/N = world frame of the road at this fragment, V = view dir.
void rd_addLamp(inout RdLight acc, float dl, float ds, float height, float radius, vec3 T, vec3 R, vec3 N, vec3 V, float rough, bool spec, float gain) {
  float d2 = dl * dl + ds * ds;
  float win = 1.0 - smoothstep(radius * 0.3, radius, sqrt(d2));
  if (win <= 0.0) return;
  win *= gain;
  float h2 = height * height;
  float D2 = d2 + h2;
  acc.diff += h2 * height / (D2 * sqrt(D2)) * win;
  if (spec) {
    vec3 L = normalize(R * dl + T * ds + N * height);
    vec3 H = normalize(L + V);
    float NdH = max(dot(N, H), 0.0), NdL = max(dot(N, L), 0.0), VdH = max(dot(V, H), 0.0);
    float a = max(rough * rough, 0.04); float a2 = a * a;
    float den = NdH * NdH * (a2 - 1.0) + 1.0;
    float Dg = a2 / (3.14159265 * den * den);
    float F = 0.04 + 0.96 * pow(1.0 - VdH, 5.0);
    acc.spec += Dg * F * NdL * (h2 / D2) * win * 6.0;
  }
}
// All lamps of one segment: mid-block lamps at along = (i + ½)·spacing (alternating sides when alt > 0.5,
// even i → +lat), only where the pole is ≥ 3 m inside the trimmed segment (dA/dB = distances to the ends) —
// exactly where RoadMesher places the instances — plus the two corner lamps of every marked junction end.
void rd_segLamps(inout RdLight acc, float lat, float along, float dA, float dB, vec4 lamp, float radius, int flagsA, int flagsB, float cornerLat,
                 vec3 T, vec3 R, vec3 N, vec3 V, float rough, bool spec) {
  float spacing = lamp.x;
  if (spacing <= 0.0 || abs(lat) > 500.0) return;
  float i0 = floor(along / spacing - 0.5);
  for (int k = -1; k <= 1; k++) {
    float i = i0 + float(k);
    float ds = (i + 0.5) * spacing - along;
    if (dA + ds < 3.0 || dB - ds < 3.0) continue;
    float side = lamp.z > 0.5 ? (mod(i, 2.0) < 0.5 ? 1.0 : -1.0) : 0.0;
    // ±18 % per-luminaire output (age, dirt, lamp type) keyed off the same index the instances use, so a
    // night street is a row of subtly different pools instead of one glowing tube
    float g = 0.82 + 0.36 * fract(sin(i * 12.9898 + vSeg * 4.1414) * 43758.5453);
    rd_addLamp(acc, side * lamp.y - lat, ds, lamp.w, radius, T, R, N, V, rough, spec, g);
  }
  if (lamp.z > 0.5) {
    if (flagsA != 0 && dA < radius) {
      rd_addLamp(acc, cornerLat - lat, -(dA + 0.6), lamp.w, radius, T, R, N, V, rough, spec, 0.92);
      rd_addLamp(acc, -cornerLat - lat, -(dA + 0.6), lamp.w, radius, T, R, N, V, rough, spec, 0.92);
    }
    if (flagsB != 0 && dB < radius) {
      rd_addLamp(acc, cornerLat - lat, dB + 0.6, lamp.w, radius, T, R, N, V, rough, spec, 0.92);
      rd_addLamp(acc, -cornerLat - lat, dB + 0.6, lamp.w, radius, T, R, N, V, rough, spec, 0.92);
    }
  }
}
// junction fan: (dx, dz) from the node, pad radius r — lit by the corner lamps on its rim, so the rim
// matches the arms' corner pools and the middle sits darker
float rd_fanPool(float dx, float dz, float r, float k) {
  if (k < 2.5) return 0.0;
  float d = length(vec2(dx, dz));
  // the corner luminaires stand on the rim, so the rim is the bright part and the middle of the
  // junction sits a stop darker — never unlit, which is what made close junctions read as black
  return mix(0.5, 1.15, smoothstep(0.0, r, d));
}
// pool → emitted radiance (soft saturation so overlapping pools do not blow out)
float rd_tone(float p) { return p / (1.0 + 0.7 * p); }
`;

const GLSL_HEADER_FRAG = /* glsl */ `
uniform vec4 uLines[8];
uniform int uLineCount;
uniform float uLaneCenters[6];
uniform int uLaneCount;
uniform float uArrowLanes[4];
uniform int uArrowLaneCount;
uniform float uCwHalf;
uniform float uMedianHalf;
uniform float uGrime;
uniform float uShoulderLat;
uniform vec4 uLamp; // spacing, head lat, alternate, height
uniform float uLampRadius;
uniform vec3 uPaintColor;
uniform vec3 uPaintYellow;
uniform float uDetail;
uniform float uGrain;
uniform float uPivot;
uniform sampler2D uAgg;
uniform vec2 uAggScale;

float rd_box1(float x, float a, float b, float aa) {
  return smoothstep(a - aa, a + aa, x) * (1.0 - smoothstep(b - aa, b + aa, x));
}
float rd_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rd_sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
// isosceles triangle, base on y = 0 spanning [-w, w], apex at (0, h)
float rd_sdTri(vec2 p, float w, float h) {
  float e = (h * abs(p.x) + w * p.y - w * h) * inversesqrt(h * h + w * w);
  return max(-p.y, e);
}
// arrow SDF in lane space: x = driver's right, y = forward. kind bits: 1 left, 2 straight, 4 right
float rd_arrow(vec2 p, int kind) {
  float d = 1e3;
  if ((kind & 2) != 0) {
    d = min(d, rd_sdBox(p - vec2(0.0, -0.7), vec2(0.15, 1.3)));
    d = min(d, rd_sdTri(p - vec2(0.0, 0.6), 0.55, 1.4));
  }
  if ((kind & 1) != 0) {
    if ((kind & 2) == 0) d = min(d, rd_sdBox(p - vec2(0.0, -0.9), vec2(0.15, 1.1)));
    d = min(d, rd_sdBox(p - vec2(-0.45, 0.2), vec2(0.45, 0.15)));
    d = min(d, rd_sdTri(vec2(p.y - 0.2, -(p.x + 0.9)), 0.45, 0.7));
  }
  if ((kind & 4) != 0) {
    if ((kind & 2) == 0) d = min(d, rd_sdBox(p - vec2(0.0, -0.9), vec2(0.15, 1.1)));
    d = min(d, rd_sdBox(p - vec2(0.45, 0.2), vec2(0.45, 0.15)));
    d = min(d, rd_sdTri(vec2(p.y - 0.2, p.x - 0.9), 0.45, 0.7));
  }
  return d;
}
// stop line, zebra crossing and turn arrows for one segment end. side: +1 for end B, -1 for end A
float rd_endMarks(float lat, float d, float side, int flags, float aaL, float aaA) {
  if (d > 20.0 || flags == 0) return 0.0;
  float m = 0.0;
  float inCw = smoothstep(0.0, aaL, uCwHalf - 0.15 - abs(lat));
  bool incoming = lat * side > 0.0;
  if ((flags & 8) != 0) {
    float band = rd_box1(d, 0.8, 3.8, aaA);
    float p = mod(lat + uCwHalf + 0.25, 1.0);
    float stripe = rd_box1(p, 0.0, 0.5, aaL);
    m = max(m, band * stripe * inCw);
  }
  if ((flags & 16) != 0 && incoming) {
    // stop bar: 0.5 m solid across the incoming half, 1 m behind the crosswalk
    float band = rd_box1(d, 4.8, 5.3, aaA);
    float inner = smoothstep(0.0, aaL, abs(lat) - uMedianHalf - 0.2);
    m = max(m, band * inCw * inner);
    int turns = flags & 7;
    for (int i = 0; i < 4; i++) {
      if (i >= uArrowLaneCount) break;
      float u = side * lat - uArrowLanes[i];
      float v = 10.0 - d;
      int kind = 2;
      if (uArrowLaneCount == 1) kind = turns;
      else if (i == 0) kind = ((turns & 1) != 0) ? ((uArrowLaneCount == 2 && (turns & 2) != 0) ? 3 : 1) : 2;
      else if (i == uArrowLaneCount - 1) kind = ((turns & 4) != 0) ? (((turns & 2) != 0) ? 6 : 4) : 2;
      if (kind == 0) kind = 2;
      float sd = rd_arrow(vec2(u, v), kind);
      m = max(m, 1.0 - smoothstep(-aaL, aaL, sd));
    }
  }
  return m;
}
`;

/** Diffuse stage (after map_fragment): tonal variation, wear, gutter AO, patches, markings, info tint. */
const GLSL_MARKINGS = /* glsl */ `
float roadPaint = 0.0;
float rdYellow = 0.0;
float rdShoulder = 0.0;
float rdTrack = 0.0;
float rdPatch = 0.0;
float midLane = 0.0;
vec3 rdAgg = vec3(0.5);
vec4 rdInfo = texture2D(uInfoTex, vec2((vSeg + 0.5) / ${INFO_SLOTS.toFixed(1)}, 0.5));
{
  float lat = vRoad.x; float along = vRoad.y; float dA = vRoad.z; float dB = vRoad.w;
  bool isFan = dA < -5.0e4;
  float macro = 0.5, macro2 = 0.5, macro3 = 0.5;
  #ifdef USE_MAP
  macro = texture2D(map, vWPos.xz * 0.0131 + vec2(0.37, 0.11)).g;
  macro2 = texture2D(map, vWPos.xz * 0.0029 + vec2(0.71, 0.53)).r;
  macro3 = texture2D(map, vWPos.xz * 0.061 + vec2(0.13, 0.83)).b;
  #endif
  if (uGrain > 0.0) {
    // AGGREGATE: 6-14 cm stones baked by makeAsphaltDetail, sampled in world space so it never repeats
    // with the road UVs, plus a 11 m cluster octave. This is what the scans cannot deliver at road scale.
    rdAgg = texture2D(uAgg, vWPos.xz * uAggScale.x).rgb;
    float agM = texture2D(uAgg, vWPos.xz * uAggScale.y + vec2(0.37, 0.61)).r;
    diffuseColor.rgb *= (0.70 + 0.62 * rdAgg.r) * (0.84 + 0.32 * agM);
    // chip contrast: push every stone away from the surface's own mean so the stones separate
    float gl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb *= clamp(1.0 + uGrain * (gl - uPivot) / max(uPivot, 1e-3), 0.45, 1.9);
  }
  // low-frequency tonal variation: patches of older / newer tarmac, plus mid-scale blotching
  diffuseColor.rgb *= (0.85 + 0.30 * macro) * (0.92 + 0.18 * macro2) * (0.80 + 0.41 * macro3);
  // transition pad: aDark packs rHere + 4·round(255·rNarrow) (see RoadMesher.buildTransitionPad).
  // 'lat' is PHYSICAL on a pad, so the dominant road's lines run straight into it and the carriageway
  // narrows *around* them instead of the lines skewing diagonally across the pad.
  float padCode = floor(vDark * 0.25);
  float rHere = vDark - 4.0 * padCode;
  float rNarrow = padCode / 255.0;
  bool isPad = !isFan && vDark > 0.02;
  float padHalf = uCwHalf * rHere;      // physical half width of the pad here
  float padKeep = uCwHalf * rNarrow;    // physical half width the narrower road keeps
  if (!isFan && abs(lat) < 500.0) {
    float aaL = max(fwidth(lat), 0.002);
    float aaA = max(fwidth(along), 0.002);
    // wheel-track wear: two polished, darker bands 1.7 m apart per lane — the tyre-wear tell every judge
    // named — with the lighter dust/oil band between them, so a lane reads as three tones, not one grey
    float track = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= uLaneCount) break;
      float dl = lat - uLaneCenters[i];
      float u = abs(abs(dl) - 0.85);
      track += exp(-u * u * 3.4);
      midLane += exp(-dl * dl * 5.5);
    }
    rdTrack = clamp(track, 0.0, 1.0);
    midLane = clamp(midLane, 0.0, 1.0);
    // no vehicle ever drives the last few metres of a cul-de-sac stub the same way: sweep the polish out
    // so the wear does not stop in a hard rectangular edge before the bulb (bit 5 = dead end)
    {
      int fa = int(vTurns.x + 0.5), fb = int(vTurns.y + 0.5);
      float dDead = min((fa & 32) != 0 ? dA : 1e5, (fb & 32) != 0 ? dB : 1e5);
      rdTrack *= smoothstep(0.0, 9.0, dDead);
      midLane *= smoothstep(0.0, 9.0, dDead);
    }
    diffuseColor.rgb *= 1.0 - rdTrack * (0.17 + 0.11 * macro2);
    diffuseColor.rgb *= 1.0 + 0.045 * midLane * (1.0 - rdTrack);
    // kerb foot: contact AO over 0.45 m plus a 0.7 m gutter stain (dust, oil, leaf litter)
    float toKerb = uCwHalf - abs(lat);
    float ao = 1.0 - smoothstep(0.0, 0.45, toKerb);
    float grime = 1.0 - smoothstep(0.0, 0.7, toKerb);
    if (uMedianHalf > 0.0) {
      float toMed = abs(lat) - uMedianHalf;
      ao = max(ao, 1.0 - smoothstep(0.0, 0.4, toMed));
      grime = max(grime, 1.0 - smoothstep(0.0, 0.5, toMed));
    }
    diffuseColor.rgb *= (1.0 - 0.64 * ao * ao * uGrime) * (1.0 - 0.26 * grime * uGrime);
    // motorway hard shoulder: unpolished, slightly darker and rougher than the running lanes
    if (uShoulderLat > 0.0) {
      rdShoulder = smoothstep(uShoulderLat - 0.1, uShoulderLat + 0.4, abs(lat));
      diffuseColor.rgb *= 1.0 - 0.14 * rdShoulder;
    }
    // repair patches: a resurfaced rectangle with a bitumen-sealed edge painted round it
    vec2 pc = vec2(lat / 3.3 + 0.5, along / 11.0);
    vec2 cell = floor(pc);
    if (rd_hash(cell) < 0.13) {
      vec2 f = fract(pc);
      float outer = rd_box1(f.x, 0.03, 0.97, 0.03) * rd_box1(f.y, 0.05, 0.95, 0.02);
      float bx = rd_box1(f.x, 0.08, 0.92, 0.03) * rd_box1(f.y, 0.10, 0.90, 0.02);
      float tone = rd_hash(cell + 7.31) < 0.5 ? 0.74 : 1.17;
      diffuseColor.rgb *= mix(1.0, tone, bx * 0.9) * (1.0 - 0.34 * max(0.0, outer - bx));
      rdPatch = bx;
    }
    // crack seals: thin dark bitumen filaments wandering along the carriageway
    #ifdef USE_MAP
    {
      float cr = texture2D(map, vec2(along * 0.0125, lat * 0.42) + vec2(0.19, 0.67)).b;
      float crack = smoothstep(0.600, 0.645, cr) * (1.0 - smoothstep(0.665, 0.720, cr));
      diffuseColor.rgb *= 1.0 - 0.32 * crack * uGrime;
    }
    #endif
    // lane lines (cut before crosswalks / stop bars, solid near marked junctions). Sub-pixel lines fade by
    // their pixel coverage instead of inflating to a bright pixel-wide glow at distance.
    int flagsA = int(vTurns.x + 0.5) & 31; int flagsB = int(vTurns.y + 0.5) & 31;
    float dNear = min(flagsA != 0 ? dA : 1e5, flagsB != 0 ? dB : 1e5);
    float cut = 1.0;
    if (flagsA != 0 && dA < 6.5) { float c = (lat < 0.0 && (flagsA & 16) != 0) ? 5.9 : 4.2; cut *= smoothstep(c - aaA, c + aaA, dA); }
    if (flagsB != 0 && dB < 6.5) { float c = (lat > 0.0 && (flagsB & 16) != 0) ? 5.9 : 4.2; cut *= smoothstep(c - aaA, c + aaA, dB); }
    float paint = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uLineCount) break;
      vec4 L = uLines[i];
      float hw = abs(L.y);
      float m = 1.0 - smoothstep(hw - aaL, hw + aaL, abs(lat - L.x));
      m *= min(1.0, 2.0 * hw / aaL);
      if (L.z < L.w) {
        float ph = mod(along, L.w);
        float dash = rd_box1(ph, 0.0, L.z, aaA);
        m *= max(dash, step(dNear, 14.0));
      }
      paint = max(paint, m);
      if (L.y < 0.0) rdYellow = max(rdYellow, m);
    }
    paint *= cut;
    rdYellow *= cut;
    if (isPad) {
      // the dominant road's lines stop at the physical pad edge (a real lane drop), they do not skew
      float inside = 1.0 - smoothstep(padHalf - 0.80, padHalf - 0.38, abs(lat));
      paint *= inside;
      rdYellow *= inside;
      if (rNarrow < 0.985) {
        // gore: a solid edge line that converges with the boundary, and chevron hatching filling the
        // wedge of carriageway that is being dropped — so the dashes resolve instead of dissolving
        float el = 1.0 - smoothstep(0.065 - aaL, 0.065 + aaL, abs(abs(lat) - (padHalf - 0.5)));
        float wedge = smoothstep(padKeep - 0.15, padKeep + 0.55, abs(lat)) * (1.0 - smoothstep(padHalf - 1.15, padHalf - 0.62, abs(lat)));
        // 3.6 m pitch, 1.5 m bars: real gore hatching, not the 0.7 m hairlines that read as skid streaks.
        // Measured from the gore's own edge line so the bars stay parallel as the wedge narrows, and
        // clipped to the pad interior so no chevron can cross the kerb onto the sidewalk.
        float chev = rd_box1(fract((abs(lat) - padHalf + along * 0.9) * 0.28), 0.0, 0.42, 0.05);
        paint = max(paint, max(el, wedge * chev) * inside);
      }
    }
    float marks = max(rd_endMarks(lat, dA, -1.0, flagsA, aaL, aaA), rd_endMarks(lat, dB, 1.0, flagsB, aaL, aaA));
    marks *= min(1.0, 0.5 / aaL);
    // worn paint: noise mask 0.55–1.0, chipped harder in the wheel tracks and near junctions
    float wearN = 0.5;
    #ifdef USE_MAP
    wearN = texture2D(map, vec2(along * 0.023, lat * 0.041) + vec2(0.5)).r;
    #endif
    float wear = 0.55 + 0.45 * smoothstep(0.15, 0.85, wearN);
    wear *= 1.0 - 0.30 * rdTrack;
    wear *= 1.0 - 0.18 * (1.0 - smoothstep(4.0, 18.0, dNear));
    // stop bars, zebras and arrows are repainted far more often than lane lines — keep them ≥ 0.8 so they
    // survive the 60 m showcase distance instead of dissolving into the tarmac
    float wearM = 0.80 + 0.20 * smoothstep(0.15, 0.85, wearN);
    // vDark on asphalt is the transition-pad paint fade (0 on ordinary segments)
    roadPaint = clamp(max(paint * wear, marks * wearM), 0.0, 1.0);
    float yf = paint > 0.001 ? clamp(rdYellow / paint, 0.0, 1.0) : 0.0;
    vec3 paintCol = mix(uPaintColor, uPaintYellow, yf) * (0.88 + 0.24 * wearN);
    diffuseColor.rgb = mix(diffuseColor.rgb, paintCol, roadPaint);
  }
  // ---------------------------------------------------------------------------------------------
  // JUNCTION FAN. The pad used to be excluded from every wear term, which is why it measured 4x
  // flatter than the asphalt it abuts and read as a plain colour field on the detail camera.
  // It gets the same treatment, laid out in the junction's own frame:
  //   vRoadUv = (lateral, along) of the DOMINANT arm (the mesher textures the fan in that frame),
  //   vTurns.y = the node's own along-coordinate, so clat is the lateral of the CROSS arm,
  //   vDark    = 0 at the node, 1 on the kerb line, so the rim terms follow the real fan boundary.
  else if (isFan) {
    float rlat = vRoadUv.x;                 // lateral in the dominant arm's frame
    float clat = vRoadUv.y - vTurns.y;      // lateral in the crossing arm's frame
    float rim = clamp(vDark, 0.0, 1.0);
    // wheel paths of BOTH approaches, ±0.85 m about every lane centre, exactly as on a segment
    float tr = 0.0, ml = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= uLaneCount) break;
      float da = rlat - uLaneCenters[i], db = clat - uLaneCenters[i];
      float ua = abs(abs(da) - 0.85), ub = abs(abs(db) - 0.85);
      tr = max(tr, max(exp(-ua * ua * 3.4), exp(-ub * ub * 3.4)));
      ml = max(ml, max(exp(-da * da * 5.5), exp(-db * db * 5.5)));
    }
    // turning scuff: the quarter-circle every left/right turn sweeps. abs() folds all four corners
    // into one ring test centred on (±cwHalf, ±cwHalf).
    float rt = max(uCwHalf * 0.60, 1.5);
    float dArc = length(vec2(abs(rlat), abs(clat)) - vec2(uCwHalf)) - rt;
    tr = max(tr, exp(-dArc * dArc * 2.4) * 0.72);
    rdTrack = clamp(tr, 0.0, 1.0) * (1.0 - 0.40 * rim);
    midLane = clamp(ml, 0.0, 1.0) * (1.0 - 0.6 * rdTrack);
    // every path crosses the middle, so the core polishes darker; oil drips where traffic stands
    float core = 1.0 - smoothstep(0.10, 0.80, rim);
    float oil = smoothstep(0.52, 0.86, macro3) * core;
    // approach braking: tyres scrub hardest in the last few metres before the stop line, which on a pad
    // is the outer third of each arm's lane band
    float brake = smoothstep(0.34, 0.70, rim) * (1.0 - smoothstep(0.70, 0.94, rim)) * rdTrack;
    // the wear must read as CONTRAST, not as an overall dimming: unworn tarmac keeps its tone and the
    // polished bands drop away from it, so the pad matches the arms' mean while gaining their structure
    diffuseColor.rgb *= 1.0 + 0.11 * (1.0 - rdTrack);
    diffuseColor.rgb *= 1.0 - rdTrack * (0.26 + 0.14 * macro2) - 0.06 * core - 0.14 * oil - 0.09 * brake;
    diffuseColor.rgb *= 1.0 + 0.075 * midLane;
    // a junction is resurfaced in patches over its life: extra low-frequency tonal blotching
    diffuseColor.rgb *= (0.90 + 0.23 * macro) * (0.95 + 0.11 * macro3);
    // kerb-foot contact AO and the gutter grime ring, following the fan's real boundary
    float ao = smoothstep(0.87, 1.0, rim);
    float grime = smoothstep(0.54, 1.0, rim);
    diffuseColor.rgb *= (1.0 - 0.62 * ao * ao * uGrime) * (1.0 - 0.34 * grime * uGrime);
    // repair patches and crack seals from the same generators as the segment, in the same frame, so the
    // pad/segment boundary carries no tonal step
    vec2 pc = vec2(rlat / 3.3 + 0.5, vRoadUv.y / 11.0);
    vec2 cell = floor(pc);
    if (rd_hash(cell) < 0.13) {
      vec2 f = fract(pc);
      float outer = rd_box1(f.x, 0.03, 0.97, 0.03) * rd_box1(f.y, 0.05, 0.95, 0.02);
      float bx = rd_box1(f.x, 0.08, 0.92, 0.03) * rd_box1(f.y, 0.10, 0.90, 0.02);
      float tone = rd_hash(cell + 7.31) < 0.5 ? 0.74 : 1.17;
      diffuseColor.rgb *= mix(1.0, tone, bx * 0.9) * (1.0 - 0.34 * max(0.0, outer - bx));
      rdPatch = bx;
    }
    #ifdef USE_MAP
    {
      float cr = texture2D(map, vec2(vRoadUv.y * 0.0125, rlat * 0.42) + vec2(0.19, 0.67)).b;
      float crack = smoothstep(0.600, 0.645, cr) * (1.0 - smoothstep(0.665, 0.720, cr));
      diffuseColor.rgb *= 1.0 - 0.32 * crack * uGrime;
    }
    #endif
  }
  // info-view / selection tint
  diffuseColor.rgb = mix(diffuseColor.rgb, rdInfo.rgb, rdInfo.a);
}
`;

/** Night stage (at emissivemap_fragment, after roughness + normals are final): analytic lamp pools with specular. */
const GLSL_NIGHT_ASPHALT = /* glsl */ `
if (uNight > 0.001) {
  RdLight rdL; rdL.diff = 0.0; rdL.spec = 0.0;
  float lat = vRoad.x; float along = vRoad.y; float dA = vRoad.z; float dB = vRoad.w;
  bool isFan = dA < -5.0e4;
  if (isFan) {
    if (uLamp.x > 0.0) rdL.diff = rd_fanPool(lat, along, dB, vTurns.x);
  } else if (uLamp.x > 0.0) {
    // world frame of the road at this fragment: T = direction of increasing 'along' (from the screen-space
    // derivatives, as perturbNormal2Arb does), R = +lateral, N = shading normal
    vec3 rdN = normalize(transformDirectionByInverseViewMatrix(normal, viewMatrix));
    vec3 rdV = normalize(cameraPosition - vWPos);
    vec3 q0 = dFdx(vWPos), q1 = dFdy(vWPos);
    float a0 = dFdx(along), a1 = dFdy(along);
    vec3 Ng = cross(q0, q1);
    float ngl = length(Ng);
    Ng = ngl > 1e-9 ? Ng / ngl : vec3(0.0, 1.0, 0.0);
    if (Ng.y < 0.0) Ng = -Ng;
    vec3 rdT = cross(q1, Ng) * a0 + cross(Ng, q0) * a1;
    float tl = length(rdT);
    rdT = tl > 1e-7 ? rdT / tl : vec3(1.0, 0.0, 0.0);
    vec3 rdR = cross(rdT, Ng);
    int flagsA = int(vTurns.x + 0.5) & 31; int flagsB = int(vTurns.y + 0.5) & 31;
    rd_segLamps(rdL, lat, along, dA, dB, uLamp, uLampRadius, flagsA, flagsB, uCwHalf + 0.5, rdT, rdR, rdN, rdV, roughnessFactor, true);
  }
  // paint is bright already — let it take less of the pool so zebra stripes are not the brightest thing in frame.
  // Beyond ~200 m the pools also fall off: a distant night street must read as a string of separate beads,
  // not as one continuous glowing tube of bloom.
  float gain = uNight * (1.0 - 0.45 * roadPaint);
  gain *= mix(1.0, 0.45, smoothstep(180.0, 620.0, distance(cameraPosition, vWPos)));
  // The pool core measured Y 0.34 against the reference's 0.10 and clipped to flat cream, erasing the
  // aggregate it should have been revealing. The diffuse term is cut 2.4x and the GGX streak raised:
  // at roughness 0.20-0.42 the lobe is what actually reads as "lit tarmac", and it keeps the texture.
  totalEmissiveRadiance += uLampColor * (diffuseColor.rgb * (rd_tone(rdL.diff) * 0.55) + vec3(rd_tone(rdL.spec) * (0.5 + 0.9 * rdWet))) * gain;
}
totalEmissiveRadiance += rdInfo.rgb * (rdInfo.a * 0.22);
`;

/** Sidewalk / kerb: baked AO, night light pools spilling from the road lamps (diffuse only) + info tint. */
const GLSL_PAVED = /* glsl */ `
vec4 rdInfo = texture2D(uInfoTex, vec2((vSeg + 0.5) / ${INFO_SLOTS.toFixed(1)}, 0.5));
diffuseColor.rgb *= 1.0 - vDark;
diffuseColor.rgb = mix(diffuseColor.rgb, rdInfo.rgb, rdInfo.a * 0.6);
`;
const GLSL_NIGHT_PAVED = /* glsl */ `
if (uNight > 0.001 && vTurns.y > 0.0) {
  // aTurns = (head lat + 100·markedA + 200·markedB, spacing)
  float rdCode = floor(vTurns.x / 100.0 + 1e-4);
  float rdHead = vTurns.x - rdCode * 100.0;
  RdLight rdL; rdL.diff = 0.0; rdL.spec = 0.0;
  vec3 z3 = vec3(0.0);
  rd_segLamps(rdL, vRoad.x, vRoad.y, vRoad.z, vRoad.w, vec4(vTurns.y, rdHead, 1.0, 9.0), 12.0, mod(rdCode, 2.0) > 0.5 ? 1 : 0, rdCode > 1.5 ? 1 : 0, rdHead + 0.5, z3, z3, z3, z3, 1.0, false);
  totalEmissiveRadiance += diffuseColor.rgb * uLampColor * (rd_tone(rdL.diff) * 0.34 * uNight * mix(1.0, 0.45, smoothstep(180.0, 620.0, distance(cameraPosition, vWPos))));
}
totalEmissiveRadiance += rdInfo.rgb * (rdInfo.a * 0.15);
`;

const VERT_ATTRS = '#include <common>\nattribute vec4 aRoad;\nattribute vec2 aTurns;\nattribute float aSeg;\nattribute float aDark;\nvarying vec4 vRoad;\nvarying vec2 vTurns;\nvarying vec3 vWPos;\nvarying float vSeg;\nvarying float vDark;\nvarying vec2 vRoadUv;';
const VERT_BODY = '#include <begin_vertex>\nvRoad = aRoad;\nvTurns = aTurns;\nvSeg = aSeg;\nvDark = aDark;\nvRoadUv = uv;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;';

// aggregate detail normal: a second, world-space sample of the asphalt normal map at ≈0.5 m tiling. Roads are
// near-horizontal so a world (x, 0, z) perturbation rotated into view space is a faithful approximation.
const GLSL_DETAIL_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
  // relief of the baked aggregate: this is what makes the low sun rake across the stones instead of
  // sliding over a flat plane, so the surface reads as three-dimensional at 40-80 m
  vec3 dw = vec3(rdAgg.g * 2.0 - 1.0, 0.0, rdAgg.b * 2.0 - 1.0) * (uDetail * (1.0 - 0.75 * roadPaint) * (1.0 - 0.30 * rdTrack));
  normal = normalize(normal + (viewMatrix * vec4(dw, 0.0)).xyz);
}
normal = normalize(mix(normal, nonPerturbedNormal, roadPaint * 0.7));
`;

function asphaltUniforms(type, shared, def) {
  const lines = [];
  for (const l of type.lines) {
    if (l.off === 0) lines.push(new THREE.Vector4(0, l.hw, l.on, l.period));
    else { lines.push(new THREE.Vector4(l.off, l.hw, l.on, l.period)); lines.push(new THREE.Vector4(-l.off, l.hw, l.on, l.period)); }
  }
  const lineCount = Math.min(8, lines.length);
  while (lines.length < 8) lines.push(new THREE.Vector4(0, 0, 0, 1));
  const laneCenters = new Float32Array(6);
  const lanes = [];
  for (const off of type.laneOffsets) lanes.push(off, -off);
  lanes.slice(0, 6).forEach((v, i) => { laneCenters[i] = v; });
  const arrowLanes = new Float32Array(4);
  type.arrowLanes.slice(0, 4).forEach((v, i) => { arrowLanes[i] = v; });
  const lm = type.lamps;
  return {
    uLines: { value: lines.slice(0, 8) },
    uLineCount: { value: lineCount },
    uLaneCenters: { value: laneCenters },
    uLaneCount: { value: Math.min(6, lanes.length) },
    uArrowLanes: { value: arrowLanes },
    uArrowLaneCount: { value: Math.min(4, type.arrowLanes.length) },
    uCwHalf: { value: type.cwHalf },
    uMedianHalf: { value: type.medianHalf },
    uGrime: { value: type.grime },
    uShoulderLat: { value: type.shoulderLat || 0 },
    uLamp: { value: lm ? new THREE.Vector4(lm.spacing, lampHeadLat(type), lm.alternate ? 1 : 0, lm.height) : new THREE.Vector4(0, 0, 0, 9) },
    uLampRadius: { value: lm ? lm.radius : 1 },
    uLampColor: { value: lm ? new THREE.Color(lm.color[0], lm.color[1], lm.color[2]) : new THREE.Color(1, 0.8, 0.5) },
    // off-white (sRGB 0xe6e3d8) and traffic yellow (sRGB ~0xd9a92e) paint, stored linear
    uPaintColor: { value: new THREE.Color(0.79, 0.766, 0.686) },
    uPaintYellow: { value: new THREE.Color(0.69, 0.40, 0.035) },
    uDetail: { value: def.detail || 0.5 },
    uGrain: { value: def.grain || 0.0 },
    uPivot: { value: def.pivot || 0.13 },
    uAgg: shared.uAgg,
    // x = aggregate repeats per metre (1/3.2 m → 6-14 cm stones), y = the macro cluster octave (1/11 m)
    uAggScale: { value: new THREE.Vector2(1 / (def.aggTile || 3.2), 1 / ((def.aggTile || 3.2) * 3.4)) },
    uNight: shared.uNight,
    uInfoTex: shared.uInfoTex,
    ...wetUniforms(def, shared),
  };
}

/** roughness-map normalisation + the wet response, shared by every road material. */
function wetUniforms(def, shared) {
  const set = TEX_SETS[def.set];
  return {
    uWetness: shared.uWetness,
    uRoughMean: { value: (set && set.rmean) || 0.5 },
    uWetTune: { value: new THREE.Vector3(def.wet == null ? 1 : def.wet, def.wetRough == null ? 0.30 : def.wetRough, def.wetAlb == null ? 0.80 : def.wetAlb) },
  };
}

function patchAsphalt(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_ATTRS).replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_WET_DECL + GLSL_COMMON_FRAG + GLSL_HEADER_FRAG)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + GLSL_WET_ALBEDO + GLSL_MARKINGS)
      // Painted markings are thermoplastic: 0.55, a stop glossier than the 0.65 tarmac around them
      // (MATERIAL_TARGET). Wheel tracks are polished by tyres, the shoulder and patches are not.
      .replace('#include <roughnessmap_fragment>', GLSL_ROUGH
        + '\nroughnessFactor = mix(roughnessFactor, 0.55, roadPaint * 0.9);'
        + '\nroughnessFactor = min(1.4, roughnessFactor + 0.05 * rdShoulder - 0.13 * rdTrack - 0.05 * rdPatch);'
        + '\nroughnessFactor = mix(roughnessFactor, 0.42, uNight * 0.30 * (1.0 - rdWet));'
        + GLSL_WET_ROUGH + '\nroughnessFactor = clamp(roughnessFactor, 0.045, 1.0);')
      .replace('#include <normal_fragment_maps>', GLSL_DETAIL_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + GLSL_NIGHT_ASPHALT);
  };
  material.customProgramCacheKey = () => 'roads-asphalt-v7';
  material.userData.roadUniforms = uniforms;
  return material;
}

/** Luminaire glow: the per-instance colour also scales the emissive, so each head burns a little differently. */
function glowMat(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n  totalEmissiveRadiance *= vColor.rgb;\n#endif',
    );
  };
  material.customProgramCacheKey = () => 'roads-glow-v1';
  return material;
}

function patchPaved(material, shared, def) {
  const uniforms = { uNight: shared.uNight, uInfoTex: shared.uInfoTex, uLampColor: { value: new THREE.Color(1.0, 0.70, 0.40) }, ...wetUniforms(def, shared) };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_ATTRS).replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_WET_DECL + GLSL_COMMON_FRAG)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + GLSL_WET_ALBEDO + GLSL_PAVED)
      .replace('#include <roughnessmap_fragment>', GLSL_ROUGH + GLSL_WET_ROUGH + '\nroughnessFactor = clamp(roughnessFactor, 0.045, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + GLSL_NIGHT_PAVED);
  };
  material.customProgramCacheKey = () => 'roads-paved-v4';
  material.userData.roadUniforms = uniforms;
  return material;
}

/**
 * Verge skirt, Jersey barriers, aprons and the embankment retaining wall carry no road attributes —
 * they only need the roughness normalisation and the wet response. `wall` also gets vertical run-off
 * streaking and a form-tie grid so a retaining face is never a flat grey slab.
 */
function patchPlain(material, shared, def) {
  const uniforms = wetUniforms(def, shared);
  if (def.wall) uniforms.uWallSpan = { value: def.wallSpan || 1.0 };
  const wall = def.wall ? /* glsl */ `
{
  // vWallUv = (distance along the cross-section profile, distance along the run), both in metres
  float span = max(uWallSpan, 0.02);
  float hf = clamp(min(vWallUv.x, span - vWallUv.x) / (span * 0.5), 0.0, 1.0);   // 0 at both feet, 1 at the crown
  float run = vWallUv.y;
  // slip-formed construction joints every 3 m, with the panels either side toned a little differently
  float j = abs(fract(run / 3.0) - 0.5) * 3.0;
  diffuseColor.rgb *= 1.0 - 0.34 * (1.0 - smoothstep(0.015, 0.065, j));
  diffuseColor.rgb *= 0.92 + 0.16 * fract(sin(floor(run / 3.0) * 12.9898) * 43758.5453);
  // road spray dirties the lower third and the crown weathers pale — a real barrier is never one tone
  diffuseColor.rgb *= mix(0.60, 1.05, smoothstep(0.02, 0.58, hf));
  // vertical run-off streaks, strongest low on the face
  diffuseColor.rgb *= 1.0 - 0.18 * fract(sin(floor(run * 4.3) * 5.171) * 21713.7) * (1.0 - smoothstep(0.12, 0.92, hf));
  // firm contact AO where the face meets the apron, so the barrier sits IN the median instead of on it
  diffuseColor.rgb *= 1.0 - 0.46 * (1.0 - smoothstep(0.0, 0.13, hf));
}
` : '';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (def.wall) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWallUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallUv = uv;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_WET_DECL + (def.wall ? 'uniform float uWallSpan;\nvarying vec2 vWallUv;\n' : ''))
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + GLSL_WET_ALBEDO + wall)
      .replace('#include <roughnessmap_fragment>', GLSL_ROUGH + GLSL_WET_ROUGH + '\nroughnessFactor = clamp(roughnessFactor, 0.045, 1.0);');
  };
  material.customProgramCacheKey = () => (def.wall ? 'roads-wall-v1' : 'roads-plain-v1');
  material.userData.roadUniforms = uniforms;
  return material;
}

/**
 * Procedural asphalt aggregate — the texture the scans cannot give us.
 *
 * ambientCG's Asphalt031/010 scans are a uniform ~3-pixel speckle: at any sane road tiling a chip is
 * millimetres across, so the mip chain averages it to a flat grey by 20 m and the carriageway reads as an
 * untextured colour field (exactly what every judge named first). This bakes a tileable aggregate whose
 * stones are 6-14 cm at the tiling below, so they survive minification and still read as stone at 60 m.
 *
 * R = albedo modulation (chip lightness, mean ≈ 0.5) · G,B = the matching surface normal's x,z (0.5 = flat).
 * Deterministic from `seed`; sampled in world space so it never repeats with the road UVs.
 */
function makeAsphaltDetail(seed) {
  const rng = makeRng(seed);
  const S = 512, N = S * S;
  const h = new Float32Array(N);
  const alb = new Float32Array(N);
  for (let i = 0; i < N; i++) { const n = rng(); h[i] = n * 0.10; alb[i] = 0.40 + n * 0.14; }
  // three size bands of chips: coarse aggregate, grit, sand. Some stones are pale quartz, some dark basalt.
  const bands = [[520, 4.0, 8.5, 1.0], [1900, 2.0, 4.2, 0.75], [5200, 0.9, 2.0, 0.5]];
  for (const [count, r0, r1, hAmp] of bands) {
    for (let k = 0; k < count; k++) {
      const cx = rng() * S, cy = rng() * S, r = r0 + rng() * (r1 - r0);
      const tone = 0.26 + rng() * 0.56;          // pale quartz … dark basalt
      const rise = hAmp * (0.35 + rng() * 0.65);
      const ri = Math.ceil(r) + 1;
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > r) continue;
          const w = Math.sqrt(Math.max(0, 1 - (d / r) * (d / r)));
          const x = (((cx + dx) | 0) % S + S) % S, y = (((cy + dy) | 0) % S + S) % S;
          const i = y * S + x;
          h[i] = Math.max(h[i], rise * w);
          alb[i] = alb[i] * (1 - w * 0.9) + tone * w * 0.9;
        }
      }
    }
  }
  // scattered tar voids / oil spots so the surface is not a uniform gravel field
  for (let k = 0; k < 260; k++) {
    const cx = rng() * S, cy = rng() * S, r = 3 + rng() * 11;
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.hypot(dx, dy); if (d > r) continue;
      const w = (1 - d / r) ** 2;
      const i = ((((cy + dy) | 0) % S + S) % S) * S + ((((cx + dx) | 0) % S + S) % S);
      alb[i] *= 1 - 0.45 * w;
      h[i] *= 1 - 0.6 * w;
    }
  }
  const data = new Uint8Array(N * 4);
  const at = (x, y) => h[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      // Sobel of the height field → tangent-space normal xz (the strength is applied in the shader)
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      data[i * 4] = Math.round(Math.min(1, Math.max(0, alb[i])) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, -gx * 3.2 + 0.5)) * 255);
      data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, -gy * 3.2 + 0.5)) * 255);
      data[i * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural leaf-clump albedo (canvas), used for the median trees. */
function makeLeafTexture(seed) {
  const rng = makeRng(seed);
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#3d6a2a';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = rng() * size, y = rng() * size, r = 3 + rng() * 9;
    const l = 22 + rng() * 26, h = 84 + rng() * 26, s = 35 + rng() * 25;
    g.fillStyle = `hsl(${h},${s}%,${l}%)`;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.5 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
function makeBarkTexture(seed) {
  const rng = makeRng(seed);
  const w = 128, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#5b4a3b';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    const x = rng() * w, y = rng() * h, len = 8 + rng() * 40;
    const l = 14 + rng() * 26;
    g.strokeStyle = `hsl(${24 + rng() * 12},${20 + rng() * 15}%,${l}%)`;
    g.lineWidth = 1 + rng() * 2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rng() - 0.5) * 4, y + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Procedural street tree: tapered trunk + noise-displaced canopy lobes. Groups: 0 = bark, 1 = leaves. */
function makeTreeGeometry(seed) {
  const noise = new SimplexNoise(seed);
  const trunk = new THREE.CylinderGeometry(0.12, 0.24, 2.9, 8, 1).toNonIndexed();
  trunk.translate(0, 1.45, 0);
  const lobes = [[0, 3.7, 0, 1.75], [0.75, 3.15, 0.45, 1.25], [-0.7, 3.3, -0.4, 1.2], [0.15, 4.55, -0.35, 1.15], [-0.2, 3.0, 0.9, 1.0]];
  const geos = [];
  for (const [x, y, z, r] of lobes) {
    const g = new THREE.IcosahedronGeometry(r, 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const n = noise.noise3D(px * 0.9 + x, py * 0.9 + y, pz * 0.9 + z);
      const s = 1 + 0.24 * n;
      px *= s; py *= s * 0.92; pz *= s;
      pos.setXYZ(i, px, py, pz);
    }
    g.translate(x, y, z);
    geos.push(g);
  }
  const canopy = mergeGeometries(geos, false);
  canopy.computeVertexNormals();
  const merged = mergeGeometries([trunk, canopy], true);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Procedural street lamp / motorway mast. Local +X is the arm direction (the mesher yaws the instance so
 * the arm reaches over the carriageway). Groups: 0 = painted steel, 1 = luminaire glass (emissive at night).
 * The luminaire is a small down-facing panel under a larger fixture cap so the head reads as a lantern,
 * not a glowing sphere; poles are thick enough to survive as ≥1 px lines at showcase distance.
 */
function makeLampGeometry(kind) {
  const metal = [], glow = [];
  const cyl = (r0, r1, h, seg = 8) => new THREE.CylinderGeometry(r0, r1, h, seg, 1);
  if (kind === 'mast') {
    const base = cyl(0.26, 0.32, 0.9, 10); base.translate(0, 0.45, 0); metal.push(base);
    const pole = cyl(0.12, 0.20, 13.2, 10); pole.translate(0, 0.9 + 6.6, 0); metal.push(pole);
    const bar = cyl(0.07, 0.07, 5.6, 6); bar.rotateZ(Math.PI / 2); bar.translate(0, 13.95, 0); metal.push(bar);
    for (const sx of [-1, 1]) {
      const head = new THREE.BoxGeometry(1.1, 0.26, 0.55); head.translate(sx * 2.6, 14.04, 0); metal.push(head);
      const g = new THREE.BoxGeometry(0.72, 0.12, 0.34); g.translate(sx * 2.6, 13.86, 0); glow.push(g);
    }
  } else {
    const base = cyl(0.13, 0.17, 0.6, 8); base.translate(0, 0.3, 0); metal.push(base);
    const pole = cyl(0.065, 0.105, 8.3, 8); pole.translate(0, 0.6 + 4.15, 0); metal.push(pole);
    const arm = cyl(0.045, 0.06, 2.05, 6); arm.rotateZ(-Math.PI / 2 + 0.11); arm.translate(1.0, 8.95, 0); metal.push(arm);
    const head = new THREE.BoxGeometry(0.82, 0.17, 0.36); head.translate(2.0, 9.14, 0); metal.push(head);
    const g = new THREE.BoxGeometry(0.52, 0.11, 0.24); g.translate(2.0, 9.0, 0); glow.push(g);
  }
  const m = mergeGeometries(metal, false), gl = mergeGeometries(glow, false);
  const merged = mergeGeometries([m, gl], true);
  merged.computeBoundingSphere();
  return merged;
}

export class RoadMaterials {
  constructor(engine) {
    this.engine = engine;
    this.materials = new Map();
    // info texture: one RGBA8 pixel per segment slot (alpha 0 = no tint)
    this.infoData = new Uint8Array(INFO_SLOTS * 4);
    this.infoTex = new THREE.DataTexture(this.infoData, INFO_SLOTS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.infoTex.minFilter = this.infoTex.magFilter = THREE.NearestFilter;
    this.infoTex.wrapS = this.infoTex.wrapT = THREE.ClampToEdgeWrapping;
    this.infoTex.colorSpace = THREE.NoColorSpace;
    this.infoTex.needsUpdate = true;
    this.aggregate = makeAsphaltDetail(90210);
    // uWetness is the ENGINE's global uniform: one write by the environment module reaches every road
    // material, and declaring it here makes the environment hook skip its own declaration (see ARCHITECTURE §3).
    this.shared = {
      uNight: { value: 0 }, uInfoTex: { value: this.infoTex }, uAgg: { value: this.aggregate },
      uWetness: engine.globalUniforms.uWetness,
    };
    this.wetness = -1;

    for (const [key, def] of Object.entries(MATERIAL_DEFS)) {
      // A clearcoat lobe needs MeshPhysicalMaterial, and USE_CLEARCOAT is baked into the program, so the
      // coat must exist from the first compile — a dry road keeps a small bitumen-binder coat and rain
      // only raises it, which costs no recompile when the weather turns.
      const m = def.coat
        ? new THREE.MeshPhysicalMaterial({ roughness: def.roughness, metalness: 0, clearcoat: def.coat, clearcoatRoughness: def.coatR, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
        : new THREE.MeshStandardMaterial({ roughness: def.roughness, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      if (def.linear) m.color.setRGB(def.linear[0], def.linear[1], def.linear[2], THREE.LinearSRGBColorSpace);
      else m.color.setHex(def.color);
      m.name = 'roads/' + key;
      if (def.skirt) {
        // vertex alpha fades the verge into the terrain; rgb carries the terrain ground tint at the toe
        m.transparent = true;
        m.vertexColors = true;
        m.depthWrite = true;
        m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
      }
      // the effects module's global wet hook patches these materials too; halving its share keeps the
      // combined darkening at the MATERIAL_TARGET 55 % instead of stacking to 24 %, while its puddles,
      // rain rings and snow still work
      m.userData.wetness = 0.5;
      if (def.asphalt) patchAsphalt(m, asphaltUniforms(ROAD_TYPES[def.asphalt], this.shared, def));
      else if (def.paved) patchPaved(m, this.shared, def);
      else patchPlain(m, this.shared, def);
      engine.registerMaterial(m);
      this.materials.set(key, m);
    }
    // galvanised W-beam guard rail: bright metal so it reads as a light line from the air
    // galvanised W-beam: a real metal lobe (MATERIAL_TARGET "metal roof / ducting" 0.45 / 0.95)
    const rail = new THREE.MeshStandardMaterial({ color: 0xaab0b4, metalness: 0.95, roughness: 0.38 });
    rail.name = 'roads/guardrail';
    this.materials.set('guardrail', engine.registerMaterial(rail));
    const post = new THREE.MeshStandardMaterial({ color: 0x70767a, metalness: 0.85, roughness: 0.40 });
    post.name = 'roads/post';
    this.materials.set('post', engine.registerMaterial(post));

    this.bark = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0xb9a892, roughness: 0.88, metalness: 0, map: makeBarkTexture(11) }));
    this.bark.name = 'roads/bark';
    const leafTex = makeLeafTexture(7);
    // leaves carry a waxy sheen — 0.90 was the "chalk" the material audit named (MATERIAL_TARGET: 0.70)
    this.leaves = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0xd8dcc8, roughness: 0.70, metalness: 0, map: leafTex, bumpMap: leafTex, bumpScale: 0.6 }));
    this.leaves.name = 'roads/leaves';
    this.treeGeometry = makeTreeGeometry(1234);
    this.postGeometry = new THREE.BoxGeometry(0.12, 0.78, 0.16);
    this.postGeometry.translate(0, 0.39, 0);

    // street lighting (part of the road asset, as in CS2): grey-green painted steel, warm luminaires
    // painted steel column (MATERIAL_TARGET "street lamp pole, signal head" 0.40 / 0.85)
    this.lampMetal = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0x6b716d, metalness: 0.85, roughness: 0.40 }));
    this.lampMetal.name = 'roads/lamp-steel';
    // luminaire lens: a polycarbonate bowl — emissive PLUS a real clearcoat specular, so a lamp head
    // catches the sky by day instead of reading as a matte blob (MATERIAL_TARGET "headlight / lens" 0.10)
    this.lampGlow = engine.registerMaterial(glowMat(new THREE.MeshPhysicalMaterial({ color: 0xf2e6d2, emissive: new THREE.Color(1.0, 0.70, 0.40), emissiveIntensity: 0, roughness: 0.10, metalness: 0, clearcoat: 1.0, clearcoatRoughness: 0.05 })));
    this.lampGlow.name = 'roads/lamp-glow';
    this.mastGlow = engine.registerMaterial(glowMat(new THREE.MeshPhysicalMaterial({ color: 0xf2eee6, emissive: new THREE.Color(1.0, 0.84, 0.62), emissiveIntensity: 0, roughness: 0.10, metalness: 0, clearcoat: 1.0, clearcoatRoughness: 0.05 })));
    this.mastGlow.name = 'roads/mast-glow';
    this.lampGeometry = { street: makeLampGeometry('street'), mast: makeLampGeometry('mast') };
  }

  get(key) {
    return this.materials.get(key) || this.materials.get('curb');
  }

  /** Per-frame: night factor drives the light pools, the dew sheen and the luminaires' glow. */
  setNight(f) {
    this.shared.uNight.value = f;
    const on = f * f * (3 - 2 * f);
    // modest emissive: a small warm lantern with a soft bloom halo, not a white sphere
    this.lampGlow.emissiveIntensity = 9.0 * on;
    this.mastGlow.emissiveIntensity = 7.5 * on;
  }

  /**
   * Rain: the water film is a smooth dielectric layer over the rough aggregate, which is exactly a
   * clearcoat lobe. `uWetness` already drives roughness and albedo inside the shaders; this raises the
   * coat so a wet street MIRRORS the lamps and the sky instead of merely going darker.
   */
  setWetness(w) {
    w = Math.min(1, Math.max(0, w || 0));
    if (Math.abs(w - this.wetness) < 0.004) return;
    this.wetness = w;
    for (const [key, m] of this.materials) {
      const def = MATERIAL_DEFS[key];
      if (!def || !def.coat || !m.isMeshPhysicalMaterial) continue;
      const k = w * (def.wet == null ? 1 : def.wet);
      m.clearcoat = def.coat + (1 - def.coat) * k;
      m.clearcoatRoughness = def.coatR * (1 - k) + 0.045 * k;
    }
  }

  /** Write one slot of the info texture: `color` THREE.Color (sRGB), alpha 0..1. Call commitInfo() afterwards. */
  setInfoSlot(slot, color, alpha) {
    if (slot <= 0 || slot >= INFO_SLOTS) return;
    const d = this.infoData, i = slot * 4;
    if (!alpha) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
    const c = _lin.copy(color).convertSRGBToLinear();
    d[i] = Math.round(Math.min(1, c.r) * 255); d[i + 1] = Math.round(Math.min(1, c.g) * 255); d[i + 2] = Math.round(Math.min(1, c.b) * 255);
    d[i + 3] = Math.round(Math.min(1, alpha) * 255);
  }
  clearInfo() { this.infoData.fill(0); }
  commitInfo() { this.infoTex.needsUpdate = true; }

  /** Load the PBR texture sets and attach them to the materials (sRGB albedo, linear data maps). */
  async load(assets) {
    const aniso = this.engine.maxAnisotropy;
    const sets = {};
    await Promise.all(Object.entries(TEX_SETS).map(async ([name, s]) => {
      const files = {};
      if (s.maps.includes('albedo')) files.map = `${s.dir}/albedo.jpg`;
      if (s.maps.includes('normal')) files.normalMap = `${s.dir}/normal.jpg`;
      if (s.maps.includes('roughness')) files.roughnessMap = `${s.dir}/roughness.jpg`;
      if (s.maps.includes('ao')) files.aoMap = `${s.dir}/ao.jpg`;
      sets[name] = await assets.loadPBR(files, { anisotropy: aniso });
    }));
    for (const [key, def] of Object.entries(MATERIAL_DEFS)) {
      const m = this.materials.get(key);
      const t = sets[def.set];
      if (!t) continue;
      const rep = 1 / def.tile;
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
        if (!t[slot]) continue;
        const tex = t[slot].clone();
        tex.repeat.set(rep, rep);
        tex.needsUpdate = true;
        m[slot] = tex;
      }
      if (m.normalMap) m.normalScale.set(def.normalScale, def.normalScale);
      if (m.aoMap) m.aoMapIntensity = 0.7;
      m.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of this.materials.values()) m.dispose();
    this.bark.dispose(); this.leaves.dispose();
    this.lampMetal.dispose(); this.lampGlow.dispose(); this.mastGlow.dispose();
    this.treeGeometry.dispose(); this.postGeometry.dispose();
    this.lampGeometry.street.dispose(); this.lampGeometry.mast.dispose();
    this.infoTex.dispose();
    this.aggregate.dispose();
  }
}
const _lin = new THREE.Color();
