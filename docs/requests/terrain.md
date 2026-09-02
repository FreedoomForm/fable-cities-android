# Core requests — terrain

## 1. Shadow-map acne on near-terminator terrain (diamond / cross-hatch moiré)
Distant mountain faces whose normal is close to perpendicular to the sun show a regular
diamond moiré (see `shots/terrain/p4b_terrain_mountain_16h2.png`, the dark faces of the central
peak). The pattern tracks the CSM texel grid, not the terrain mesh: it is classic
self-shadowing acne at grazing incidence. Terrain-side mitigations applied (smooth
heightmap-derived shading normals, anisotropy 16 on the normal map, detail-normal fade squared
with distance) reduce but do not remove it.
**Ask:** normal-offset depth bias (offset the shadow lookup along the surface normal by ~1.5 shadow
texels) on the far CSM cascades, or a `csm.setNormalBias(n)` knob terrain can raise for the far
cascade.

## 2. Impostor / billboard shadow casting
Tree impostors are single camera-facing quads, so in the shadow pass they either face the light
(casting a sliver) or cast a randomly-oriented card. Terrain currently works around this by pushing
the LOD1 (real geometry) range out to 720 m, which costs ~1.5 M triangles in a wide shot.
**Ask:** a way to give a mesh a different geometry/material in the shadow pass than in the main pass
(e.g. `object.shadowProxy = mesh`), so an impostor can cast from a cheap cross-quad.

## 3. Night lighting floor
At hour 21 (nautical twilight, moon below the horizon) the engine hands the terrain
`ambientIntensity 0.104` × sky `(0.052, 0.074, 0.13)`. Everything except the sky renders black.
Terrain now adds its own small sky-bounce term (`uNight`-gated) purely so the landform stays
readable; if environment raises the night floor, that term should be reduced in step.

---

## Integrator round 5 (2026-09-02)

**1. Shadow-map acne on near-terminator terrain — APPLIED.**
Shadow bias and PCF softness are now derived **per cascade** from that cascade's own texel footprint
instead of one global value (`Engine._applyCascadeShadow()`, re-run after every
`csm.updateFrustums()`):

* `shadow.normalBias = min(2.4, texelMetres × 1.9)` — the normal-offset term you asked for, ~1.9
  shadow texels along the surface normal. At `quality=high` that is now 0.09 m on cascade 0 and
  2.06 m on cascade 3, where before every cascade got a flat 0.03 m — far too little for a 1 m
  texel, which is exactly the diamond moiré on the distant peaks.
* `shadow.bias = -(0.04 + texelMetres × 0.55) / (far - near)` — a small *world* depth offset. The old
  flat `-0.00025` was ~0.75 m of world offset on every cascade, which is what detached shadows from
  kerbs and wheels in the near field.
* `shadow.radius = clamp(0.5 / texelMetres, 1.15, 4.2)` — a constant **0.5 m penumbra** rather than a
  constant texel count, so the soft edge is the same physical width in every cascade. Note that in
  r185 `PCFShadowMap` is the soft path (Vogel disk × hardware PCF, per-pixel IGN rotation);
  `PCFSoftShadowMap` is deprecated and silently falls back to one hard tap.
* The cascade split is now `mode: 'custom'` with a lambda of 0.74 instead of `practical`'s 0.5, so
  cascade 0 spans ~80 m at ~6 cm/texel instead of ~180 m at ~14 cm/texel.

Tunable at runtime: `engine.setShadowTuning({ penumbra, normalBiasTexels, depthBias, depthBiasPerTexel,
maxNormalBias, minRadius, maxRadius })`. If the far peaks still moiré, raise `normalBiasTexels` —
it is the term that matters — and tell me what value you needed.

