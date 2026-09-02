/**
 * Global lit-material patch registered through engine.addMaterialHook (environment is the only
 * module allowed to touch lighting/fog in every material):
 *
 *  - exponential HEIGHT FOG: density(y) = fogDensity * exp(-(y - y0) / H), integrated analytically
 *    along the camera→fragment segment (engine.setFogHeight(y0, H)); a uniform-haze floor keeps the
 *    Rayleigh aerial perspective on distant peaks while valleys / the waterfront hold the mist
 *  - CLOUD SHADOWS: the direct light of every directional light is multiplied by an R8 texture
 *    sampled in world XZ (engine.setSunModulation(texture, xf)) — the texture is baked from the
 *    same weather map that drives the volumetric clouds and drifts with the wind
 *  - RAIN WETNESS is *written* here (engine.globalUniforms.uWetness, every frame); the wet look itself
 *    (darkening, gloss, puddles, ripples, snow) is the effects module's material hook (WetSurfaces.js)
 *
 * All uniforms are the shared engine.globalUniforms objects (plus one module-owned vec2), so a
 * single write per frame reaches every material. Materials whose chunks were already replaced by
 * their owner are patched only where the anchor still exists — never broken.
 */
import * as THREE from 'three';

const VARYING = 'varying vec3 vFcWorldPos;\n';

const VERTEX_ASSIGN = /* glsl */ `
{
  vec4 fcP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    fcP = batchingMatrix * fcP;
  #endif
  #ifdef USE_INSTANCING
    fcP = instanceMatrix * fcP;
  #endif
  vFcWorldPos = ( modelMatrix * fcP ).xyz;
}
`;

const WETNESS_DECL = 'uniform float uWetness;\n';

const FRAG_HEADER = /* glsl */ `
uniform sampler2D uSunModulation;
uniform vec4 uSunModulationXf;
uniform vec2 uFogHeight;
uniform vec3 uFcFogParams; // x: uniform-haze floor 0..1 (1 = plain exp2 fog), y: sun-glow strength through fog, z: max fog opacity
uniform vec3 uFcSunDir;    // toward the sun
uniform vec3 uFcFogWarm;   // aerial-perspective tint toward the sun (golden hour: warm)
uniform vec3 uFcFogCool;   // aerial-perspective tint away from the sun (golden hour: cool blue)
varying vec3 vFcWorldPos;
// mean height-fog density factor along the camera→fragment segment (analytic integral of exp(-y/H))
float fcHeightFogFactor( float depth, float density ) {
  float H = max( uFogHeight.y, 1.0 );
  float yc = max( cameraPosition.y - uFogHeight.x, -2.5 * H );
  float yf = max( vFcWorldPos.y - uFogHeight.x, -2.5 * H );
  float ea = exp( -yc / H );
  float eb = exp( -yf / H );
  float dy = yf - yc;
  float avg = abs( dy ) > 0.5 ? ( ea - eb ) * H / dy : ea;
  avg = clamp( avg, 0.0, 8.0 );
  float d = density * mix( avg, 1.0, uFcFogParams.x );
  // Aerial perspective saturates: real haze lifts distant blacks toward the sky but never erases the silhouette.
  // CS2's far third keeps 35-52 % of the near field's local contrast (LOOK_TARGET row 12), so cap the opacity.
  return ( 1.0 - exp( -d * d * depth * depth ) ) * uFcFogParams.z;
}
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = fcHeightFogFactor( vFogDepth, fogDensity );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth ) * uFcFogParams.z;
  #endif
  // directional aerial perspective: the haze is warm in the sun-facing hemisphere and stays cool blue away from it
  // (a single scene fog colour cannot do this, and a uniformly warm haze is what made golden hour read khaki).
  // Plus forward scattering in a fog medium: a soft glow toward the sun (depth cue, keeps a light direction in fog).
  vec3 fcV = normalize( vFcWorldPos - cameraPosition );
  float fcAz = dot( normalize( vec3( fcV.x, 0.0, fcV.z ) + vec3( 1e-5, 0.0, 0.0 ) ), normalize( vec3( uFcSunDir.x, 0.0, uFcSunDir.z ) + vec3( 1e-5, 0.0, 0.0 ) ) );
  vec3 fcFogCol = fogColor * mix( uFcFogCool, uFcFogWarm, smoothstep( -0.35, 0.85, fcAz ) );
  if ( uFcFogParams.y > 0.001 ) {
    fcFogCol *= 1.0 + uFcFogParams.y * pow( max( dot( fcV, uFcSunDir ), 0.0 ), 10.0 );
  }
  // aerial perspective also DESATURATES: distant hills approach neutral before they approach the sky colour
  // (LOOK_TARGET rows 11/12 — our far field used to be crisper and more chromatic than our foreground).
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.55 * fogFactor );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fcFogCol, fogFactor );
#endif
`;

