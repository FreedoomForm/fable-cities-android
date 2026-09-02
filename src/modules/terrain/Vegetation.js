/**
 * Vegetation: procedural broadleaf + conifer trees. Broadleaves are a real branch skeleton (trunk →
 * primaries → forked secondaries) carrying leaf-spray cards clamped to the crown ellipsoid; conifers are
 * drooping bough cards anchored at the trunk in 17 tiers. Leaf cards use alpha-coverage preservation
 * (alpha scaled by mip level) so needles and leaves do not dissolve into bare trunks at range, a normal
 * map derived from the card, and a cheap wrap transmission term for backlit foliage. 3 shape variants per
 * species (oak: broad / low-round / tall; conifer: spruce / slim fir / open pine), three LODs
 * (full cards / reduced cards / 8-view impostor atlas with albedo + normal and a shaded belly),
 * rendered with InstancedMesh per kind×LOD, deterministic seeded distribution (forest mask × Worley
 * clumps → stands with edges, glades and gaps; in-map + a coarse impostor layer on the horizon ring so
 * forests never end on the map boundary), per-instance species/hue/value jitter, wind sway, and a
 * near-camera undergrowth layer (tufts, sheets, weeds, flowers, ferns — 8-cell atlas) tinted towards
 * the ground albedo and honouring every vegetation clear mask (+ roads.api.isOnRoad when present).
 *
 * Foliage / impostors / undergrowth live on engine.LAYER_NO_AO so the GTAO pre-pass (which renders
 * with an override material and cannot alpha-test) never sees the card rectangles.
 * Debug: `vegetation.debugLod = true; vegetation._forceUpdate = true` colours trees by LOD (R/G/B).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, hash2 } from '../../shared/random.js';
import { clamp, smoothstep, lerp } from '../../shared/math.js';
import { SimplexNoise } from '../../shared/noise.js';
import { makeBroadleafCardTexture, makeConiferCardTexture, makeUndergrowthAtlas } from './textures.js';

const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _lastCamPos = new THREE.Vector3(1e9, 0, 0);
const _lastCamDir = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const VIEWS = 8;
const LOD_DEBUG_COLOURS = [[1.0, 0.25, 0.25], [0.25, 1.0, 0.25], [0.3, 0.45, 1.0]];

// -------------------------------------------------------------------------------------------------
// geometry builders
// -------------------------------------------------------------------------------------------------

function taperedCylinder(rBottom, rTop, height, radial, base, dir, uvScale, shade = 1) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, radial, 1, true);
  g.translate(0, height / 2, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale[0], uv.getY(i) * uvScale[1]);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate(base.x, base.y, base.z);
  const col = new Float32Array(g.attributes.position.count * 3);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) { const s = shade * (0.7 + 0.3 * smoothstep(0, 3, pos.getY(i))); col[i * 3] = s; col[i * 3 + 1] = s; col[i * 3 + 2] = s; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * A quad card of size w×h oriented by quaternion `q` with an explicit shading normal and colour.
 * `anchorX/anchorY` shift the plane in its own space *before* the rotation (0.5 = left edge at `pos`).
 */
function card(w, h, pos, q, normal, shade, anchorX = 0, anchorY = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  if (anchorX || anchorY) g.translate(anchorX * w, anchorY * h, 0);
  g.applyQuaternion(q);
  g.translate(pos.x, pos.y, pos.z);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, normal.x, normal.y, normal.z);
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) { col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Quaternion that turns the card (facing +z) to face `dir`, with a random roll. */
function faceQuat(dir, roll) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  const r = new THREE.Quaternion().setFromAxisAngle(dir.clone().normalize(), roll);
  return r.multiply(q);
}

const _AX = new THREE.Vector3(1, 0, 0), _AY = new THREE.Vector3(0, 1, 0), _AZ = new THREE.Vector3(0, 0, 1);
/** Lay a card flat (width = radial, texture base at the trunk), then droop the tip and spin to azimuth. */
function boughQuat(azimuth, droop) {
  return new THREE.Quaternion().setFromAxisAngle(_AY, azimuth)
    .multiply(new THREE.Quaternion().setFromAxisAngle(_AZ, -droop))
    .multiply(new THREE.Quaternion().setFromAxisAngle(_AX, -Math.PI / 2));
}

function measure(geos) {
  let maxY = 0, maxR = 0;
  for (const g of geos) {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    maxY = Math.max(maxY, bb.max.y);
    maxR = Math.max(maxR, Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z));
  }
  return { height: maxY, width: maxR * 2 };
}

/**
 * Broadleaf: trunk → 4-6 primary branches → each forks into 1-2 secondaries; leaf sprays sit on the
 * branch tips and along their upper halves, so the crown silhouette is lumpy and branch structure is
 * visible through the gaps. Vertex colour bakes ambient occlusion (dark interior, bright upper rim).
 * variant 0 = broad oak, 1 = low wide rounded crown (drooping sprays), 2 = tall columnar (poplar/ash).
 */
