/**
 * Wet-look helper for any module's MeshStandardMaterial / MeshPhysicalMaterial.
 *
 *   import { applyWetness } from '../../shared/wetness.js';
 *   applyWetness(material);                 // before engine.registerMaterial(material)
 *
 * The effects module drives the shared `WETNESS.value` (0 dry … 1 soaked) every frame from
 * world.env.rain (with a slow dry-out after rain stops). Patched materials get darker albedo and
 * lower roughness, weighted towards upward-facing surfaces (where water pools), which gives the
 * CS2-style wet asphalt / roof sheen under rain. `WETNESS_SNOW.value` is exposed for modules that
 * want to brighten upward-facing surfaces in snow.
 *
 * The patch is a plain onBeforeCompile hook and composes with `engine.registerMaterial` (CSM),
 * which preserves earlier onBeforeCompile hooks.
 */
export const WETNESS = { value: 0 };
export const WETNESS_SNOW = { value: 0 };

const PARS = /* glsl */ `
uniform float uWetness;
uniform float uSnowCover;
`;

const ROUGHNESS_INJECT = /* glsl */ `
#include <roughnessmap_fragment>
{
  vec3 wUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  float upness = clamp(dot(normalize(vNormal), wUp), 0.0, 1.0);
  float wetW = uWetness * (0.45 + 0.55 * upness);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, wetW);
  diffuseColor.rgb *= 1.0 - 0.45 * wetW;
  float snowW = uSnowCover * smoothstep(0.55, 0.95, upness);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.87, 0.9), snowW);
  roughnessFactor = mix(roughnessFactor, 0.85, snowW);
}
`;

/**
 * Patch a lit material for wet/snow response. Safe to call once per material; returns the material.
 * @param {import('three').Material} material
 * @param {{ strength?: number }} [opts]
 */
export function applyWetness(material, opts = {}) {
  if (!material || material.userData.__wetness) return material;
  material.userData.__wetness = true;
  const strength = opts.strength ?? 1;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    shader.uniforms.uWetness = strength === 1 ? WETNESS : { get value() { return WETNESS.value * strength; } };
    shader.uniforms.uSnowCover = WETNESS_SNOW;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_INJECT);
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + '|wet' + strength;
  };
  material.needsUpdate = true;
  return material;
}