**2. Impostor / billboard shadow casting — DECLINED (redirected, no core change needed).**
three r185 already gives you the hook: `Object3D.onBeforeShadow(renderer, object, camera,
shadowCamera, geometry, depthMaterial, group)` and `onAfterShadow(...)` fire around the shadow render
of that object only. Swap `mesh.geometry` to a cheap cross-quad in `onBeforeShadow` and restore it in
`onAfterShadow` — that is a per-module concern (only you know what the cross-quad should be) and core
will not own an impostor contract. Do NOT rely on `scene.overrideMaterial` for this: the GTAO
normal/depth pre-pass is a second full `renderer.render()`, and `WebGLShadowMap` picks its depth
material from `scene.overrideMaterial` when one is set. That was rebuilding all four cascades from
`MeshNormalMaterial` — no alphaTest, no alphaMap, no shadowSide — so alpha-cut foliage cast as solid
cards. Core now freezes `shadowMap.autoUpdate` for the duration of the pre-pass; that alone took the
demo city from 2659 → 1884 draw calls and 12.0 M → 8.0 M triangles.

**3. Night lighting floor — NOT CORE (redirected to environment).**
`hemi`, `scene.environmentIntensity` and exposure are all written by the environment module; core
only holds the defaults. Raised with environment in `docs/requests/environment.md`. Keep your
`uNight` sky-bounce term until they answer.

**Two things the integration frames say about terrain, neither of them core:**
* The lawn is the loudest surface in every street and city frame now
  (`shots/integration/p4_street_17h5.png`, foreground). LOOK_TARGET row 4 wants vegetation at
  Y 0.056; the demo-city ground cover still reads as one bright saturated green.
* The `aerial` preset measures `lum_p10` 0.122 against a 0.010 target and a ground shadow ratio of
  2.2 against 19.5 — at 1300 m the haze is washing the whole landform flat. Some of that is
  environment's aerial perspective, but the terrain macro albedo at that range contributes.


---

## Terrain round 5 (2026-09-02) — request #1 WITHDRAWN

**The diamond moiré on the dark mountain faces was ours, not a shadow-map problem.** Thank you for the
per-cascade bias work; it was not the cause and it was not needed here.

Evidence, on `shots/terrain/p5_mountain.png`'s predecessor at the same camera:

* `engine.setShadowTuning({ normalBiasTexels: 16, maxNormalBias: 60 })` — 8x the shipped value,
  far-cascade `shadow.normalBias` 0.09 → 3.03 m — left the pattern **pixel-identical**.
* `csm.lights.forEach(l => l.shadow.intensity = 0)` — shadows contributing nothing — also left it
  **pixel-identical**.

The real cause was in `TerrainMaterial.js`: the contour-bedding term is `fract(vTWorld.y * 0.30 + …)`,
i.e. a 3.3 m period keyed off the *interpolated* world Y. On the chunk-LOD mesh that value is
piecewise linear, so past a few hundred metres the contour lines kink at every triangle edge and the
period falls below the pixel footprint — a textbook diagonal beat. It was faded out over 900–2200 m;
it is now gone by 520 m at 0.10 amplitude, and the moiré is gone with it. Shaded mountain rock went
from **25.3% pure-black / visible lattice** to **0.00% below Y 0.002 and no lattice**.

No core change is wanted for this. Requests #2 (impostor shadow proxy) and #3 (night floor) are
unchanged — though #3 is now much less pressing: terrain's own `uNight` sky-bounce term was raised
3.5x this round and the night frame measures median Y 0.0445 with 6.9% of pixels under Y 0.01,
against CS2 `cs2_10`'s 0.057 / 7.7%. If environment ever raises the night hemisphere, tell us and we
will take our term back down in step.


---

## From the integrator — pass 5

**Water's `envMapIntensity` re-normalisation now behaves.** `Water.js` divides by
`scene.environmentIntensity` every frame to undo the dimmed probe; that division was doing nothing,
because the renderer *overwrites* the `envMapIntensity` uniform with `scene.environmentIntensity` on
any material without its own `envMap` — the material property was being discarded before it drew.
Core now honours it as a per-material specular gain (cap `engine.envSpecMax` = 2.2), and
`scene.environmentIntensity` is 1.0, so your expression settles at ~1.05 as intended. Re-measure the
water; it will be brighter than the frames you tuned against.

Nothing else needed from core. Requests #2 (impostor shadow proxy) and #3 (night floor) are
unchanged; #3 is environment's call and is flagged in `docs/requests/environment.md`.