function buildBroadleaf(rng, detail /* 0 full, 1 reduced */, variant = 0) {
  const columnar = variant === 2, round = variant === 1;
  const h = columnar ? rng.range(11.5, 14.5) : round ? rng.range(7.2, 9.2) : rng.range(9.6, 12.8);
  const lean = new THREE.Vector3(rng.range(-0.08, 0.08), 1, rng.range(-0.08, 0.08)).normalize();
  const trunkH = h * (columnar ? 0.32 : round ? 0.32 : 0.35);
  const trunkR = columnar ? 0.30 : round ? 0.30 : 0.38;
  const parts = [taperedCylinder(trunkR * 1.25, trunkR * 0.62, trunkH, detail ? 6 : 9, new THREE.Vector3(0, -0.2, 0), lean, [2.2, h * 0.45], 0.92)];
  const top = lean.clone().multiplyScalar(trunkH);
  // crown envelope
  const rx = columnar ? rng.range(3.2, 4.0) : round ? rng.range(4.4, 5.4) : rng.range(4.2, 5.4);
  const ry = columnar ? rng.range(4.4, 5.4) : round ? rng.range(2.8, 3.5) : rng.range(3.6, 4.5);
  const rz = rx * rng.range(0.82, 1.16);
  const centre = top.clone().add(new THREE.Vector3(rng.range(-0.6, 0.6), ry * (columnar ? 0.76 : 0.70), rng.range(-0.6, 0.6)));
  const tips = [];
  const nPrim = detail ? 5 : 6;
  for (let i = 0; i < nPrim; i++) {
    const a = (i / nPrim) * Math.PI * 2 + rng.range(-0.42, 0.42);
    const up = columnar ? rng.range(0.85, 1.6) : round ? rng.range(0.38, 0.85) : rng.range(0.55, 1.15);
    const dir = new THREE.Vector3(Math.cos(a) * 0.92, up, Math.sin(a) * 0.92).normalize();
    const bl = Math.min(rx, ry) * rng.range(0.52, 0.85);
    const base = lean.clone().multiplyScalar(trunkH * rng.range(0.5, 0.96));
    parts.push(taperedCylinder(trunkR * 0.5, trunkR * 0.2, bl, detail ? 4 : 6, base, dir, [1.2, 2], 0.82));
    const mid = base.clone().add(dir.clone().multiplyScalar(bl * 0.96));
    const nSec = 2;
    for (let k = 0; k < nSec; k++) {
      const a2 = a + (k ? 1 : -1) * rng.range(0.28, 0.85);
      const d2 = new THREE.Vector3(Math.cos(a2) * 0.98, columnar ? rng.range(0.5, 1.2) : rng.range(0.22, 0.9), Math.sin(a2) * 0.98).normalize();
      const l2 = bl * rng.range(0.42, 0.72);
      parts.push(taperedCylinder(trunkR * 0.22, trunkR * 0.07, l2, 4, mid, d2, [1, 2], 0.8));
      tips.push({ p: mid.clone().add(d2.clone().multiplyScalar(l2)), d: d2, w: 1 });
      tips.push({ p: mid.clone().add(d2.clone().multiplyScalar(l2 * 0.55)), d: d2, w: 0.8 });
    }
    tips.push({ p: mid.clone(), d: dir, w: 0.9 });
  }
  const trunk = mergeGeometries(parts, false);
  const cards = [];
  const sprayBase = Math.min(rx, ry);
  const addSpray = (p, outDir, scale, droopy) => {
    const rel = p.clone().sub(centre);
    // keep sprays inside the crown envelope — stray cards floating above a tree read as bugs
    const k = Math.hypot(rel.x / rx, rel.y / ry, rel.z / rz);
    if (k > 1.05) { rel.multiplyScalar(1.05 / k); p.copy(centre).add(rel); }
    const en = new THREE.Vector3(rel.x / (rx * rx), rel.y / (ry * ry), rel.z / (rz * rz));
    if (en.lengthSq() < 1e-6) en.set(0, 1, 0);
    en.normalize();
    const face = en.clone().multiplyScalar(0.55).add(outDir.clone().multiplyScalar(0.35)).add(new THREE.Vector3(0, droopy ? -0.15 : 0.28, 0)).normalize();
    const n = en.clone().multiplyScalar(0.42).add(new THREE.Vector3(0, 0.72, 0)).normalize();
    const sz = sprayBase * scale * (1.0 + 0.35 * clamp((p.y - centre.y) / Math.max(ry, 0.001), 0, 1));
    const heightF = clamp((p.y - (centre.y - ry)) / (2 * ry), 0, 1);
    const outF = clamp(rel.length() / Math.max(rx, ry), 0, 1);
    const shade = 0.46 + 0.54 * (0.62 * heightF + 0.38 * outF);
    cards.push(card(sz, sz * rng.range(0.86, 1.14), p, faceQuat(face, rng.range(0, Math.PI * 2)), n, shade));
  };
  for (const t of tips) {
    const per = detail ? 3 : 4;
    for (let k = 0; k < per; k++) {
      const jit = new THREE.Vector3(rng.range(-0.9, 0.9), rng.range(-0.7, 0.9), rng.range(-0.9, 0.9));
      const p = t.p.clone().add(t.d.clone().multiplyScalar(rng.range(-0.3, 0.7))).add(jit);
      addSpray(p, t.d, rng.range(1.00, 1.50) * t.w, round && rng() < 0.45);
    }
  }
  // a few interior sprays close the biggest holes without filling the crown solid
  const nFill = detail ? 4 : 5;
  for (let i = 0; i < nFill; i++) {
    const th = rng.range(0, Math.PI * 2), el = rng.range(-0.5, 0.9), rr = rng.range(0.25, 0.62);
    const p = new THREE.Vector3(Math.cos(th) * Math.cos(el) * rx * rr, Math.sin(el) * ry * rr, Math.sin(th) * Math.cos(el) * rz * rr).add(centre);
    addSpray(p, p.clone().sub(centre).normalize(), rng.range(0.85, 1.25), false);
  }
  const foliage = mergeGeometries(cards, false);
  const m = measure([trunk, foliage]);
  return { trunk, foliage, height: m.height, width: m.width };
}

/**
 * Conifer: variant 0 = spruce (dense drooping tiers), 1 = slimmer taller fir, 2 = open pine (long bare
 * trunk, a few flat boughs high up). Boughs are bough-texture cards anchored at the trunk, laid nearly
 * flat and drooped by 15-45° so they read from above and from the side.
 */
function buildConifer(rng, detail, variant = 0) {
  const pine = variant === 2;
  const h = pine ? rng.range(14, 18) : variant ? rng.range(15, 19.5) : rng.range(12, 16.5);
  const lean = new THREE.Vector3(rng.range(-0.02, 0.02), 1, rng.range(-0.02, 0.02)).normalize();
  const trunk = taperedCylinder(pine ? 0.34 : 0.28, pine ? 0.09 : 0.04, h * (pine ? 0.92 : 0.99), detail ? 5 : 8, new THREE.Vector3(0, -0.2, 0), lean, [2.4, h * 0.5], 0.7);
  const cards = [];
  const tiers = pine ? (detail ? 6 : 8) : (detail ? 14 : 17);
  const y0 = h * (pine ? 0.5 : variant ? 0.12 : 0.085);
  const y1 = h * (pine ? 0.92 : 0.96);
  const baseR = pine ? 3.0 : variant ? 2.5 : 3.4;
  for (let L = 0; L < tiers; L++) {
    const t = tiers > 1 ? L / (tiers - 1) : 1;
    const y = lerp(y0, y1, t) + rng.range(-0.18, 0.18);
    const radius = lerp(baseR, 0.40, Math.pow(t, pine ? 0.7 : 1.05)) * rng.range(0.82, 1.18);
    const per = pine ? 4 : Math.max(4, Math.round((detail ? 6 : 7) * (1 - 0.30 * t)));
    for (let k = 0; k < per; k++) {
      const a = (k / per) * Math.PI * 2 + L * 0.83 + rng.range(-0.32, 0.32);
      // old branches at the bottom sag hard; the leader's boughs stay close to horizontal
      const droop = lerp(pine ? 0.30 : 0.92, 0.34, t) * rng.range(0.82, 1.2);
      const q = boughQuat(a, droop);
      const n = _AZ.clone().applyQuaternion(q);
      const w = radius * rng.range(1.0, 1.3);
      const hh = radius * rng.range(0.95, 1.35);
      const shade = 0.44 + 0.56 * (0.55 * t + 0.45 * rng.range(0.45, 1.0));
      cards.push(card(w, hh, new THREE.Vector3(0, y, 0), q, n, shade, 0.5, 0));
      // inner filler bough (steeper, shorter) so the trunk never shows through between tiers
      if (k % (detail ? 3 : 2) === 0) {
        const q2 = boughQuat(a + 0.5, droop * 1.35);
        cards.push(card(radius * 0.62, radius * 0.8, new THREE.Vector3(0, y + 0.25, 0), q2, _AZ.clone().applyQuaternion(q2), shade * 0.82, 0.5, 0));
      }
    }
  }
  // leader: a small upright spike of two crossed boughs
  for (let k = 0; k < 2; k++) {
    const q = boughQuat(k * Math.PI / 2 + 0.4, -Math.PI * 0.40);
    const n = _AZ.clone().applyQuaternion(q);
    cards.push(card(h * 0.07 + 0.8, h * 0.06 + 0.8, new THREE.Vector3(0, y1 - 0.5, 0), q, n, 1.0, 0.5, 0));
  }
  const foliage = mergeGeometries(cards, false);
  const m = measure([trunk, foliage]);
  return { trunk, foliage, height: m.height, width: m.width };
}

// -------------------------------------------------------------------------------------------------
// materials
// -------------------------------------------------------------------------------------------------

const NO_FLIP_NORMAL = /* glsl */`
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize( vNormal );
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#ifdef DOUBLE_SIDED
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`;


/**
 * Alpha-test coverage preservation: mip-mapped foliage cards lose alpha as they shrink, which makes
 * needles and leaves dissolve at range (bare trunks). Scale alpha by the mip level so the covered
 * fraction stays roughly constant. `uMipBoost` ≈ 0.3-0.6.
 */
/**
 * Sky-bounce floor. Every CS2 reference frame measures 0.00% pure-black pixels; ours measured 20-27%
 * on forest clumps and near-field undergrowth. Nothing lit by an open sky can be darker than the
 * bounce it receives, so clamp indirect diffuse from below — hemisphere-driven, so it dims with the
 * sky instead of making the night glow.
 */
