/**
 * Shader patches for the buildings module (onBeforeCompile on MeshStandardMaterial).
 *
 *  - patchFacade(material): the procedural facade. A unit box scaled per instance becomes a building
 *    mass; the vertex stage derives facade coordinates in metres from the instance scale so every wall
 *    texture (real CC0 brick / plaster / concrete / corrugated albedo + normal + roughness) tiles at
 *    real-world size, and the fragment stage draws a window grid fitted to each face.
 *    Windows are REAL openings, not painted rectangles:
 *      · a box-parallax march into the wall gives every pane a 0.07–0.22 m reveal with its own
 *        inward-facing normal,
 *      · the recess is ambient-occluded — a dark head band, shaded jambs and a darkened reveal are
 *        applied to the *indirect* light (see AO_FRAG), so they read in shadow as well as in sun,
 *      · the glass is a dielectric/coated pane: F0 0.10–0.22, near-zero diffuse, so the standard
 *        BRDF gives real sky reflection with fresnel — dark from the front, bright at grazing, and
 *        never brighter than the wall it sits in,
 *      · a protruding sill catches the sky and drops a real, sun-directional contact shadow onto the
 *        wall below.
 *    Also: a masonry plinth and a differentiated ground floor (entrance, lobby glazing, canopy
 *    shadow, fascia band) on apartment/retail/curtain-wall styles, an industrial branch with panel
 *    joints, roller and dock doors, splash weathering and downpipe stains, flat-roof gravel +
 *    parapet on the top face and per-window randomised warm lights driven by uNight.
 *  - patchInstanceUv(material, mode): world-scale UVs for the other instanced parts (pitched roofs,
 *    tanks, ground quads).
 *  - patchRoof(material): pitched roofs — shingle/tile grain, course breaks, eave shadow, ridge cap.
 *  - patchAtlas(material, cols): per-instance atlas column (shop signs).
 *
 * Per-instance attributes used by the facade: aParams (floorH, style, seed, groundH),
 * aParams2 (bayW, winFrac, litBias, texScale), aTint (info-view tint).
 */

export const FACADE_UNIFORMS = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uInfo: { value: 0 },
  uRoofMap: { value: null },
  uSunDir: { value: null }, // THREE.Vector3, direction the sunlight travels (set by index.js)
  uSunStrength: { value: 1 },
  // --- explicit sky-reflection probe (see SKY_GLSL) ---------------------------------------------
  // The PMREM probe is effectively sky-only: a vertical pane seen from a camera ABOVE it reflects
  // *downwards* (a mirror flips only the normal component, so R.y = V.y), and the probe returns
  // ~0 there. That is why office glass measured Y 0.0010 and mullions Y 0.0000. These three
  // radiances give the glazing an analytic sky/horizon/ground dome with a floored fresnel, so a
  // pane always carries a specular response. Written every frame by index.js from world.env.
  uSkyUp: { value: null },   // THREE.Vector3 zenith radiance
  uSkyHz: { value: null },   // THREE.Vector3 horizon radiance
  uSkyDn: { value: null },   // THREE.Vector3 what a downward reflection sees (ground + city bounce)
  uGndBounce: { value: null }, // THREE.Vector3 warm bounce added to facade indirect diffuse
};

export const STYLE = { PLAIN: 0, HOUSE: 1, APARTMENT: 2, RETAIL: 3, CURTAIN: 4, INDUSTRIAL: 5, INDUSTRIAL_METAL: 6 };

/** Facade bay layout — must match the GLSL below so generators can place geometry on a bay. */
export function bayLayout(faceW, bayW) {
  const sideM = 0.55;
  const usable = Math.max(faceW - 2 * sideM, 0.5);
  const nB = Math.max(1, Math.floor(usable / Math.max(bayW, 1.2) + 0.35));
  const bay = usable / nB;
  return { sideM, usable, nB, bay, x0: -faceW / 2 + sideM };
}
/**
 * Roller / dock door layout on an industrial frontage — mirrors the GLSL in the INDUSTRIAL branch so
 * the generator can hang bumpers, canopies and bollards on the doors the shader actually draws.
 */
export function dockLayout(faceW) {
  const dSpace = Math.max(6.4, faceW / Math.max(1, Math.floor(faceW / 7.2)));
  const nD = Math.max(1, Math.floor(faceW / dSpace));
  const off = (faceW - nD * dSpace) * 0.5;
  return { dSpace, nD, doorW: 3.9, centre: (i) => off + (i + 0.5) * dSpace - faceW / 2 };
}

/** Local x of the front-door bay centre on a face of width faceW (matches the shader's doorBay). */
export function doorCentre(faceW, bayW) {
  const L = bayLayout(faceW, bayW);
  const doorBay = Math.floor(L.nB * 0.5);
  return L.x0 + (doorBay + 0.5) * L.bay;
}

const SCALE_GLSL = /* glsl */ `
#ifdef USE_INSTANCING
  vec3 iSc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
  vec3 iSc = vec3(1.0);
#endif
`;

const UV_ASSIGN = /* glsl */ `
#ifdef USE_MAP
  vMapUv = iUv;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv = iUv;
#endif
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = iUv;
#endif
#ifdef USE_METALNESSMAP
  vMetalnessMapUv = iUv;
#endif
#ifdef USE_AOMAP
  vAoMapUv = iUv;
#endif
#ifdef USE_EMISSIVEMAP
  vEmissiveMapUv = iUv;
#endif
#ifdef USE_ALPHAMAP
  vAlphaMapUv = iUv;
#endif
`;

const FACADE_VERT_PARS = /* glsl */ `
attribute vec4 aParams;
attribute vec4 aParams2;
attribute vec3 aTint;
varying vec2 vFacade;
varying vec4 vFaceInfo;
varying vec4 vP1;
varying vec4 vP2;
varying vec3 vTint;
`;

const FACADE_VERT = /* glsl */ `
${SCALE_GLSL}
{
  vec3 fN = normal;
  float fRoof = step(0.5, abs(fN.y));
  vec2 fac; float faceW; float faceH; float faceId;
  if (abs(fN.x) > 0.5) {
    fac = vec2((0.5 - sign(fN.x) * position.z) * iSc.z, position.y * iSc.y);
    faceW = iSc.z; faceH = iSc.y; faceId = fN.x > 0.0 ? 0.0 : 1.0;
  } else if (abs(fN.z) > 0.5) {
    fac = vec2((0.5 + sign(fN.z) * position.x) * iSc.x, position.y * iSc.y);
    faceW = iSc.x; faceH = iSc.y; faceId = fN.z > 0.0 ? 2.0 : 3.0;
  } else {
    fac = vec2((position.x + 0.5) * iSc.x, (position.z + 0.5) * iSc.z);
    faceW = iSc.x; faceH = iSc.z; faceId = 4.0;
  }
  vFacade = fac;
  vFaceInfo = vec4(faceW, faceH, fRoof, faceId);
  vP1 = aParams; vP2 = aParams2; vTint = aTint;
  vec2 iUv = fac / max(aParams2.w, 0.25);
  ${UV_ASSIGN}
}
`;

/**
 * Analytic sky dome for the glazing specular. `uSkyUp / uSkyHz / uSkyDn` are radiances, not
 * irradiances: a pane reflects what it points at, and a vertical pane viewed from above points at
 * the ground, so `uSkyDn` carries the city/ground bounce and is floored well above black in
 * index.js. `fSkyFresnel` is a Schlick ramp with a *floor* (~11 %) — the "8-15 % of sky luminance"
 * the material target asks for — so a frontal pane is never black and a grazing pane goes bright.
 */
