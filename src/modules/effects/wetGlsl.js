/**
 * GLSL shared by the wet-surface material hook (fragment) and the splash system (vertex): the SAME
 * puddle mask must be evaluated in both so impact rings only appear where the ground actually has a
 * puddle. Pure functions, no uniforms.
 */
export const FX_NOISE_GLSL = /* glsl */ `
vec2 fxHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float fxHash1(vec2 p) { return fxHash2(p).x; }
float fxValueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fxHash1(i), b = fxHash1(i + vec2(1.0, 0.0)), c = fxHash1(i + vec2(0.0, 1.0)), d = fxHash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/**
 * Puddle height field on the ground plane (0..1). ONE low-frequency field (two large, smooth octaves,
 * nothing under ~5 m): pools are clean mirrors with soft shores, never speckle. Pools are the high values.
 */
float fxPuddleField(vec2 xz) {
  return fxValueNoise(xz * 0.085) * 0.68 + fxValueNoise(xz * 0.21 + 17.3) * 0.32;
}
/**
 * Puddle mask for a wetness level: 0 dry … 1 inside the pool (≈ 20 % of a flat surface when soaked).
 * rim returns the damp shore band just outside the pool (0..1). Pools shrink as the ground dries.
 */
float fxPuddleMask(vec2 xz, float wet, out float rim) {
  float pn = fxPuddleField(xz);
  float thr = 0.655 - 0.075 * wet;
  float fill = smoothstep(0.10, 0.55, wet);
  rim = smoothstep(thr - 0.10, thr, pn) * fill;
  return smoothstep(thr - 0.004, thr + 0.03, pn) * fill;
}
`;