const SKY_FLOOR = /* glsl */`
#if NUM_HEMI_LIGHTS > 0
{
  vec3 skyFill = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, 0.68);
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, diffuseColor.rgb * skyFill);
  // ...and a MINIMUM-ALBEDO floor. The measured black pixels sit at rgb (1,3,4)/255 on a near-zero
  // albedo texel (baked AO in the atlas), so a floor proportional to albedo alone can never lift
  // them. 3% is about as dark as real foliage gets. Tinting the floor by the SURFACE and not by the
  // sky is what stops shadowed undergrowth turning blue.
  vec3 albMin = max(diffuseColor.rgb, diffuseColor.rgb * 0.80 + vec3(0.030, 0.038, 0.022));
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, albMin * skyFill * 2.10);
}
#endif`;

/**
 * Stochastic alpha test. A hard cutout makes every leaf card show its own quad boundary once the
 * alpha ramp is wider than a pixel — the "straight card edges on the crown" artifact. Jittering the
 * threshold with a per-pixel interleaved-gradient value dissolves the boundary into a stipple that
 * SMAA then resolves, so the crown silhouette ends in leaves instead of a rectangle.
 */
const STOCHASTIC_ALPHATEST = /* glsl */`
#ifdef USE_ALPHATEST
{
  float ignA = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (diffuseColor.a < alphaTest * (0.62 + 0.76 * ignA)) discard;
}
#endif`;

const MIP_ALPHA_BOOST = /* glsl */`
#ifdef USE_MAP
{
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 ddx = dFdx(vMapUv * tsz), ddy = dFdy(vMapUv * tsz);
  float lodF = 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy)) + 1e-6);
  diffuseColor.a *= 1.0 + max(lodF, 0.0) * uMipBoost;
}
#endif`;

function windPatch(shader, windUniforms, strengthMul, heightRange) {
  Object.assign(shader.uniforms, windUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;`)
    .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
{
  vec3 iPos = vec3(instanceMatrix[3]);
  float phase = dot(iPos.xz, vec2(0.031, 0.047)) + uTime * 1.15;
  float heightF = smoothstep(${heightRange[0].toFixed(2)}, ${heightRange[1].toFixed(2)}, position.y);
  float sway = (sin(phase) * 0.6 + sin(phase * 2.17 + 1.3) * 0.4) * uWindStrength * ${strengthMul.toFixed(3)} * heightF;
  transformed.xz += uWindDir * sway;
  transformed += normal * sin(uTime * 3.3 + phase * 4.0 + position.y * 2.0) * 0.04 * uWindStrength * heightF;
}
#endif`);
}

function makeLeafMaterial(tex, tint, windUniforms, engine, translucency = 0.55, mipBoost = 0.42) {
  // MATERIAL_TARGET: foliage 0.70, not 0.88 — a leaf has a waxy cuticle, and that cuticle is a real
  // clearcoat lobe. Physical (not Standard) so the coat gives leaves a specular sheen off the sky.
  const m = new THREE.MeshPhysicalMaterial({
    map: tex.map, normalMap: tex.normalMap || null, alphaTest: 0.30, side: THREE.DoubleSide,
    roughness: 0.70, metalness: 0, color: new THREE.Color(...tint), vertexColors: true,
    clearcoat: 0.30, clearcoatRoughness: 0.28,
  });
  if (tex.normalMap) m.normalScale.set(0.55, 0.55);
  m.name = 'tree-leaves';
  m.onBeforeCompile = (shader) => {
    windPatch(shader, windUniforms, 0.32, [0, 6]);
    shader.uniforms.uTrans = { value: translucency };
    shader.uniforms.uMipBoost = { value: mipBoost };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL)
      .replace('#include <common>', '#include <common>\nuniform float uTrans;\nuniform float uMipBoost;')
      .replace('#include <map_fragment>', '#include <map_fragment>' + MIP_ALPHA_BOOST)
      // subsurface: sunlight bleeding through a backlit leaf card (cheap wrap transmission)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
  vec3 Lv = normalize(directionalLights[0].direction);
  float back = clamp(dot(normalize(vViewPosition), -Lv), 0.0, 1.0);
  float wrapped = clamp(dot(normal, Lv) * 0.4 + 0.6, 0.0, 1.0);
  vec3 warm = vec3(1.06, 1.0, 0.72);
  reflectedLight.directDiffuse += diffuseColor.rgb * warm * directionalLights[0].color * (uTrans * pow(back, 2.5) * wrapped);
  // sky/canopy bounce: leaves in shadow keep a little light, so a forest clump is never a black hole
  reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * 0.048;
}
#endif` + SKY_FLOOR)
      .replace('#include <alphatest_fragment>', STOCHASTIC_ALPHATEST);
  };
  m.customProgramCacheKey = () => 'fable-leaf-v14';
  engine.registerMaterial(m);
  return m;
}

function makeBarkMaterial(tex, windUniforms, engine) {
  const m = new THREE.MeshStandardMaterial({ map: tex.map || null, normalMap: tex.normalMap || null, roughnessMap: tex.roughnessMap || null, roughness: 0.85, metalness: 0, color: 0xffffff, vertexColors: true });
  m.name = 'tree-bark';
  m.onBeforeCompile = (shader) => {
    windPatch(shader, windUniforms, 0.32, [0, 6]);
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', '#include <aomap_fragment>' + SKY_FLOOR);
  };
  m.customProgramCacheKey = () => 'fable-bark-v9';
  engine.registerMaterial(m);
  return m;
}

/** Camera-facing impostor that picks one of 8 baked azimuth views according to the instance yaw. */
function makeImpostorMaterial(albedo, normal, engine) {
  const m = new THREE.MeshStandardMaterial({ map: albedo, normalMap: normal, alphaTest: 0.42, roughness: 0.72, metalness: 0, side: THREE.FrontSide, color: 0xffffff });
  m.normalScale.set(1.0, 1.0);
  m.name = 'tree-impostor';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uMipBoost = { value: 0.5 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMipBoost;')
      .replace('#include <map_fragment>', '#include <map_fragment>' + MIP_ALPHA_BOOST)
      // An impostor is one flat quad: its single normal faces the camera, so as soon as the sun is not
      // behind the viewer N·L collapses and the whole tree goes to ambient — that is the "pure black
      // silhouette at range" bug. Real canopies scatter, so add a wrapped/transmitted term that keeps
      // a backlit crown readable, exactly like the LOD0/LOD1 leaf cards already do.
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
  vec3 Lv = normalize(directionalLights[0].direction);
  float wrapped = clamp(dot(normal, Lv) * 0.34 + 0.66, 0.0, 1.0);
  float back = clamp(dot(normalize(vViewPosition), -Lv), 0.0, 1.0);
  vec3 warm = vec3(1.05, 1.0, 0.80);
  reflectedLight.directDiffuse += diffuseColor.rgb * warm * directionalLights[0].color
    * (0.55 * wrapped * wrapped + 0.30 * pow(back, 2.0) * wrapped);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * 0.062;
}
#endif
#if NUM_HEMI_LIGHTS > 0
// sky fill floor: a crown at 600 m is never darker than the ambient it sits in
{
  vec3 fill = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, 0.68);
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, diffuseColor.rgb * fill * 0.78);
  vec3 albMinI = max(diffuseColor.rgb, diffuseColor.rgb * 0.80 + vec3(0.030, 0.038, 0.022));
  reflectedLight.indirectDiffuse = max(reflectedLight.indirectDiffuse, albMinI * fill * 2.10);
}
#endif`)
      .replace('#include <alphatest_fragment>', STOCHASTIC_ALPHATEST);
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_vertex>', `#include <uv_vertex>
float impAng = 0.0;
#ifdef USE_INSTANCING
{
  vec3 iPos = vec3(instanceMatrix[3]);
  vec3 c0 = instanceMatrix[0].xyz;
  float yawI = atan(-c0.z, c0.x);
  vec2 toCam = cameraPosition.xz - iPos.xz;
  float bbAng = atan(toCam.x, toCam.y);
  impAng = bbAng - yawI;
  float k = mod(floor(impAng / (PI2 / ${VIEWS.toFixed(1)}) + 0.5) + ${(VIEWS * 4).toFixed(1)}, ${VIEWS.toFixed(1)});
  vec2 cell = vec2(mod(k, 4.0), floor(k / 4.0));
  #ifdef USE_MAP
  vMapUv = (vMapUv + cell) / vec2(4.0, 2.0);
  #endif
  #ifdef USE_NORMALMAP
  vNormalMapUv = (vNormalMapUv + cell) / vec2(4.0, 2.0);
  #endif
}
#endif`)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = vec3(normal);
#ifdef USE_INSTANCING
objectNormal = vec3(sin(impAng), 0.0, cos(impAng));
#endif
#ifdef USE_TANGENT
vec3 objectTangent = vec3( tangent.xyz );
#endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
{
  float bs = sin(impAng), bc = cos(impAng);
  transformed.xz = vec2(transformed.x * bc, -transformed.x * bs);
}
#endif`);
  };
  m.customProgramCacheKey = () => 'fable-impostor-v12';
  engine.registerMaterial(m);
  return m;
}