const SKY_PARS_GLSL = /* glsl */ `
uniform vec3 uSkyUp;
uniform vec3 uSkyHz;
uniform vec3 uSkyDn;
vec3 fSkyAt(float ry) {
  vec3 above = mix(uSkyHz, uSkyUp, smoothstep(0.015, 0.50, ry));
  return mix(uSkyDn, above, smoothstep(-0.22, 0.02, ry));
}
float fSkyFresnel(float ndv) { return 0.140 + 0.72 * pow(1.0 - clamp(ndv, 0.0, 1.0), 4.0); }
`;

const FACADE_FRAG_PARS = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform float uInfo;
uniform float uSunStrength;
uniform vec3 uSunDir;
uniform sampler2D uRoofMap;
varying vec2 vFacade;
varying vec4 vFaceInfo;
varying vec4 vP1;
varying vec4 vP2;
varying vec3 vTint;
float fHash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fVal(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  fr = fr * fr * (3.0 - 2.0 * fr);
  float a = fHash21(i), b = fHash21(i + vec2(1.0, 0.0)), c = fHash21(i + vec2(0.0, 1.0)), d = fHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
float fBox2(vec2 d, vec2 aa) { return (1.0 - smoothstep(-aa.x, aa.x, d.x)) * (1.0 - smoothstep(-aa.y, aa.y, d.y)); }
float gWinMask;   // glass + frame coverage, so <aomap_fragment> can skip the wall AO on glazing
float gAO;        // recess / sill / plinth ambient occlusion, applied to the indirect light
${SKY_PARS_GLSL}
`;

const FACADE_FRAG = /* glsl */ `
{
  gWinMask = 0.0;
  gAO = 1.0;
  float floorH = max(vP1.x, 2.0);
  float style = vP1.y;
  float seed = vP1.z;
  float groundH = max(vP1.w, floorH);
  float bayW = max(vP2.x, 1.2);
  float winFrac = vP2.y;
  float litBias = vP2.z;
  float faceW = vFaceInfo.x, faceH = vFaceInfo.y, roof = vFaceInfo.z, faceId = vFaceInfo.w;
  vec2 f = vFacade;
  float px = max(fwidth(f.x), fwidth(f.y));
  if (roof > 0.5) {
    // flat roof: bitumen/gravel, felt seams, ponding stains and a concrete parapet ring with a coping
    vec3 roofCol = texture2D(uRoofMap, f / 7.0).rgb;
    float ed = min(min(f.x, faceW - f.x), min(f.y, faceH - f.y));
    float parapet = 1.0 - smoothstep(0.30, 0.46, ed);
    float coping = (1.0 - smoothstep(0.06, 0.14, abs(ed - 0.20))) * step(ed, 0.42);
    float grit = fHash21(floor(f * 2.0) + seed);
    float seam = 1.0 - smoothstep(0.02, 0.07, abs(fract(f.y / 2.4 + seed) - 0.5) * 2.4);
    float pond = smoothstep(0.35, 0.9, fHash21(floor(f / 3.5) + seed * 3.0)) * (1.0 - parapet);
    vec3 rc = roofCol * (0.46 + 0.26 * grit) * vec3(0.97, 0.97, 1.0);
    rc *= 1.0 - 0.18 * seam;
    rc *= 1.0 - 0.22 * pond;
    vec3 pc = vec3(0.46, 0.45, 0.43) * (0.9 + 0.12 * grit);
    diffuseColor.rgb = mix(rc, pc, parapet);
    diffuseColor.rgb *= 1.0 + 0.22 * coping;
    diffuseColor.rgb *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.55, ed - 0.44));
    // parapet upstand shades the deck it rings
    gAO = mix(1.0, 0.62, 1.0 - smoothstep(0.0, 1.1, ed - 0.44));
    roughnessFactor = mix(0.93, 0.74, parapet);
    metalnessFactor = 0.0;
  } else {
    // ---------------------------------------------------------------- shared facade frame (view space)
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 fNv = nonPerturbedNormal;
    vec3 fTv = normalize(cross(upV, fNv) + vec3(1e-5));
    vec3 fBv = cross(fNv, fTv);
    vec3 vDir = -normalize(vViewPosition);            // camera -> fragment
    vec3 ts = vec3(dot(vDir, fTv), dot(vDir, fBv), dot(vDir, fNv));
    vec3 sunV = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
    vec3 Lts = vec3(dot(-sunV, fTv), dot(-sunV, fBv), dot(-sunV, fNv));
    float sunFace = smoothstep(0.02, 0.30, Lts.z) * uSunStrength;
    // low-frequency macro variation kills the tiling of the 1 m albedo sets
    float macro = fVal(f * 0.21 + seed * 11.0) * 0.62 + fVal(f * 0.062 + seed * 4.0) * 0.38;
    float corner = 1.0 - smoothstep(0.0, 0.55, min(f.x, faceW - f.x));

  if (style > 4.5) {
    // ================================================================ INDUSTRIAL (no floor grid)
    // metal-clad halls (style 6) already carry their ribs in the albedo/normal: only the girth
    // rails are drawn there, or the wall turns into a black corduroy field.
    float metalClad = step(5.5, style);
    float panelW = 1.06;
    float pj = abs(fract(f.x / panelW + 0.5) - 0.5) * panelW;          // distance to a vertical joint
    float joint = (1.0 - smoothstep(0.012, 0.034, pj)) * (1.0 - metalClad);
    float hj = abs(fract(f.y / 2.35 + 0.5) - 0.5) * 2.35;
    float hJoint = (1.0 - smoothstep(0.012, 0.030, hj)) * step(1.15, f.y) * mix(1.0, 0.55, metalClad);
    float plinth = 1.0 - smoothstep(1.02, 1.16, f.y);                   // concrete kicker
    float plinthTop = (1.0 - smoothstep(0.0, 0.10, abs(f.y - 1.09)));
    // splash / rain weathering above the plinth and streaks below the eaves
    float splash = (1.0 - smoothstep(0.0, 1.5, f.y - 1.1)) * (0.45 + 0.55 * fVal(vec2(f.x * 1.7, 3.0) + seed));
    float streak = smoothstep(0.55, 1.0, fVal(vec2(f.x * 0.8 + seed * 13.0, 0.5)))
                 * (1.0 - smoothstep(0.0, 5.0, faceH - f.y)) * 0.9;
    float rust = smoothstep(0.62, 1.0, fVal(f * vec2(0.5, 0.28) + seed * 5.0));

    // clerestory strip glazing under the eave
    float sTop = faceH - 0.95, sBot = faceH - 2.25;
    float lite = step(sBot, f.y) * step(f.y, sTop);
    float lx = abs(fract(f.x / 2.6 + 0.5) - 0.5) * 2.6;
    lite *= 1.0 - step(1.14, lx);
    lite *= step(0.6, f.x) * step(f.x, faceW - 0.6);

    // roller / dock doors on the frontage face
    float dSpace = max(6.4, faceW / max(1.0, floor(faceW / 7.2)));
    float nD = max(1.0, floor(faceW / dSpace));
    float du = f.x - (faceW - nD * dSpace) * 0.5;
    float di = floor(du / dSpace);
    float dxc = (fract(du / dSpace) - 0.5) * dSpace;
    float frontFace = step(1.5, faceId) * step(faceId, 2.5);
    float doorOk = frontFace * step(0.0, du) * step(du, nD * dSpace) * step(faceH, 40.0);
    float dW = 3.9, dH = min(4.3, faceH - 2.6);
    float inDoor = doorOk * step(abs(dxc), dW * 0.5) * step(f.y, dH);
    float doorEdge = doorOk * (1.0 - smoothstep(dW * 0.5 - 0.14, dW * 0.5, abs(dxc))) * step(f.y, dH);
    float ribs = 1.0 - smoothstep(0.02, 0.055, abs(fract(f.y / 0.34 + 0.5) - 0.5) * 0.34);
    float lintel = doorOk * (1.0 - smoothstep(0.0, 0.22, abs(f.y - dH - 0.16))) * step(abs(dxc), dW * 0.5 + 0.25);

    vec3 wall = diffuseColor.rgb;
    wall *= 0.88 + 0.24 * macro;
    wall *= 1.0 - 0.22 * joint - 0.14 * hJoint;
    wall *= 1.0 - 0.22 * splash;
    wall *= 1.0 - 0.16 * streak;
    wall = mix(wall, wall * vec3(0.70, 0.50, 0.36), rust * mix(0.30, 0.20, metalClad));
    wall *= 1.0 - 0.10 * corner;
    // concrete kicker
    wall = mix(wall, vec3(0.40, 0.395, 0.385) * (0.86 + 0.28 * macro), plinth);
    wall *= 1.0 - 0.30 * plinthTop;
    // roller door: dark ribbed metal set 0.10 m back
    vec3 doorCol = mix(vec3(0.30, 0.31, 0.32), vec3(0.22, 0.26, 0.30), step(0.5, fHash21(vec2(di, seed * 91.0))));
    doorCol *= 0.82 + 0.30 * ribs;
    wall = mix(wall, doorCol, inDoor);
    wall *= 1.0 - 0.55 * doorEdge;
    wall = mix(wall, vec3(0.30, 0.30, 0.29), lintel * 0.7);
    diffuseColor.rgb = wall;
    roughnessFactor = clamp(roughnessFactor * (0.94 + 0.14 * macro) + 0.10 * splash, 0.2, 1.0);
    metalnessFactor = mix(metalnessFactor, 0.32, inDoor);
    // openings darken the ambient: door reveal + strip glazing head
    gAO = mix(1.0, 0.55, inDoor) * mix(1.0, 0.42, doorEdge) * mix(1.0, 0.70, plinthTop);

    // strip glazing: dark tinted, dirty, with a reveal shadow at its head
    if (lite > 0.5) {
      float headSh = 1.0 - smoothstep(0.0, 0.28, sTop - f.y);
      // dielectric wired glass: a dark, dirty tint plus the same analytic sky reflection the
      // curtain wall uses, so a clerestory strip is a lit band and not a black slot
      vec3 gc = vec3(0.030, 0.034, 0.038) * (0.7 + 0.9 * fHash21(vec2(floor(f.x / 2.6), seed * 17.0)));
      gc *= 1.0 - 0.45 * headSh;
      diffuseColor.rgb = gc;
      roughnessFactor = 0.12;
      metalnessFactor = 0.0;
      float lNdV = clamp(dot(fNv, -vDir), 0.0, 1.0);
      vec3 lSky = fSkyAt(dot(reflect(vDir, fNv), upV));
      totalEmissiveRadiance += lSky * fSkyFresnel(lNdV) * 0.80 * (1.0 - 0.45 * headSh);
      gAO = 0.62 * (1.0 - 0.35 * headSh);
      gWinMask = 1.0;
    }
    // sun-side shading of the recessed door pocket
    diffuseColor.rgb *= 1.0 - 0.35 * inDoor * sunFace;
    diffuseColor.rgb *= 0.86 + 0.14 * smoothstep(0.0, 2.0, f.y);

    float nightOnI = smoothstep(0.06, 0.42, uNight);
    float litI = step(0.62, fHash21(vec2(floor(f.x / 2.6) * 3.0, seed * 29.0))) * nightOnI;
    totalEmissiveRadiance += vec3(0.95, 0.93, 0.82) * lite * litI * 0.45;
  } else if (style > 0.5) {
    // the raw wall albedo, before any of the detail multiplies — blinds and spandrels are keyed off
    // it so a "closed blind" pane can never be brighter than the wall it sits in
    vec3 wallAlb = diffuseColor.rgb;
    // ================================================================ bay / floor layout
    float sideM = 0.55;
    float u = f.x - sideM;
    float usable = max(faceW - 2.0 * sideM, 0.5);
    float nB = max(1.0, floor(usable / bayW + 0.35));
    float bay = usable / nB;
    float bi = floor(u / bay);
    float uu = fract(u / bay);
    float inside = step(0.0, u) * step(u, usable);
    float isGround = step(f.y, groundH);
    float yA = f.y - groundH;
    float fi = mix(floor(yA / floorH) + 1.0, 0.0, isGround);
    float vv = mix(fract(yA / floorH), f.y / groundH, isGround);
    float h = mix(floorH, groundH, isGround);
    // a pitched-roof house has no parapet, so the 0.45 m top margin used by flat-roof blocks was
    // eating its entire upper storey of windows
    float topMargin = mix(0.45, 0.10, 1.0 - step(1.5, style));
    float nFl = floor((faceH - groundH - topMargin) / floorH + 0.001);
    float floorOk = mix(step(fi, nFl), 1.0, isGround);
    float hCell = fHash21(vec2(bi * 7.0 + faceId * 131.0, fi * 13.0 + seed * 977.0));
    float hCell2 = fHash21(vec2(fi * 3.1 + seed * 311.0, bi * 5.7 + faceId * 71.0));
    float isOffice = step(3.5, style) * (1.0 - step(4.5, style));
    float isHouse = 1.0 - step(1.5, style);
    float isRetail = step(2.5, style) * (1.0 - step(3.5, style));
    float shopFront = isRetail * isGround;
    float frontFace = step(1.5, faceId) * step(faceId, 2.5);
    // texel footprint relative to one bay: fades the window grid into its area average (anti-moire)
    float lod = smoothstep(0.10, 0.42, px / max(bay, 1.0));

    float wW = bay * winFrac, wH = h * 0.5, wC = 0.55;
    float isDoor = 0.0;
    vec3 frameCol = vec3(0.72);
    float frameRough = 0.45, frameMet = 0.05;
    // Glass is a DIELECTRIC now (metalness 0): glassTint is the dark room/plenum seen through the
    // pane and glassRefl scales the analytic sky reflection added below. The old metalness-0.9
    // "colour is the F0" trick relied entirely on the env probe, which returns ~0 for a pane that
    // reflects downwards — that is what made every window a black card.
    vec3 glassTint = vec3(0.030, 0.033, 0.038);
    float glassRough = 0.05;
    float glassRefl = 1.0;
    float recessD = 0.16;   // opening depth in metres
    float hasSill = 1.0;
    float plinthH = 0.0;    // masonry / stone base course
    if (isHouse > 0.5) {                                 // detached house
      wW = min(bay * 0.62, 1.85); wH = 1.55; wC = 0.55;
      float doorBay = floor(nB * 0.5);
      isDoor = isGround * step(abs(bi - doorBay), 0.1) * frontFace;
      wW = mix(wW, 1.02, isDoor); wH = mix(wH, 2.15, isDoor); wC = mix(wC, (2.15 * 0.5 + 0.06) / h, isDoor);
      frameCol = vec3(0.84, 0.83, 0.79); frameRough = 0.44;
      // a house window shows a room: dark, but warm and never black
      glassTint = mix(vec3(0.022, 0.020, 0.017), vec3(0.040, 0.037, 0.033), hCell2);
      glassRough = 0.10;
      recessD = mix(0.20, 0.10, isDoor);
      plinthH = 0.34;
    } else if (style < 2.5) {                            // apartment block
      wW = bay * winFrac; wH = h * 0.54; wC = 0.56;
      float tall = step(0.72, hCell2) * (1.0 - isGround);
      wH = mix(wH, h * 0.76, tall); wC = mix(wC, 0.49, tall);
      frameCol = vec3(0.33, 0.34, 0.36); frameRough = 0.40; frameMet = 0.25;
      glassTint = mix(vec3(0.019, 0.018, 0.017), vec3(0.036, 0.034, 0.030), hCell2);
      glassRough = 0.10;
      recessD = 0.21;
      plinthH = 0.85;
      if (isGround > 0.5) {
        float doorBay = floor(nB * 0.5);
        isDoor = step(abs(bi - doorBay), 0.1) * frontFace;
        // lobby: wide, floor-to-soffit glazing either side of the entrance
        float lobby = frontFace * step(abs(bi - doorBay), 1.6) * (1.0 - isDoor);
        wW = mix(wW, 1.9, isDoor); wH = mix(wH, 2.5, isDoor); wC = mix(wC, 1.31 / h, isDoor);
        wW = mix(wW, bay * 0.80, lobby); wH = mix(wH, h * 0.62, lobby); wC = mix(wC, 0.50, lobby);
        recessD = mix(mix(recessD, 0.12, lobby), 0.10, isDoor);
      }
    } else if (isRetail > 0.5) {                         // retail / shopfront
      if (isGround > 0.5) { wW = bay * 0.88; wH = groundH * 0.60; wC = 0.40; recessD = 0.13; hasSill = 0.0; }
      else { wW = bay * winFrac; wH = h * 0.54; wC = 0.56; recessD = 0.16; }
      frameCol = vec3(0.21, 0.22, 0.24); frameRough = 0.30; frameMet = 0.45;
      glassTint = mix(mix(vec3(0.020, 0.019, 0.018), vec3(0.037, 0.035, 0.031), hCell2), vec3(0.018, 0.019, 0.021), isGround);
      glassRough = mix(0.10, 0.05, isGround);
      glassRefl = mix(1.0, 1.10, isGround);
      plinthH = 0.30;
    } else {                                             // curtain wall
      // real mullion width: a 2 m bay carries a 12 cm mullion each side, and every floor gets an
      // opaque spandrel. Without that a tower is 90% mirror and reads as a black monolith.
      wW = bay - 0.24; wH = h - 0.26; wC = 0.5;
      // anodised aluminium mullion: metalness kept low enough that it still has a diffuse read
      // when the probe is dark, otherwise the whole grid measured Y 0.0000
      frameCol = vec3(0.46, 0.47, 0.49); frameRough = 0.32; frameMet = 0.30;
      glassTint = vec3(0.016, 0.019, 0.024) * vec3(1.0 - 0.18 * fract(seed * 3.7), 1.0, 0.90 + 0.24 * fract(seed * 5.13));
      glassRough = 0.05;
      // pane-to-pane variance is now a REFLECTIVITY variance of at most 1.35:1 (it used to be a
      // 200:1 albedo jump, which read as random white stickers rather than glazing)
      glassRefl = 0.86 + 0.34 * hCell;
      recessD = 0.11; hasSill = 0.0;
      plinthH = 0.9;
      if (isGround > 0.5) {   // lobby: taller clear glazing, deeper reveal, no spandrel
        wH = groundH - 1.5; wC = (1.5 * 0.5 + wH * 0.5) / h; wW = bay - 0.16;
        glassTint = vec3(0.030, 0.030, 0.031);
        glassRough = 0.05; glassRefl = 0.90;
        recessD = 0.30;
      }
    }

    // ------------------------------------------------------------------ opening + parallax reveal
    vec2 p = vec2((uu - 0.5) * bay, (vv - wC) * h);
    vec2 hwv = vec2(wW, wH) * 0.5;
    vec2 dd = abs(p) - hwv;
    vec2 aa = fwidth(f) * 0.9 + 0.004;
    float topOk = step(f.y + 0.3, faceH);
    float mask = inside * floorOk * topOk;
    float openF = fBox2(dd, aa) * mask;

    // parallax into the reveal. invZ is clamped hard (grazing angles otherwise stretch the offset
    // without bound, which serrated the jamb) and the AA width grows with it so the edge stays soft.
    float invZ = 1.0 / max(-ts.z, 0.30);
    vec2 pB = p + ts.xy * (recessD * invZ);           // where the ray meets the glass plane
    vec2 aaB = aa * (1.0 + recessD * invZ * 3.0);
    vec2 dBk = abs(pB) - hwv;
    float openB = fBox2(dBk, aaB);
    // where the ray leaves the opening sideways -> depth of the visible reveal point
    float tx = abs(ts.x) > 1e-4 ? ((ts.x > 0.0 ? hwv.x : -hwv.x) - p.x) / ts.x : 1e5;
    float ty = abs(ts.y) > 1e-4 ? ((ts.y > 0.0 ? hwv.y : -hwv.y) - p.y) / ts.y : 1e5;
    float revD = clamp(-ts.z * min(tx, ty), 0.0, recessD);
    float hitX = step(tx, ty);
    vec3 revN = normalize(mix(-sign(ts.y) * fBv, -sign(ts.x) * fTv, hitX) + fNv * 0.30);
    float reveal = clamp(openF - openF * openB, 0.0, 1.0);

    // frame ring sits at the back of the reveal, glass inside it
    float frameT = mix(0.075, 0.085, isOffice);
    float innerOpen = fBox2(dBk + frameT, aaB);
    float glass = openF * innerOpen;
    float frame = max(openF * openB - glass, 0.0);

    // glazing bars: vertical mullions + a transom on tall windows (faded out with distance)
    float paneW = mix(1.05, 1.55, isOffice);
    float panes = max(1.0, floor(wW / paneW + 0.5));
    float pwd = wW / max(panes, 1.0);
    float gx = (pB.x + hwv.x) / pwd;
    float dmx = abs(gx - floor(gx + 0.5)) * pwd;
    float bars = (1.0 - smoothstep(0.026 - aaB.x, 0.026 + aaB.x, dmx)) * step(1.5, panes);
    if (wH > 1.8) bars = max(bars, 1.0 - smoothstep(0.024 - aaB.y, 0.024 + aaB.y, abs(pB.y - (hwv.y - wH * 0.30))));
    bars = clamp(bars, 0.0, 1.0) * (1.0 - lod * mix(1.0, 0.45, isOffice));
    frame += glass * bars;
    glass *= 1.0 - bars;

    // curtain wall: opaque spandrel strip on the lower part of every floor (never on the lobby)
    float spandrel = isOffice * (1.0 - isGround) * step(vv, 0.32) * glass;
    glass -= spandrel;

    // ------------------------------------------------------------------ recess occlusion + sun shadow
    // ambient: a recessed pane sees a reduced slice of sky. This is the dark head band and the
    // shaded jambs, and because it lands on the INDIRECT term it survives into shadowed facades.
    float rd = max(recessD, 0.04);
    float aoHead = smoothstep(0.0, 2.2, (hwv.y - pB.y) / rd);
    float aoSide = smoothstep(0.0, 1.6, (hwv.x - abs(pB.x)) / rd);
    float aoFoot = smoothstep(0.0, 3.0, (pB.y + hwv.y) / rd);
    float glassAO = mix(0.34, 1.0, aoHead) * mix(0.66, 1.0, aoSide) * mix(0.80, 1.0, aoFoot);
    float revAO = mix(1.0, 0.22, revD / rd);

    // sun: the head/jamb of the reveal throws a hard shadow across the pane
    vec2 pS = pB + Lts.xy * (recessD / max(Lts.z, 0.02));
    float sunLit = fBox2(abs(pS) - hwv, aaB * 1.4);
    float shade = mix(1.0, sunLit, sunFace * 0.92);          // 1 = lit, ~0.08 = shadowed

    // ------------------------------------------------------------------ blinds / doors / glass look
    // Blinds are a matte panel BEHIND the glass. Keyed off the WALL albedo and capped at 0.9x it,
    // so a closed blind can never out-shine the wall — the old absolute 0.30-0.40 card was the
    // "bright pane at Y 0.194 against a wall at Y 0.001" the critique measured as a 200:1 jump.
    float blinds = step(mix(0.80, 0.90, isOffice), hCell) * (1.0 - isDoor) * (1.0 - shopFront);
    float wallY = dot(wallAlb, vec3(0.2126, 0.7152, 0.0722));
    vec3 blindHue = mix(vec3(0.86, 0.84, 0.80), vec3(0.78, 0.80, 0.84), isOffice);
    vec3 blindCol = blindHue * clamp(wallY, 0.06, 0.55) * mix(0.52, 0.88, hCell2);
    vec3 doorCol = mix(vec3(0.17, 0.10, 0.06), vec3(0.12, 0.13, 0.15), step(0.5, hCell2));
    // Dielectric pane: the tint is the dark room behind the glass (never black), the sky lives in
    // the explicit reflection below. metalness 0 keeps it off the dead env probe entirely.
    vec3 gcol = glassTint * (0.72 + 0.56 * hCell2);
    // interior floor: the bottom of a punched window shows a warm-lit room, the top shows sky
    gcol *= mix(vec3(1.26, 1.14, 0.98), vec3(0.92, 0.98, 1.10), smoothstep(-hwv.y, hwv.y, pB.y));
    float gmet = 0.0, grou = glassRough;
    // per-pane reflectivity spread, kept inside 0.82-1.18 so no pane can out-shine its neighbours
    float grefl = glassRefl * (0.82 + 0.36 * fract(hCell * 5.31 + hCell2 * 0.37));
    // the pane inherits its FAMILY from the carrier tint, so a downtown reads as bronze / green /
    // blue glass towers instead of one neutral grey-blue block (p4 minor: "narrow palette")
    vec3 wallHue = wallAlb / max(dot(wallAlb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
    vec3 paneFamily = mix(vec3(1.0), wallHue, 0.55 * isOffice);
    gcol *= paneFamily;
    // shopfront: a dark shop interior below the sky reflection, so a 4 m pane never reads as a sheet
    float interior = shopFront * (1.0 - smoothstep(-hwv.y * 0.5, hwv.y * 0.55, pB.y)) * 0.80;
    vec3 intCol = mix(vec3(0.075, 0.070, 0.062), vec3(0.20, 0.17, 0.13), hCell2) * (0.7 + 0.9 * hCell);
    gcol = mix(gcol, intCol, interior); grou = mix(grou, 0.30, interior); grefl = mix(grefl, 0.62, interior);
    // a shop is lit inside even by day: a faint warm glow behind the glass keeps the band alive
    totalEmissiveRadiance += vec3(1.0, 0.82, 0.58) * interior * glass * (0.030 + 0.075 * hCell) * (0.35 + 0.65 * uNight);
    gcol = mix(gcol, blindCol, blinds);  gmet = mix(gmet, 0.02, blinds);  grou = mix(grou, 0.60, blinds);  grefl = mix(grefl, 0.55, blinds);
    gcol = mix(gcol, doorCol, isDoor);   gmet = mix(gmet, 0.04, isDoor);  grou = mix(grou, 0.55, isDoor);  grefl = mix(grefl, 0.45, isDoor);
    // soffit / canopy shadow across the head of a shopfront pane
    gcol *= 1.0 - 0.45 * shopFront * (1.0 - smoothstep(hwv.y * 0.55, hwv.y * 1.0, pB.y)) * step(hwv.y * 0.55, pB.y);
    gcol *= mix(1.0, 0.55, 1.0 - shade);

    // ------------------------------------------------------------------ wall detail
    // sill: proud cast-stone shelf with a real, sun-directional drop shadow on the wall below
    float sillT = 0.10, sillProj = 0.14;
    float sillTop = step(-hwv.y - sillT, p.y) * step(p.y, -hwv.y + 0.005) * step(abs(p.x), hwv.x + 0.11) * mask * hasSill * (1.0 - isDoor);
    float drop = sillProj * clamp(Lts.y / max(Lts.z, 0.06), 0.0, 8.0);
    float latt = -sillProj * clamp(Lts.x / max(Lts.z, 0.06), -8.0, 8.0);
    float below = -(p.y + hwv.y + sillT);
    float sillShadow = step(0.0, below) * (1.0 - smoothstep(drop * 0.55, drop + 0.06, below))
                     * (1.0 - smoothstep(hwv.x + 0.02, hwv.x + 0.16, abs(p.x - latt)))
                     * mask * hasSill * (1.0 - isDoor) * sunFace;
    float ambSill = step(0.0, below) * (1.0 - smoothstep(0.0, 0.34, below))
                  * (1.0 - smoothstep(hwv.x + 0.02, hwv.x + 0.20, abs(p.x))) * mask * hasSill * (1.0 - isDoor);
    float grime = (1.0 - smoothstep(0.0, 1.7, below)) * (1.0 - smoothstep(hwv.x * 0.85, hwv.x * 1.15, abs(p.x)))
                * (0.4 + 0.6 * fVal(vec2(p.x * 5.0, bi * 3.0 + seed))) * (1.0 - isOffice) * mask;
    float edgeV = min(vv, 1.0 - vv) * h;
    // floor-slab band + the shadow it casts
    float band = (1.0 - smoothstep(0.05, 0.10, edgeV)) * (1.0 - isGround) * inside * (1.0 - isOffice) * step(1.5, style) * (1.0 - lod);
    // plinth: darker base course with a shadow line at its head
    float plinth = plinthH > 0.01 ? 1.0 - smoothstep(plinthH - 0.06, plinthH + 0.06, f.y) : 0.0;
    float plinthLine = plinthH > 0.01 ? (1.0 - smoothstep(0.0, 0.16, abs(f.y - plinthH))) : 0.0;
    // ground-floor head: the first-floor slab / fascia soffit shades the top of the ground storey
    float gfHead = isGround * (1.0 - smoothstep(0.0, 0.55, groundH - f.y)) * inside;

    vec3 wallBase = diffuseColor.rgb;
    // patchy render + weather staining: a 1K plaster map tiled at 3 m mips away to nothing by 30 m,
    // so the mottling that stops a wall reading as a flat colour field has to be procedural
    float stain = fVal(f * vec2(0.9, 0.42) + seed * 23.0);
    float dirtRun = smoothstep(0.55, 1.0, fVal(vec2(f.x * 1.5 + seed * 31.0, 0.5)))
                  * smoothstep(0.0, 0.35, 1.0 - f.y / max(faceH, 1.0));
    diffuseColor.rgb *= 0.80 + 0.40 * macro;
    diffuseColor.rgb *= 0.93 + 0.14 * stain;
    diffuseColor.rgb *= 1.0 - 0.13 * dirtRun;
    roughnessFactor = clamp(roughnessFactor * (0.92 + 0.18 * macro), 0.25, 1.0);
    diffuseColor.rgb *= 1.0 - 0.18 * grime;
    diffuseColor.rgb *= 1.0 - 0.15 * band;
    diffuseColor.rgb *= 1.0 - 0.12 * corner;
    diffuseColor.rgb *= 1.0 - 0.34 * ambSill - 0.34 * sillShadow;
    // plinth: cast stone / painted base, clearly a different material from the wall above
    vec3 plinthCol = mix(vec3(0.30, 0.295, 0.285), wallBase * 0.55, 0.35) * (0.86 + 0.26 * macro);
    diffuseColor.rgb = mix(diffuseColor.rgb, plinthCol, plinth * step(0.5, 1.0 - isHouse) * 0.92 + plinth * isHouse * 0.75);
    diffuseColor.rgb *= 1.0 - 0.26 * plinthLine;
    diffuseColor.rgb *= 1.0 - 0.30 * gfHead;
    // retail fascia (sign band) between shopfront and first floor — muted, never a saturated ribbon
    if (isRetail > 0.5) {
      float fb = step(groundH - 0.92, f.y) * step(f.y, groundH - 0.06) * inside;
      // shop band: a dark painted fascia. Hue is rotated out of the magenta arc and the chroma is
      // capped hard — a saturated violet ribbon above a shopfront reads as a z-fight artifact.
      float hue = fract(seed * 7.13) * 0.62;
      vec3 fascia = 0.5 + 0.5 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
      fascia = mix(vec3(0.085, 0.085, 0.088), fascia * 0.085, 0.30);
      diffuseColor.rgb = mix(diffuseColor.rgb, fascia, fb);
      roughnessFactor = mix(roughnessFactor, 0.55, fb);
      metalnessFactor = mix(metalnessFactor, 0.0, fb);
    }
    diffuseColor.rgb *= 0.84 + 0.16 * smoothstep(0.0, 1.8, f.y);
    vec3 wallCol = diffuseColor.rgb;
    float wallRough = roughnessFactor, wallMet = metalnessFactor;

    // ------------------------------------------------------------------ composite reveal / sill / frame / glass
    vec3 revCol = wallCol * mix(0.62, 1.0, shade);
    diffuseColor.rgb = mix(diffuseColor.rgb, revCol, reveal);
    roughnessFactor = mix(roughnessFactor, min(1.0, wallRough * 1.05), reveal);
    // sill: pale cast stone, slightly proud, catches the sky
    // cast stone reads as a lighter version of the wall, never a clean pure-white bar
    vec3 sillCol = clamp(mix(wallAlb * 1.22 + 0.045, vec3(0.46, 0.455, 0.44), 0.40), 0.05, 0.62) * (0.94 + 0.12 * hCell2);
    diffuseColor.rgb = mix(diffuseColor.rgb, sillCol, sillTop * 0.92);
    roughnessFactor = mix(roughnessFactor, 0.62, sillTop * 0.92);
    diffuseColor.rgb = mix(diffuseColor.rgb, frameCol * mix(0.55, 1.0, shade), frame);
    roughnessFactor = mix(roughnessFactor, frameRough, frame);
    metalnessFactor = mix(metalnessFactor, frameMet, frame);
    // spandrel: an opaque painted/enamelled panel — diffuse, so it catches the sun and gives the
    // tower a readable floor banding instead of one unbroken sheet of mirror
    vec3 spanCol = mix(vec3(0.155, 0.160, 0.170), frameCol * 0.55, 0.35) * (0.85 + 0.30 * hCell2);
    diffuseColor.rgb = mix(diffuseColor.rgb, spanCol, spandrel);
    roughnessFactor = mix(roughnessFactor, 0.42, spandrel);
    metalnessFactor = mix(metalnessFactor, 0.22, spandrel);
    diffuseColor.rgb = mix(diffuseColor.rgb, gcol, glass);
    roughnessFactor = mix(roughnessFactor, grou, glass);
    metalnessFactor = mix(metalnessFactor, gmet, glass);

    // ------------------------------------------------------------------ explicit sky reflection
    // The whole reason glass measured Y 0.001: a vertical pane reflects R = reflect(V, N), and a
    // mirror about a horizontal normal leaves R.y = V.y — so from any camera ABOVE street level the
    // pane points at the ground, where the PMREM sky probe is black. fSkyAt() gives it a real dome
    // (sky / horizon / ground-bounce) and fSkyFresnel() floors the specular at ~11.5 % of that, so
    // a frontal pane still lands Y 0.04-0.12 and a grazing one goes bright.
    float paneNdV = clamp(dot(fNv, -vDir), 0.0, 1.0);
    float paneRy = dot(reflect(vDir, fNv), upV);
    vec3 paneSky = fSkyAt(paneRy);
    // within one opening the head sees more sky than the cill: the top-to-bottom gradient the
    // critique asked for, on top of the natural gradient R.y gives down a tall facade
    float paneGrad = 0.74 + 0.52 * smoothstep(-hwv.y, hwv.y, pB.y);
    vec3 paneRefl = paneSky * fSkyFresnel(paneNdV) * paneGrad * mix(vec3(1.0), paneFamily, 0.45);
    // the reveal shades its own pane, and a recessed pane sees less of the dome
    float reflOcc = mix(0.55, 1.0, glassAO) * mix(0.72, 1.0, shade);
    // mullions and spandrels are glazing-system surfaces too — without a share of this the
    // aluminium grid stayed at Y 0.0000 and the tower read as a black monolith
    // The reveal, the mullion AND the strip of carrier wall between bays all catch the sky. On a
    // curtain wall that strip IS the mullion; leaving it out of the reflection is what kept the
    // aluminium grid at Y 0.000 so the tower read as a black monolith with a pane pattern on it.
    float glazedBg = isOffice * inside * clamp(1.0 - glass - frame - spandrel - reveal, 0.0, 1.0);
    float reflW = glass * grefl + frame * 0.46 + spandrel * 0.32 + reveal * 0.24 + glazedBg * 0.36;
    // past the LOD crossover the grid dissolves into its area average, so the reflection has to
    // follow it or a tower would lose all specular exactly where it matters most (hero altitude)
    float reflFar = clamp((wW * wH) / max(bay * h, 0.01), 0.0, 0.88) * mask;
    vec3 skyGlaze = paneRefl * reflOcc * mix(reflW, reflFar * 0.78, lod);
    totalEmissiveRadiance += skyGlaze * (1.0 - uInfo);   // info views stay flat-shaded

    // ------------------------------------------------------------------ ambient occlusion of the openings
    float nearN = 1.0 - lod;
    float ao = 1.0;
    ao *= mix(1.0, glassAO, clamp((glass + frame + spandrel) * nearN, 0.0, 1.0));
    ao *= mix(1.0, revAO, clamp(reveal * nearN, 0.0, 1.0));
    ao *= 1.0 - 0.45 * ambSill * nearN;
    ao *= 1.0 - 0.30 * gfHead;
    ao *= 1.0 - 0.22 * plinthLine;
    ao *= 1.0 - 0.18 * corner;
    ao *= 1.0 - 0.30 * band * nearN;
    gAO = clamp(ao, 0.06, 1.0);

    // normals: reveal side walls face inwards, glass + sill are flat, everything fades at distance
    float gA_pre = clamp((wW * wH) / max(bay * h, 0.01), 0.0, 0.88) * mask;
    normal = normalize(mix(normal, revN, clamp(reveal * nearN, 0.0, 1.0)));
    normal = normalize(mix(normal, fNv, clamp((glass + frame + spandrel) * nearN, 0.0, 1.0)));
    normal = normalize(mix(normal, normalize(fNv * 0.42 + fBv * 0.92), clamp(sillTop * nearN * 0.9, 0.0, 1.0)));

    gWinMask = clamp((glass + frame + spandrel) * nearN + gA_pre * lod, 0.0, 1.0);

    // ------------------------------------------------------------------ distance dissolve
    // The far average has to include the mullions, spandrels and slab edges, or a curtain-wall
    // tower collapses into one black mirror at hero altitude (round-4: "carpet of boxes").
    float gA = gA_pre;
    float frameFrac = mix(0.20, 0.38, isOffice);
    vec3 glassAvg = mix(gcol * 1.25, frameCol, frameFrac);
    float metAvg = mix(gmet, frameMet, frameFrac);
    float rouAvg = mix(grou, frameRough, frameFrac);
    vec3 farCol = mix(wallCol * 0.94, glassAvg, gA);
    diffuseColor.rgb = mix(diffuseColor.rgb, farCol, lod);
    roughnessFactor = mix(roughnessFactor, mix(wallRough, rouAvg, gA), lod);
    metalnessFactor = mix(metalnessFactor, mix(wallMet, metAvg, gA), lod);
    gAO = mix(gAO, 1.0 - 0.16 * gA, lod);

    // ------------------------------------------------------------------ night lights
    float nightOn = smoothstep(0.06, 0.42, uNight);
    float floorLamp = fHash21(vec2(fi * 19.0 + seed * 53.0, 3.0));
    float cell = mix(hCell, mix(hCell, floorLamp, 0.7), isOffice);
    float frac = clamp(litBias * 0.68 * nightOn, 0.0, 1.0);
    float lit = smoothstep(frac + 0.06, frac - 0.06, cell) * (1.0 - isDoor) * nightOn;
    vec3 lc = mix(vec3(1.0, 0.56, 0.24), vec3(1.0, 0.79, 0.53), hCell2);
    lc = mix(lc, vec3(0.62, 0.76, 1.0), step(0.92, hCell2));
    lc = mix(lc, vec3(0.84, 0.90, 1.0), isOffice * step(0.35, hCell2));
    float bright = mix(0.22, 0.85, fract(hCell * 17.0)) * mix(1.0, 0.42, blinds);
    float winMask = mix(glass, gA, lod);
    float emiss = clamp(winMask, 0.0, 1.0) * lit * bright;
    totalEmissiveRadiance += lc * emiss * 0.86;
    // spill onto the reveal so lit windows glow into their own opening
    totalEmissiveRadiance += lc * reveal * lit * bright * 0.34 * nearN;
    diffuseColor.rgb = mix(diffuseColor.rgb, lc * 0.14, min(1.0, emiss));
    metalnessFactor *= 1.0 - 0.85 * min(1.0, emiss);
    gAO = mix(gAO, 1.0, min(1.0, emiss));
  } else {
    diffuseColor.rgb *= (0.88 + 0.24 * macro) * (0.84 + 0.16 * smoothstep(0.0, 1.0, f.y));
    diffuseColor.rgb *= 1.0 - 0.10 * corner;
    gAO = 1.0 - 0.16 * corner;
  }
  }
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  diffuseColor.rgb = mix(diffuseColor.rgb, vTint * (0.35 + 0.65 * lum), uInfo);
  totalEmissiveRadiance += vTint * 0.12 * uInfo;
}
`;

/**
 * Replacement for <aomap_fragment>. Identical to the stock chunk except:
 *  - the wall AO map is faded out over glazing (gWinMask) — otherwise the masonry AO shows up inside
 *    every reflective pane, which is what made daytime glass read as a dirty grey hole;
 *  - the facade's own recess occlusion (gAO: window head band, jambs, sill underside, plinth line,
 *    parapet upstand) is applied to BOTH indirect diffuse and indirect specular, and it works with
 *    or without an aoMap, so openings stay tucked in even on unshadowed, purely ambient faces.
 */
const AO_FRAG = /* glsl */ `
	float ambientOcclusion = 1.0;
#ifdef USE_AOMAP
	ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	ambientOcclusion = mix( ambientOcclusion, 1.0, clamp( gWinMask, 0.0, 1.0 ) );
#endif
	ambientOcclusion *= clamp( gAO, 0.0, 1.0 );
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT )
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
`;

/**
 * Shadow-hue correction, injected after <lights_fragment_end> on every buildings material.
 *
 * The scene's sky fill is strongly blue, and on a purely ambient (shadowed) elevation it swamps the
 * wall's own albedo: our shadowed facades measured hue 252-264 deg (lavender) where CS2 holds
 * 32-44 deg. The fix keeps the *luminance* of the indirect term exactly as the lighting produced it
 * and rotates only its chromaticity back towards the material's own, retaining ~22 % of the sky's
 * cast so a shadow still measures cooler in B/R than the sunlit side. A small warm ground bounce is
 * then added, which is the other half of what CS2 does.
 *
 * Written as a replacement for the include so the effects module's wetness hook — which also
 * rewrites <lights_fragment_end> and re-emits the stock chunk first — still composes correctly.
 */
const SHADOW_HUE_FRAG = /* glsl */ `
#include <lights_fragment_end>
{
  const vec3 bLumW = vec3(0.2126, 0.7152, 0.0722);
  vec3 bInd = reflectedLight.indirectDiffuse;
  float bIl = dot(bInd, bLumW);
  vec3 bAlb = diffuseColor.rgb + 0.012;
  float bAl = max(dot(bAlb, bLumW), 1e-4);
  vec3 bNeutral = bAlb * (bIl / bAl);              // same luminance, illuminant forced to white
  reflectedLight.indirectDiffuse = mix(bNeutral, bInd, 0.16);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uGndBounce;
}
`;

/** Injects SHADOW_HUE_FRAG (and the uniform it needs) into a material's fragment shader. */
function patchShadowHue(shader) {
  if (shader.fragmentShader.includes('bLumW')) return;   // never apply the rotation twice
  if (!shader.fragmentShader.includes('uniform vec3 uGndBounce')) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uGndBounce;');
  }
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', SHADOW_HUE_FRAG);
}

function chainKey(material, key) {
  const prev = material.customProgramCacheKey;
  const isDefault = !prev || prev.toString().includes('return \'\'') || prev.toString().length < 40;
  material.customProgramCacheKey = function () { return key + (isDefault ? '' : '|' + prev.call(this)); };
}

/** Procedural facade material patch (see file header). */
export function patchFacade(material) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, FACADE_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + FACADE_VERT_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + FACADE_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FACADE_FRAG_PARS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize(mix(normal, nonPerturbedNormal, vFaceInfo.z));')
      .replace('#include <emissivemap_fragment>', FACADE_FRAG + '\n#include <emissivemap_fragment>')
      .replace('#include <aomap_fragment>', AO_FRAG);
    patchShadowHue(shader);
  };
  chainKey(material, 'bld-facade-v15');
  return material;
}

/**
 * World-scale UVs for instanced parts. mode: 'xz' (ground quads / roof slabs), 'slope' (gable & hip
 * roofs: u along ridge, v along the slope), 'cyl' (cylinders: u around the circumference), 'xy' (boxes,
 * front face), 'wall' (box faces by their own width).
 */
export function patchInstanceUv(material, mode = 'xz', texScale = 1) {
  let expr;
  switch (mode) {
    case 'slope': expr = 'vec2(iSc.x, sqrt(iSc.y * iSc.y + 0.25 * iSc.z * iSc.z))'; break;
    case 'cyl': expr = 'vec2(3.14159 * iSc.x, iSc.y)'; break;
    case 'xy': expr = 'vec2(iSc.x, iSc.y)'; break;
    default: expr = 'vec2(iSc.x, iSc.z)';
  }
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.uniforms.uGndBounce = FACADE_UNIFORMS.uGndBounce;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>',
      `#include <uv_vertex>\n${SCALE_GLSL}\n{ vec2 iUv = uv * ${expr} / ${texScale.toFixed(3)};\n${UV_ASSIGN}\n}`);
    patchShadowHue(shader);
  };
  chainKey(material, 'bld-iuv2-' + mode + '-' + texScale.toFixed(2));
  return material;
}