const SUN_MOD_DECL = 'float fcSunMod = texture2D( uSunModulation, vFcWorldPos.xz * uSunModulationXf.xy + uSunModulationXf.zw ).r;\n';
const DIR_LIGHT_INFO = /getDirectionalLightInfo\(\s*directionalLights?(?:\s*\[\s*\d+\s*\])?\s*,\s*directLight\s*\);/g;

/**
 * Create the hook. `extra` = { uFcFogParams, uFcSunDir } module-owned uniform objects.
 * Usage: engine.addMaterialHook(createEnvironmentMaterialHook(engine, extra))
 */
export function createEnvironmentMaterialHook(engine, extra) {
  let lightsChunk = null; // lights_fragment_begin (CSM-patched at runtime) with the cloud-shadow multiply
  const G = engine.globalUniforms;
  const stats = { seen: 0, patched: 0, fog: 0, sunMod: 0, sunModAnchors: 0 };
  hook.stats = stats;
  function hook(shader, material) {
    stats.seen++;
    if (material && material.userData && material.userData.noEnvHook) return;
    let vs = shader.vertexShader;
    if (typeof vs !== 'string' || vs.includes('vFcWorldPos')) return; // already patched (shared shader object)
    // --- vertex: world position varying ---
    if (vs.includes('#include <fog_vertex>')) vs = vs.replace('#include <fog_vertex>', '#include <fog_vertex>' + VERTEX_ASSIGN);
    else if (vs.includes('#include <worldpos_vertex>')) vs = vs.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + VERTEX_ASSIGN);
    else if (vs.includes('#include <project_vertex>')) vs = vs.replace('#include <project_vertex>', '#include <project_vertex>' + VERTEX_ASSIGN);
    else return; // unknown vertex layout: leave the material alone
    shader.vertexShader = VARYING + vs;
    stats.patched++;

    let fs = shader.fragmentShader;
    // another module may already declare uWetness (effects / buildings patch the same materials) — GLSL forbids the
    // redefinition, so only add ours when it is missing
    fs = FRAG_HEADER + (/uniform\s+float\s+uWetness\s*;/.test(fs) ? '' : WETNESS_DECL) + fs;
    // --- height fog ---
    if (fs.includes('#include <fog_fragment>')) { fs = fs.replace('#include <fog_fragment>', FOG_FRAGMENT); stats.fog++; }
    // --- cloud shadows on the direct light ---
    if (fs.includes('#include <lights_fragment_begin>')) {
      if (!lightsChunk) {
        let anchors = 0;
        lightsChunk = THREE.ShaderChunk.lights_fragment_begin.replace(DIR_LIGHT_INFO, (m) => { anchors++; return m + ' directLight.color *= fcSunMod;'; });
        stats.sunModAnchors = anchors;
      }
      fs = fs.replace('#include <lights_fragment_begin>', SUN_MOD_DECL + lightsChunk);
      stats.sunMod++;
    }
    shader.fragmentShader = fs;
    shader.uniforms.uSunModulation = G.uSunModulation;
    shader.uniforms.uSunModulationXf = G.uSunModulationXf;
    shader.uniforms.uFogHeight = G.uFogHeight;
    shader.uniforms.uWetness = G.uWetness;
    shader.uniforms.uFcFogParams = extra.uFcFogParams;
    shader.uniforms.uFcSunDir = extra.uFcSunDir;
    shader.uniforms.uFcFogWarm = extra.uFcFogWarm;
    shader.uniforms.uFcFogCool = extra.uFcFogCool;
  }
  return hook;
}