// bake material: mode 0 = albedo × vertex colour × vertical shading (dark belly), 1 = view-space normal
const BAKE_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN; varying vec3 vC; varying float vH;
uniform float uH;
void main() { vUv = uv; vN = normalize(normalMatrix * normal); vC = color; vH = position.y / uH; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BAKE_FRAG = /* glsl */`
uniform sampler2D map; uniform vec3 color; uniform int mode; uniform int useMap; uniform float uBelly;
varying vec2 vUv; varying vec3 vN; varying vec3 vC; varying float vH;
void main() {
  vec4 c = useMap == 1 ? texture2D(map, vUv) : vec4(1.0);
  if (useMap == 1) {
    vec2 tsz = vec2(textureSize(map, 0));
    vec2 ddx = dFdx(vUv * tsz), ddy = dFdy(vUv * tsz);
    c.a *= 1.0 + max(0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy)) + 1e-6), 0.0) * 0.5;
  }
  if (c.a < 0.5) discard;
  if (mode == 0) {
    float belly = mix(1.0 - uBelly, 1.0, smoothstep(0.05, 0.75, vH));
    gl_FragColor = vec4(c.rgb * color * vC * belly, 1.0);
  } else { vec3 n = normalize(vN); n.z = abs(n.z) * 0.8 + 0.2; n = normalize(n); gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }
}`;

/** Render the LOD0 tree from 8 azimuths into a 4×2 atlas (albedo + normal). */
function bakeImpostor(renderer, parts, cell = 256) {
  const scene = new THREE.Scene();
  const W = parts.width, H = parts.height;
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H, 0, 0.1, 200);
  const mk = (mode, map, color, belly) => new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide, vertexColors: true,
    uniforms: { map: { value: map }, color: { value: new THREE.Color(color) }, mode: { value: mode }, useMap: { value: map ? 1 : 0 }, uH: { value: H }, uBelly: { value: belly } },
  });
  const trunk = new THREE.Mesh(parts.trunk, null), leaves = new THREE.Mesh(parts.foliage, null);
  scene.add(trunk, leaves);
  const out = {};
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevViewport = new THREE.Vector4(), prevScissor = new THREE.Vector4();
  renderer.getViewport(prevViewport); renderer.getScissor(prevScissor);
  const prevScissorTest = renderer.getScissorTest();
  const W4 = cell * 4, H2 = cell * 2;
  for (const mode of [0, 1]) {
    const rt = new THREE.WebGLRenderTarget(W4, H2, { type: mode === 0 ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.anisotropy = 4;
    trunk.material = mk(mode, parts.barkMap, 0xffffff, 0.18);
    leaves.material = mk(mode, parts.leafMap, parts.leafTint || 0xffffff, 0.26);
    // sub-rect rendering goes through the target's own viewport/scissor (the renderer's viewport is canvas state)
    rt.scissorTest = true;
    rt.viewport.set(0, 0, W4, H2); rt.scissor.set(0, 0, W4, H2);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(mode === 0 ? 0x2c4a22 : 0x8080ff, 0);
    renderer.clear(true, true, true);
    for (let k = 0; k < VIEWS; k++) {
      const a = (k / VIEWS) * Math.PI * 2;
      cam.position.set(Math.sin(a) * 60, 0, Math.cos(a) * 60);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      const cx = (k % 4) * cell, cy = Math.floor(k / 4) * cell;
      rt.viewport.set(cx, cy, cell, cell); rt.scissor.set(cx, cy, cell, cell);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    }
    rt.viewport.set(0, 0, W4, H2); rt.scissor.set(0, 0, W4, H2); rt.scissorTest = false;
    trunk.material.dispose(); leaves.material.dispose();
    out[mode === 0 ? 'albedo' : 'normal'] = rt.texture;
    out[mode === 0 ? 'albedoRT' : 'normalRT'] = rt;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setViewport(prevViewport); renderer.setScissor(prevScissor); renderer.setScissorTest(prevScissorTest);
  renderer.setClearColor(prevClear, prevAlpha);
  return { ...out, width: W, height: H };
}

// -------------------------------------------------------------------------------------------------
// vegetation system
// -------------------------------------------------------------------------------------------------

export class Vegetation {
  /**
   * @param {object} o
   * @param {(x:number,z:number,h:number,slope:number)=>number} o.forestMask 0..1 tree probability
   * @param {(x:number,z:number)=>{grass:number,dry:number,rock:number,sand:number,slope:number,h:number,forest:number}} o.groundInfo
   * @param {(x:number,z:number,out?:number[])=>number[]} [o.groundTint] mean ground albedo (sRGB 0..1) for undergrowth tinting
   * @param {(x:number,z:number)=>boolean} [o.isBlocked] extra undergrowth blocker (e.g. roads.api.isOnRoad)
   * @param {{oak:object, fir:object}} o.bark PBR texture sets
   */
  constructor({ renderer, engine, heightmap, seed, quality, forestMask, groundInfo, groundTint = null, isBlocked = null, bark, half }) {
    this.renderer = renderer;
    this.engine = engine;
    this.hm = heightmap;
    this.seed = seed;
    this.quality = quality;
    this.forestMask = forestMask;
    this.groundInfo = groundInfo;
    this.groundTint = groundTint;
    this.isBlocked = isBlocked;
    this.bark = bark;
    this.half = half;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.group.matrixAutoUpdate = false;
    this.windUniforms = { uTime: { value: 0 }, uWindDir: { value: new THREE.Vector2(0.7, 0.3) }, uWindStrength: { value: 0.35 } };
    const dq = Math.sqrt(clamp(quality.density, 0.3, 1.4));
    // LOD1 reaches far because impostors are single billboards and cannot cast a usable shadow —
    // a wide shot with no tree shadows was the "flat lighting" note.
    this.lodDistances = [Math.round(165 * dq), Math.round(520 * dq)];
    this.caps = [Math.round(820 * quality.density), Math.round(3000 * quality.density)];
    this.kinds = [];
    this.treeCount = 0;
    this._forceUpdate = true;
    this._frame = 0;
    this.debugLod = false;
    this.clusterNoise = new SimplexNoise(hash2(seed, 909));
    this.clumpSeed = hash2(seed, 5151);
    // 4 m clear mask over the playable map (trees are removed individually; undergrowth consults this)
    this.maskCell = 4;
    this.maskN = Math.ceil((half * 2) / this.maskCell);
    this.clearMask = new Uint8Array(this.maskN * this.maskN);
    this.layerNoAo = engine.LAYER_NO_AO != null ? engine.LAYER_NO_AO : 1;
    this.layerReflected = engine.LAYER_REFLECTED != null ? engine.LAYER_REFLECTED : 3;
  }

  build() {
    const rng = makeRng(hash2(this.seed, 777));
    const renderer = this.renderer;
    // three broadleaf palettes (warm oak, pale birch/ash, deep maple) and two conifer palettes
    const leafOak = makeBroadleafCardTexture(512, hash2(this.seed, 1), 96, 0.26, 0.33);
    const leafBirch = makeBroadleafCardTexture(512, hash2(this.seed, 2), 79, 0.30, 0.30);
    const leafMaple = makeBroadleafCardTexture(512, hash2(this.seed, 5), 112, 0.23, 0.36);
    const leafSpruce = makeConiferCardTexture(512, hash2(this.seed, 3), 126, 0.19);
    const leafPine = makeConiferCardTexture(512, hash2(this.seed, 4), 108, 0.22);
    // kinds = species × shape variant. `species` 0 oak/maple (mid green), 1 birch/ash (pale), 2 conifer
    const defs = [
      { name: 'oak-a', species: 0, variant: 0, build: buildBroadleaf, leafMap: leafOak, bark: this.bark.oak, tint: [0.66, 0.70, 0.58] },
      { name: 'oak-b', species: 0, variant: 1, build: buildBroadleaf, leafMap: leafMaple, bark: this.bark.oak, tint: [0.60, 0.67, 0.55] },
      { name: 'oak-c', species: 0, variant: 2, build: buildBroadleaf, leafMap: leafOak, bark: this.bark.oak, tint: [0.65, 0.71, 0.57] },
      { name: 'birch-a', species: 1, variant: 0, build: buildBroadleaf, leafMap: leafBirch, bark: this.bark.oak, tint: [0.74, 0.75, 0.56] },
      { name: 'birch-b', species: 1, variant: 1, build: buildBroadleaf, leafMap: leafBirch, bark: this.bark.oak, tint: [0.71, 0.74, 0.55] },
      { name: 'birch-c', species: 1, variant: 2, build: buildBroadleaf, leafMap: leafMaple, bark: this.bark.oak, tint: [0.69, 0.74, 0.57] },
      { name: 'spruce-a', species: 2, variant: 0, build: buildConifer, leafMap: leafSpruce, bark: this.bark.fir, tint: [0.44, 0.52, 0.43] },
      { name: 'spruce-b', species: 2, variant: 1, build: buildConifer, leafMap: leafSpruce, bark: this.bark.fir, tint: [0.41, 0.49, 0.42] },
      { name: 'pine-c', species: 2, variant: 2, build: buildConifer, leafMap: leafPine, bark: this.bark.fir, tint: [0.52, 0.57, 0.42] },
    ];
    defs.forEach((def, ki) => {
      const lod0 = def.build(makeRng(hash2(this.seed, 1000 + ki * 7)), 0, def.variant);
      const lod1 = def.build(makeRng(hash2(this.seed, 1001 + ki * 7)), 1, def.variant);
      const imp = bakeImpostor(renderer, { ...lod0, barkMap: def.bark.map || null, leafMap: def.leafMap.map, leafTint: new THREE.Color(...def.tint).multiplyScalar(0.88) }, 256);
      const leafMat = makeLeafMaterial(def.leafMap, def.tint, this.windUniforms, this.engine, def.species === 2 ? 0.30 : 0.62, def.species === 2 ? 0.62 : 0.40);
      const barkMat = makeBarkMaterial(def.bark, this.windUniforms, this.engine);
      const impMat = makeImpostorMaterial(imp.albedo, imp.normal, this.engine);
      const impGeo = new THREE.PlaneGeometry(imp.width, imp.height);
      impGeo.translate(0, imp.height / 2, 0);
      this.kinds.push({ def, lod0, lod1, imp, leafMat, barkMat, impMat, impGeo, meshes: null });
    });
    this.kindsBySpecies = [[], [], []];
    defs.forEach((d, i) => this.kindsBySpecies[d.species].push(i));
    this._distribute(rng);
    this._createInstancedMeshes();
    this._buildUndergrowth();
    return this;
  }

  /**
   * Worley-cell clumping: jittered 34 m cells with a per-cell density (some empty → glades), rounded
   * falloff towards the cell edge → stands with edges and gaps instead of a uniform scatter.
   */
  _clump(px, pz) { return this._worley(px, pz, 46, 3) * this._worley(px, pz, 15, 11); }

  /** One Worley octave: jittered cells, some empty (glades), rounded falloff to the cell edge. */
  _worley(px, pz, C, salt) {
    const gx = Math.floor(px / C), gz = Math.floor(pz / C);
    let best = Infinity, bestH = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cz = gz + j;
      const hsh = hash2(hash2(hash2(this.clumpSeed, salt), cx * 7919), cz * 104729);
      const sx = (cx + ((hsh & 0xffff) / 65535)) * C, sz = (cz + (((hsh >>> 16) & 0xffff) / 65535)) * C;
      const dx = px - sx, dz = pz - sz;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bestH = hsh; }
    }
    best = Math.sqrt(best);
    const dens = ((bestH >>> 8) & 0xff) / 255;
    if (dens < 0.16) return 0.05;                                 // glade
    const r = C * (0.52 + 0.44 * dens);
    const inside = 1 - smoothstep(r * 0.55, r, best);
    return Math.min(1.25, (0.55 + 0.85 * dens) * (0.30 + 0.70 * inside));
  }

  _distribute(rng) {
    const hm = this.hm, wl = hm.waterLevel;
    const dens = clamp(this.quality.density, 0.3, 1.4);
    const spacing = 4.6 / Math.sqrt(dens);
    const half = this.half - 6;
    const trees = [];
    const kindsBySpecies = this.kindsBySpecies;
    const pushTree = (px, pz, h, slope, p, horizon) => {
      if (rng() > p) return;
      const coniferP = clamp(smoothstep(20, 70, h - wl) * 0.85 + 0.06 + 0.35 * this.clusterNoise.fbm2D(px / 190 + 4, pz / 190 - 9, 2), 0, 1);
      const species = rng() < coniferP ? 2 : (rng() < 0.62 ? 0 : 1);
      const ks = kindsBySpecies[species];
      const kind = ks[Math.min(ks.length - 1, Math.floor(rng() * ks.length))];
      const sxz = clamp(1 + rng.gaussian() * 0.13, 0.74, 1.32) * (horizon ? 1.15 : 1);
      const sy = sxz * rng.range(0.9, 1.15);
      // per-instance colour: ±8° hue (warm ↔ cool), ±15 % value, a few autumn-tinged broadleaves
      const hueS = rng.range(-1, 1), val = rng.range(0.85, 1.15);
      let r = val * (1 + 0.16 * hueS), g = val * (1 + 0.02 * hueS), b = val * (1 - 0.22 * hueS);
      if (species !== 2 && rng() < 0.07) { r *= 1.18; g *= 0.96; b *= 0.68; }
      if (species === 2) { r *= 0.95; b *= 1.04; }
      trees.push({ x: px, y: h - 0.12, z: pz, sxz, sy, yaw: rng.range(0, Math.PI * 2), kind, species, horizon, alive: 1, r, g, b });
    };
    // in-map trees (full LOD chain)
    for (let z = -half; z <= half; z += spacing) {
      for (let x = -half; x <= half; x += spacing) {
        const px = x + rng.range(-0.48, 0.48) * spacing, pz = z + rng.range(-0.48, 0.48) * spacing;
        const h = hm.getHeight(px, pz);
        if (h < wl + 1.6) continue;
        const slope = hm.getSlope(px, pz);
        if (slope > 0.42) continue;
        let p = this.forestMask(px, pz, h, slope);
        if (p < 0.01) continue;
        const gi = this.groundInfo(px, pz);
        if (gi.rock > 0.35 || gi.sand > 0.6) continue;
        p *= 1 - smoothstep(0.28, 0.42, slope);
        // trees ONLY live in stands / copses — a lone tree standing in open meadow was the round-3 note
        const cl = this._clump(px, pz);
        if (cl < 0.62) continue;
        p *= 1.5 * lerp(0.18, 1, clamp((cl - 0.55) / 0.62, 0, 1));
        pushTree(px, pz, h, slope, p, 0);
      }
    }
    // horizon ring (impostor only): coarser, from the 8 m outer grid
    if (hm.outer) {
      const sp = 9.5;
      const outerHalf = hm.outer.half - 12;
      for (let z = -outerHalf; z <= outerHalf; z += sp) {
        for (let x = -outerHalf; x <= outerHalf; x += sp) {
          if (Math.abs(x) < this.half + 2 && Math.abs(z) < this.half + 2) continue;
          const px = x + rng.range(-0.48, 0.48) * sp, pz = z + rng.range(-0.48, 0.48) * sp;
          const h = hm.outer.getHeight(px, pz);
          if (h < wl + 1.6) continue;
          const slope = hm.getSlopeAny(px, pz);
          if (slope > 0.4) continue;
          const cl = this._clump(px, pz);
          const p0 = this.forestMask(px, pz, h, slope);
          if (cl < 0.62) continue;
          const p = p0 * 1.3 * (1 - smoothstep(0.28, 0.4, slope)) * lerp(0.18, 1, clamp((cl - 0.55) / 0.62, 0, 1));
          pushTree(px, pz, h, slope, p, 1);
        }
      }
    }
    this.trees = trees;
    this.treeCount = trees.length;
    // spatial grid (32 m cells) for fast clearing (in-map only)
    this.cell = 32;
    this.grid = new Map();
    trees.forEach((t, i) => {
      if (t.horizon) return;
      const k = this._cellKey(t.x, t.z);
      let a = this.grid.get(k);
      if (!a) { a = []; this.grid.set(k, a); }
      a.push(i);
    });
  }

  _cellKey(x, z) { return (Math.floor((x + this.half) / this.cell) << 12) | Math.floor((z + this.half) / this.cell); }

  _createInstancedMeshes() {
    const total = this.trees.length;
    for (let k = 0; k < this.kinds.length; k++) {
      const kd = this.kinds[k];
      const cap0 = this.caps[0], cap1 = this.caps[1], cap2 = Math.max(1, total);
      const mk = (geo, mat, cap, shadow, colour, noAo) => {
        const im = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = shadow;
        im.receiveShadow = true;
        im.matrixAutoUpdate = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (noAo) im.layers.set(this.layerNoAo);
        im.layers.enable(this.layerReflected);
        if (colour) {
          im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 3), 3);
          im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        im.name = `trees-${kd.def.name}`;
        this.group.add(im);
        return im;
      };
      kd.meshes = [
        [mk(kd.lod0.trunk, kd.barkMat, cap0, true, false, false), mk(kd.lod0.foliage, kd.leafMat, cap0, true, true, true)],
        [mk(kd.lod1.trunk, kd.barkMat, cap1, true, false, false), mk(kd.lod1.foliage, kd.leafMat, cap1, true, true, true)],
        [mk(kd.impGeo, kd.impMat, cap2, false, true, true)],
      ];
      kd.caps = [cap0, cap1, cap2];
    }
    this._cand0 = [];
    this._cand1 = [];
  }

  /** Per-frame: LOD assignment + instance matrices (only when the camera moved). */
  update(camera, dt, elapsed, env) {
    const wu = this.windUniforms;
    wu.uTime.value = elapsed;
    if (env) {
      wu.uWindStrength.value = 0.15 + (env.windStrength || 0) * 0.85;
      if (env.wind) wu.uWindDir.value.copy(env.wind).normalize();
    }
    this._frame++;
    camera.getWorldDirection(_camDir);
    const moved = camera.position.distanceToSquared(_lastCamPos) > 1.0 || _camDir.dot(_lastCamDir) < 0.9995;
    if (!moved && !this._forceUpdate) { this._updateUndergrowth(camera, false); return; }
    this._forceUpdate = false;
    _lastCamPos.copy(camera.position);
    _lastCamDir.copy(_camDir);

    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const pl of _frustum.planes) pl.constant += 45;   // shadow casters just outside the view still exist

    const d0 = this.lodDistances[0] ** 2, d1 = this.lodDistances[1] ** 2;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const kinds = this.kinds;
    const counts = kinds.map(() => [0, 0, 0]);
    const trees = this.trees;
    const cand0 = this._cand0, cand1 = this._cand1;
    cand0.length = 0; cand1.length = 0;
    // pass 1: impostors directly, near trees collected so the caps keep the NEAREST ones
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      if (!t.alive) continue;
      const dx = t.x - cx, dy = t.y + 6 - cy, dz = t.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      _sphere.center.set(t.x, t.y + 7 * t.sy, t.z);
      _sphere.radius = 10 * t.sxz;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      if (t.horizon || d2 >= d1) { this._writeInstance(t, 2, counts); continue; }
      if (d2 < d0) cand0.push(d2, i); else cand1.push(d2, i);
    }
    const capAll0 = this.caps[0], capAll1 = this.caps[1];
    const demote = (cand, cap, next) => {
      const n = cand.length / 2;
      if (n <= cap) return null;
      const idx = new Array(n);
      for (let k = 0; k < n; k++) idx[k] = k;
      idx.sort((a, b) => cand[a * 2] - cand[b * 2]);
      const keep = [], rest = [];
      for (let k = 0; k < n; k++) (k < cap ? keep : rest).push(cand[idx[k] * 2], cand[idx[k] * 2 + 1]);
      cand.length = 0; for (const v of keep) cand.push(v);
      if (next) for (const v of rest) next.push(v); else return rest;
      return null;
    };
    demote(cand0, capAll0, cand1);
    const overflow1 = demote(cand1, capAll1, null);
    for (let k = 0; k < cand0.length; k += 2) this._writeInstance(trees[cand0[k + 1]], 0, counts);
    for (let k = 0; k < cand1.length; k += 2) this._writeInstance(trees[cand1[k + 1]], 1, counts);
    if (overflow1) for (let k = 0; k < overflow1.length; k += 2) this._writeInstance(trees[overflow1[k + 1]], 2, counts);
    for (let k = 0; k < kinds.length; k++) {
      const kd = kinds[k];
      for (let lod = 0; lod < 3; lod++) {
        const n = counts[k][lod];
        const first = kd.meshes[lod][0];
        for (const m of kd.meshes[lod]) {
          m.count = n;
          if (m !== first) m.instanceMatrix.array.set(first.instanceMatrix.array.subarray(0, n * 16));
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
      }
    }
    this._updateUndergrowth(camera, true);
  }

  _writeInstance(t, lod, counts) {
    const kd = this.kinds[t.kind];
    const c = counts[t.kind];
    if (c[lod] >= kd.caps[lod]) return;
    const k = c[lod]++;
    const arr = kd.meshes[lod][0].instanceMatrix.array;
    const o = k * 16;
    const cs = Math.cos(t.yaw) * t.sxz, sn = Math.sin(t.yaw) * t.sxz;
    arr[o] = cs; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = t.sy; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = cs; arr[o + 11] = 0;
    arr[o + 12] = t.x; arr[o + 13] = t.y; arr[o + 14] = t.z; arr[o + 15] = 1;
    const last = kd.meshes[lod][kd.meshes[lod].length - 1];
    if (last.instanceColor) {
      const col = last.instanceColor.array;
      if (this.debugLod) { const d = LOD_DEBUG_COLOURS[lod]; col[k * 3] = d[0]; col[k * 3 + 1] = d[1]; col[k * 3 + 2] = d[2]; }
      else {
        // instance tints never darken a tree below ~0.45 luminance (black trees are always a bug elsewhere)
        const lum = 0.3 * t.r + 0.59 * t.g + 0.11 * t.b;
        const f = lum < 0.45 ? 0.45 / Math.max(lum, 1e-3) : 1;
        col[k * 3] = t.r * f; col[k * 3 + 1] = t.g * f; col[k * 3 + 2] = t.b * f;
      }
    }
  }

  // ------------------------------------------------------------------------------------------- clearing
  _forEachTreeIn(x0, z0, x1, z1, fn) {
    const c0x = Math.floor((x0 + this.half) / this.cell), c1x = Math.floor((x1 + this.half) / this.cell);
    const c0z = Math.floor((z0 + this.half) / this.cell), c1z = Math.floor((z1 + this.half) / this.cell);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const a = this.grid.get((cx << 12) | cz);
      if (a) for (const i of a) fn(this.trees[i]);
    }
  }
  _markMask(x0, z0, x1, z1, test) {
    const n = this.maskN, c = this.maskCell, h = this.half;
    const i0 = clamp(Math.floor((x0 + h) / c), 0, n - 1), i1 = clamp(Math.floor((x1 + h) / c), 0, n - 1);
    const j0 = clamp(Math.floor((z0 + h) / c), 0, n - 1), j1 = clamp(Math.floor((z1 + h) / c), 0, n - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -h + (i + 0.5) * c, z = -h + (j + 0.5) * c;
      if (!test || test(x, z)) this.clearMask[j * n + i] = 1;
    }
    this._undergrowthDirty = true;
  }
  /** True when undergrowth must not grow at (x,z) (roads, lots, service pads, flattened areas). */
  isCleared(x, z) {
    const i = Math.floor((x + this.half) / this.maskCell), j = Math.floor((z + this.half) / this.maskCell);
    if (i < 0 || j < 0 || i >= this.maskN || j >= this.maskN) return false;
    return this.clearMask[j * this.maskN + i] === 1;
  }
  clearRect(x0, z0, x1, z1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
    let n = 0;
    this._forEachTreeIn(ax, az, bx, bz, (t) => { if (t.alive && t.x >= ax && t.x <= bx && t.z >= az && t.z <= bz) { t.alive = 0; n++; } });
    this._markMask(ax, az, bx, bz, null);
    if (n) this._forceUpdate = true;
    return n;
  }
  clearCircle(x, z, r) {
    let n = 0;
    const r2 = r * r;
    this._forEachTreeIn(x - r, z - r, x + r, z + r, (t) => { if (t.alive && (t.x - x) ** 2 + (t.z - z) ** 2 <= r2) { t.alive = 0; n++; } });
    this._markMask(x - r, z - r, x + r, z + r, (px, pz) => (px - x) ** 2 + (pz - z) ** 2 <= (r + 2) ** 2);
    if (n) this._forceUpdate = true;
    return n;
  }
  /** Clear a yaw-rotated rectangle (building / service footprint) with a margin. */
  clearOriented(x, z, w, d, yaw = 0, margin = 0) {
    const hw = w / 2 + margin, hd = d / 2 + margin;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const R = Math.hypot(hw, hd);
    const inside = (px, pz) => {
      const dx = px - x, dz = pz - z;
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      return Math.abs(lx) <= hw && Math.abs(lz) <= hd;
    };
    let n = 0;
    this._forEachTreeIn(x - R, z - R, x + R, z + R, (t) => { if (t.alive && inside(t.x, t.z)) { t.alive = 0; n++; } });
    this._markMask(x - R, z - R, x + R, z + R, inside);
    if (n) this._forceUpdate = true;
    return n;
  }
  /** Clear trees along a polyline of {x,z} (or Vector3) points with a total corridor width. */
  clearPolyline(points, width) {
    const r = width / 2;
    let n = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z, len2 = abx * abx + abz * abz || 1;
      const minx = Math.min(a.x, b.x) - r, maxx = Math.max(a.x, b.x) + r, minz = Math.min(a.z, b.z) - r, maxz = Math.max(a.z, b.z) + r;
      const distOk = (px, pz, rr) => {
        const u = clamp(((px - a.x) * abx + (pz - a.z) * abz) / len2, 0, 1);
        return (px - (a.x + abx * u)) ** 2 + (pz - (a.z + abz * u)) ** 2 <= rr * rr;
      };
      this._forEachTreeIn(minx, minz, maxx, maxz, (t) => { if (t.alive && distOk(t.x, t.z, r)) { t.alive = 0; n++; } });
      this._markMask(minx, minz, maxx, maxz, (px, pz) => distOk(px, pz, r + 2));
    }
    if (n) this._forceUpdate = true;
    return n;
  }
  /** Re-snap tree heights after a terrain edit inside a rect. */
  resnap(x0, z0, x1, z1) {
    this._forEachTreeIn(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), (t) => { t.y = this.hm.getHeight(t.x, t.z) - 0.12; });
    this._forceUpdate = true;
    this._undergrowthDirty = true;
  }
  aliveCount() { let n = 0; for (const t of this.trees) n += t.alive; return n; }

  /**
   * Crown coverage of the in-map trees on a res×res grid (0..1), used to place the forest-floor layer
   * only under actual canopy. Each tree splats a soft disc of its crown radius.
   */
  canopyCoverage(res, out) {
    if (!out) out = new Float32Array(res * res);
    const cell = (this.half * 2) / res;
    for (const t of this.trees) {
      if (!t.alive || t.horizon) continue;
      const r = this.kinds[t.kind].lod0.width * 0.5 * t.sxz * 1.15;
      const i0 = Math.max(0, Math.floor((t.x - r + this.half) / cell)), i1 = Math.min(res - 1, Math.floor((t.x + r + this.half) / cell));
      const j0 = Math.max(0, Math.floor((t.z - r + this.half) / cell)), j1 = Math.min(res - 1, Math.floor((t.z + r + this.half) / cell));
      for (let j = j0; j <= j1; j++) {
        const dz = -this.half + (j + 0.5) * cell - t.z;
        for (let i = i0; i <= i1; i++) {
          const dx = -this.half + (i + 0.5) * cell - t.x;
          const d = Math.hypot(dx, dz) / r;
          if (d >= 1) continue;
          const k = j * res + i;
          out[k] = Math.min(1, out[k] + 0.7 * (1 - d * d));
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- undergrowth
  _buildUndergrowth() {
    if (this.quality.density < 0.5) { this.grass = null; return; }
    const tex = makeUndergrowthAtlas(1024, hash2(this.seed, 44));
    const quads = [];
    for (let k = 0; k < 3; k++) {
      const g = new THREE.PlaneGeometry(1.0, 1.0);
      g.translate(0, 0.5, 0);
      g.rotateY((k / 3) * Math.PI + 0.29);
      const n = g.attributes.normal;
      // face the normals up: turf must be lit by the sky, not by whichever way a card happens to face
      for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
      quads.push(g);
    }
    const geo = mergeGeometries(quads, false);
    const cap = Math.round(52000 * clamp(this.quality.density, 0.5, 1.3));
    const varAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    varAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVar', varAttr);
    this.grassRadius = 64;
    const uniforms = { uGrassCenter: { value: new THREE.Vector2() }, uGrassRadius: { value: this.grassRadius } };
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, color: 0xffffff });   // MATERIAL_TARGET: grass / ground cover 0.85
    mat.name = 'undergrowth';
    mat.onBeforeCompile = (shader) => {
      windPatch(shader, this.windUniforms, 0.2, [0.0, 0.9]);
      Object.assign(shader.uniforms, uniforms);
      shader.uniforms.uMipBoost = { value: 0.45 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGWorld;\nvarying float vCardY;\nattribute float aVar;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vCardY = uv.y;
#ifdef USE_MAP
vMapUv = vMapUv * vec2(0.25, 0.5) + vec2(mod(aVar, 4.0), floor(aVar * 0.25 + 0.01)) * vec2(0.25, 0.5);
#endif`)
        .replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 gw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  gw = instanceMatrix * gw;
#endif
  vGWorld = (modelMatrix * gw).xz; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uGrassCenter; uniform float uGrassRadius; uniform float uMipBoost; varying vec2 vGWorld; varying float vCardY;')
        .replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL)
        .replace('#include <map_fragment>', `#include <map_fragment>` + MIP_ALPHA_BOOST + `
// root shadow: the bottom fifth of every card darkens towards the ground so tufts sit IN the turf
diffuseColor.rgb *= mix(0.84, 1.0, smoothstep(0.0, 0.3, vCardY));`)
        .replace('#include <alphatest_fragment>', `diffuseColor.a *= 1.0 - smoothstep(uGrassRadius * 0.5, uGrassRadius * 0.95, distance(vGWorld, uGrassCenter));`
          + STOCHASTIC_ALPHATEST)
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>' + SKY_FLOOR);
    };
    mat.customProgramCacheKey = () => 'fable-undergrowth-v11';
    this.engine.registerMaterial(mat);
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = true;
    im.matrixAutoUpdate = false;
    im.name = 'undergrowth';
    im.layers.set(this.layerNoAo);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.group.add(im);
    this.grass = { mesh: im, uniforms, cap, varAttr, lastCenter: new THREE.Vector2(1e9, 1e9) };
  }

  _updateUndergrowth(camera, cameraMoved) {
    const g = this.grass;
    if (!g) return;
    const cam = camera.position;
    camera.getWorldDirection(_camDir);
    // focus the undergrowth patch on the ground the camera looks at, but never further than ~55 m —
    // a near-horizontal view must still have turf around the camera, not 800 m down the valley
    const t = clamp(_camDir.y < -0.05 ? -(cam.y - this.hm.getHeight(cam.x, cam.z)) / _camDir.y : 1e6, 0, 55);
    const fx = cam.x + _camDir.x * t, fz = cam.z + _camDir.z * t;
    const camHeight = cam.y - this.hm.getHeight(cam.x, cam.z);
    if (camHeight > 170) { if (g.mesh.count) g.mesh.count = 0; return; }
    if (!cameraMoved && g.mesh.count && !this._undergrowthDirty) return;
    if (!this._undergrowthDirty && Math.hypot(fx - g.lastCenter.x, fz - g.lastCenter.y) < 6 && g.mesh.count) return;
    this._undergrowthDirty = false;
    g.lastCenter.set(fx, fz);
    g.uniforms.uGrassCenter.value.set(fx, fz);
    const R = this.grassRadius, cell = 8;
    const arr = g.mesh.instanceMatrix.array, col = g.mesh.instanceColor.array, vars = g.varAttr.array;
    let n = 0;
    const c0x = Math.floor((fx - R) / cell), c1x = Math.floor((fx + R) / cell), c0z = Math.floor((fz - R) / cell), c1z = Math.floor((fz + R) / cell);
    const perCell = 96 * this.quality.density;
    const wl = this.hm.waterLevel;
    const half = this.half;
    const TUFT_AVG = [0.24, 0.32, 0.16];   // mean colour of the atlas tufts (sRGB) — the ground tint is expressed relative to it
    const tint = [0, 0, 0];
    const blocked = this.isBlocked;
    outer: for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const ccx = (cx + 0.5) * cell, ccz = (cz + 0.5) * cell;
      const dFocus = Math.hypot(ccx - fx, ccz - fz);
      if (dFocus > R + 6) continue;
      if (Math.abs(ccx) > half || Math.abs(ccz) > half) continue;
      const rng = makeRng(hash2(hash2(this.seed, cx * 73856093), cz * 19349663));
      const info = this.groundInfo(ccx, ccz);
      const cluster = smoothstep(-0.35, 0.45, this.clusterNoise.fbm2D(ccx / 19, ccz / 19, 2));
      const meadow = (info.grass + info.dry * 0.8) * (1 - smoothstep(0.25, 0.4, info.slope)) * (0.35 + 0.65 * cluster) * (1 - 0.85 * info.sand);
      const fern = info.forest * smoothstep(0.4, 0.8, info.forest) * (1 - smoothstep(0.3, 0.45, info.slope)) * 0.45;
      // ~4× density close to the focus point, tapering to 1× at ~45 m (continuous turf near the camera)
      const near = 1 + 7.0 * (1 - smoothstep(14, 55, dFocus));
      const nFern = Math.round(perCell * 0.35 * fern * near);
      const count = Math.round(perCell * clamp(meadow, 0, 1) * near) + nFern;
      if (!count) continue;
      // ground tint → tuft colour multiplier (55 % towards the ground albedo)
      let mr = 1, mg = 1, mb = 1;
      if (this.groundTint) {
        this.groundTint(ccx, ccz, tint);
        mr = lerp(1, clamp(tint[0] / TUFT_AVG[0], 0.78, 1.30), 0.55); mg = lerp(1, clamp(tint[1] / TUFT_AVG[1], 0.78, 1.30), 0.55); mb = lerp(1, clamp(tint[2] / TUFT_AVG[2], 0.78, 1.30), 0.55);
      }
      const dryFrac = info.dry / Math.max(0.05, info.grass + info.dry);
      for (let k = 0; k < count; k++) {
        const x = cx * cell + rng() * cell, z = cz * cell + rng() * cell;
        const isFern = k < nFern;
        const h = this.hm.getHeight(x, z);
        if (h < wl + 0.5) continue;
        if (this.isCleared(x, z)) continue;
        if (blocked && blocked(x, z)) continue;
        const dryPick = rng() < dryFrac;
        const u = rng();
        let v, sx, sy;
        // grass is TALLER than it is wide. The round-3 note ("a bed of identical cabbage rosettes")
        // came from 1.7 m wide / 0.5 m tall cards; upright tufts now dominate the mix.
        if (isFern) { v = 3; sx = rng.range(0.85, 1.45); sy = sx * rng.range(0.80, 1.15); }
        else if (u < 0.40) { v = dryPick ? 2 : 0; sx = rng.range(0.30, 0.52); sy = rng.range(0.44, 0.86); }        // fine upright tuft
        else if (u < 0.60) { v = 1; sx = rng.range(0.34, 0.60); sy = rng.range(0.52, 1.00); }                      // tall bent-grass w/ seed heads
        else if (u < 0.82) { v = dryPick ? 7 : 4; sx = rng.range(0.62, 1.10); sy = rng.range(0.24, 0.44); }        // low sward filler
        else if (u < 0.90) { v = 5; sx = rng.range(0.34, 0.58); sy = rng.range(0.20, 0.34); }                      // weeds / clover
        else { v = dryPick ? 2 : 6; sx = rng.range(0.28, 0.50); sy = rng.range(0.40, 0.72); }                      // wildflowers
        const yaw = rng.range(0, Math.PI);
        const c = Math.cos(yaw) * sx, sn = Math.sin(yaw) * sx;
        const o = n * 16;
        arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
        arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
        arr[o + 12] = x; arr[o + 13] = h - 0.07; arr[o + 14] = z; arr[o + 15] = 1;
        const br = rng.range(0.66, 1.14) * (dryPick ? 0.88 : 1), hs = rng.range(-0.14, 0.14);
        const blend = isFern ? 0.4 : 1;
        col[n * 3] = clamp(br * (1 + hs) * lerp(1, mr, blend), 0.18, 1.25);
        col[n * 3 + 1] = clamp(br * (1 + hs * 0.15) * lerp(1, mg, blend), 0.18, 1.25);
        col[n * 3 + 2] = clamp(br * (1 - hs * 1.35) * lerp(1, mb, blend), 0.18, 1.25);
        vars[n] = v;
        n++;
        if (n >= g.cap) break outer;
      }
    }
    g.mesh.count = n;
    g.mesh.instanceMatrix.needsUpdate = true;
    g.mesh.instanceColor.needsUpdate = true;
    g.varAttr.needsUpdate = true;
  }

  dispose() {
    for (const kd of this.kinds) {
      kd.lod0.trunk.dispose(); kd.lod0.foliage.dispose(); kd.lod1.trunk.dispose(); kd.lod1.foliage.dispose(); kd.impGeo.dispose();
      kd.leafMat.dispose(); kd.barkMat.dispose(); kd.impMat.dispose();
      if (kd.def.leafMap) { kd.def.leafMap.map.dispose(); if (kd.def.leafMap.normalMap) kd.def.leafMap.normalMap.dispose(); }
      kd.imp.albedoRT.dispose(); kd.imp.normalRT.dispose();
    }
    if (this.grass) { this.grass.mesh.geometry.dispose(); if (this.grass.mesh.material.map) this.grass.mesh.material.map.dispose(); this.grass.mesh.material.dispose(); }
  }
}