/**
 * Pitched-roof patch: world-scale slope UVs plus a real roof read at 12 m —
 *   · granule / shingle grain (two octaves of value noise at ~4 cm and ~15 cm),
 *   · a course break every ~0.32 m of slope with a soft shadow under each butt edge,
 *   · the eave course darkened by the fascia shadow and a lighter ridge capping course,
 *   · per-course and per-streak value variation, so a roof plane is never one flat colour field.
 */
export function patchRoof(material, texScale = 2.4, courseM = 0.34) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoofUv;')
      .replace('#include <uv_vertex>',
        `#include <uv_vertex>\n${SCALE_GLSL}\n{ vec2 sl = vec2(iSc.x, sqrt(iSc.y * iSc.y + 0.25 * iSc.z * iSc.z));\n vec2 mUv = uv * sl;\n vRoofUv = vec3(mUv, uv.y);\n vec2 iUv = mUv / ${texScale.toFixed(3)};\n${UV_ASSIGN}\n}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoofUv;
float rHash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float rVal(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(rHash(i),rHash(i+vec2(1.,0.)),f.x),mix(rHash(i+vec2(0.,1.)),rHash(i+vec2(1.,1.)),f.x),f.y);}`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
{
  float vslope = vRoofUv.z;
  vec2 ruv = vRoofUv.xy;
  float cM = ${courseM.toFixed(3)};
  float cy = ruv.y / cM;
  float ci = floor(cy);
  float cf = fract(cy);
  // stagger every other course so the butt joints do not line up
  float sx = ruv.x / (cM * 2.6) + 0.5 * mod(ci, 2.0);
  float tab = rHash(vec2(floor(sx), ci));
  float butt = 1.0 - smoothstep(0.0, 0.055, abs(fract(sx) - 0.5) * cM * 2.6);
  float shadowLine = 1.0 - smoothstep(0.0, 0.16, cf);          // shadow under each course butt
  float grain = rVal(ruv * 26.0) * 0.55 + rVal(ruv * 92.0) * 0.45;
  float macro = rVal(ruv * 0.55 + 3.0);
  float eave = 1.0 - smoothstep(0.0, 0.09, vslope);
  float cap = smoothstep(0.945, 0.995, vslope);
  diffuseColor.rgb *= 0.82 + 0.36 * tab;
  diffuseColor.rgb *= 0.82 + 0.36 * grain;
  diffuseColor.rgb *= 0.88 + 0.24 * macro;
  diffuseColor.rgb *= 1.0 - 0.24 * shadowLine;
  diffuseColor.rgb *= 1.0 - 0.28 * butt;
  diffuseColor.rgb *= 1.0 - 0.26 * eave;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.22 + 0.012, cap);
  roughnessFactor = clamp(roughnessFactor * (0.90 + 0.20 * grain), 0.3, 1.0);
}
#include <emissivemap_fragment>`);
    shader.uniforms.uGndBounce = FACADE_UNIFORMS.uGndBounce;
    patchShadowHue(shader);
  };
  chainKey(material, 'bld-roof3-' + texScale.toFixed(2) + '-' + courseM.toFixed(2));
  return material;
}

/**
 * Analytic sky reflection for the *plain* (non-facade) glazing materials — balcony balustrades,
 * lobby glazing, canopies, solar panels. Same reason as the facade panes: these are vertical or
 * slightly tilted mirrors that, from any camera above them, reflect downwards where the PMREM sky
 * probe is black, so without this they render as flat near-black cards.
 *
 * `strength` scales the reflection (solar glass is less reflective than architectural glazing).
 */
export function patchGlassSky(material, strength = 1.0) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.uniforms.uSkyUp = FACADE_UNIFORMS.uSkyUp;
    shader.uniforms.uSkyHz = FACADE_UNIFORMS.uSkyHz;
    shader.uniforms.uSkyDn = FACADE_UNIFORMS.uSkyDn;
    shader.uniforms.uGndBounce = FACADE_UNIFORMS.uGndBounce;
    if (!shader.fragmentShader.includes('fSkyAt')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + SKY_PARS_GLSL);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <emissivemap_fragment>', /* glsl */ `
{
  vec3 gUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 gV = -normalize(vViewPosition);
  vec3 gN = normalize(normal);
  vec3 gSky = fSkyAt(dot(reflect(gV, gN), gUp));
  totalEmissiveRadiance += gSky * fSkyFresnel(clamp(dot(gN, -gV), 0.0, 1.0)) * ${strength.toFixed(3)};
}
#include <emissivemap_fragment>`);
    patchShadowHue(shader);
  };
  chainKey(material, 'bld-glasssky-' + strength.toFixed(2));
  return material;
}

/**
 * The same analytic dome, but for METALS. A metal's whole appearance is its reflection: with
 * `metalness` 0.95 and a sky-only probe that returns nothing below the horizon, ducting, tanks and
 * profiled-steel cladding render as black cans. Here F0 is the albedo (as the standard BRDF has it),
 * the Schlick term is physical rather than floored, and the result is damped by roughness so a
 * 0.45-rough panel gets a soft sheen and a 0.15-rough trim gets a crisp one.
 */
export function patchMetalSky(material, strength = 0.65) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.uniforms.uSkyUp = FACADE_UNIFORMS.uSkyUp;
    shader.uniforms.uSkyHz = FACADE_UNIFORMS.uSkyHz;
    shader.uniforms.uSkyDn = FACADE_UNIFORMS.uSkyDn;
    shader.uniforms.uGndBounce = FACADE_UNIFORMS.uGndBounce;
    if (!shader.fragmentShader.includes('fSkyAt')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + SKY_PARS_GLSL);
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */ `
{
  vec3 mUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 mV = -normalize(vViewPosition);
  vec3 mN = normalize(normal);
  float mNdV = clamp(dot(mN, -mV), 0.0, 1.0);
  vec3 mF0 = mix(vec3(0.04), diffuseColor.rgb, metalnessFactor);
  vec3 mF = mF0 + (1.0 - mF0) * pow(1.0 - mNdV, 5.0);
  totalEmissiveRadiance += fSkyAt(dot(reflect(mV, mN), mUp)) * mF * (1.0 - 0.55 * roughnessFactor) * ${strength.toFixed(3)};
}
#include <emissivemap_fragment>`);
    patchShadowHue(shader);
  };
  chainKey(material, 'bld-metalsky-' + strength.toFixed(2));
  return material;
}

/** Per-instance atlas column: attribute aVariant selects one of `cols` columns of the map/emissiveMap. */
export function patchAtlas(material, cols = 8) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVariant;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n{ vec2 iUv = vec2((uv.x + aVariant) / ${cols.toFixed(1)}, uv.y);\n${UV_ASSIGN}\n}`);
  };
  chainKey(material, 'bld-atlas-' + cols);
  return material;
}
