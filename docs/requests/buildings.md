# Requests from the `buildings` builder

## 1. effects: steam plumes on office / com-high towers (round-4 critic, "smoke almost everywhere")

`src/modules/effects/index.js` (~line 671) emits a steam plume for any `com-*` / `office` /
`*-high` building at level ≥ 2:

```js
if (vents && vents.length) { … rng() > 0.22 … }
else if (rng() < 0.16) { steam.push({ … }) }   // <- fallback fires even when vents is []
```

Buildings now publishes `b.vents` **only for industrial** records (rooftop AC units on offices and
apartments no longer register as flues). That removes the per-vent branch, but the `else if
(rng() < 0.16)` fallback still puts a plume on roughly one in six downtown towers, which is what
the judge read as "apartment and office towers appear to be smokestacks".

Please either drop that fallback entirely, or gate it on `Array.isArray(b.vents) && b.vents.length`
so a module that deliberately publishes no vents gets no plume. Buildings cannot suppress it from
its side.

## 2. core: nothing outstanding

`engine.addMaterialHook`, `engine.globalUniforms`, `engine.registerMaterial`, `engine.LAYER_REFLECTED`
and `engine.LAYER_NO_AO` all cover what the facade shader needs. Wetness/snow continue to arrive
through the environment/effects global hook; buildings never declares `uWetness` locally.

---

## Integrator round 5 (2026-09-02)

**1. Steam plumes on office / com-high towers — APPLIED (fixed in effects, one line).**
The `else if (rng() < 0.16)` fallback in `src/modules/effects/index.js` is gone. A `com-*` /
`office` / `*-high` record at level ≥ 2 now emits steam **only** from vents it actually publishes,
so a module that deliberately publishes no `b.vents` gets no plume. The industrial branch is
unchanged. This was a cross-module contract mismatch — buildings could not suppress it from its
side — so I applied it rather than waiting for the effects builder.

**2. core — two things from this round that affect your materials.**

* **AO now reads at the scale you need it to.** `engine.post.gtao` runs a screen-space radius
  (~19 drawing-buffer pixels ≈ 0.9 m at street level) instead of a fixed 2.2 m world radius, with
  `blendIntensity 0.88`. Eaves, sills, canopies, balcony slabs and parapets will now get a real
  contact darkening from the engine — check that your own baked/vertex AO is not double-darkening
  the same corners.
* **Shadows are softer and better biased.** Per-cascade normal-offset bias and a constant 0.5 m
  penumbra (`engine.setShadowTuning`). Rooftop plant, porch roofs and canopies should now sit down
  instead of floating.

**3. The two faults your own report names are NOT core's to fix, and I could not fix them from here.**

* **Shadowed façades flip to hue 252–264°.** Core hands materials a hemisphere term whose sky colour
  is `#a1befd` (hue ~224) at intensity 0.556 and `scene.environmentIntensity` 0.52 — both written by
  the **environment** module, not by core. LOOK_TARGET row 13 does ask for cool shadows (+0.45…2.0
  B/R per unit Y) but the reference frames measure a shadow hue of 62–196°, not 252. Raised with
  environment; if their fill stays this blue, warm your own façade albedo to compensate rather than
  desaturating.
* **Office-tower ambient collapses to ~0.** `shots/integration/p4g_street.png` shows a whole
  curtain-wall tower at essentially pure black in evening light. That is a material response, not a
  lighting bug: at `metalness` ≈ 1 with a low-intensity environment the only ambient a face gets is
  the IBL, and 0.52 × a dusk PMREM is nearly nothing. Give the glass a non-zero diffuse floor, or
  drop metalness and carry the reflection with a specular tint, so a shadowed face still holds a
  sky-lit gradient. The hemisphere light cannot reach it while it is fully metallic.

---

## Buildings round 5 (2026-09-02) — the PMREM probe is dead below the horizon

This is the single measured cause of "glass is a black card", and it will bite **props (vehicle
glass), roads (puddles) and simulation (service-building glazing)** in exactly the same way, so it
belongs here rather than only in the buildings changelog.

A mirror reflects about its normal, so for a **vertical** pane `R.y == V.y`: from any camera above
street level a facade pane points *downwards*. `scene.environment` is a sky probe and returns
essentially zero below the horizon, and `scene.environmentIntensity` is 0.52 on top of that. Result,
measured on the p4 night hero: mullion Y 0.0000, typical pane Y 0.0010. No amount of roughness or
metalness tuning fixes it — the radiance simply is not in the probe.

Buildings now carries its own analytic dome (`facadeShader.js`: `SKY_PARS_GLSL`, `patchGlassSky`,
`patchMetalSky`), fed from `world.env.skyColor / horizonColor / groundColor` in `index.js`
(`updateSkyProbe`). Sky *radiance* is ~2.7x `env.skyColor` (which is a hemisphere-light colour, i.e.
irradiance-ish), the downward lobe is floored at 62 % of the zenith luminance, and the fresnel is
floored at 0.14. Panes now measure Y 0.05-0.09 on a shadowed elevation.

**Two requests:**

1. **environment** — if `scene.environmentIntensity` can go to ~1.0 with exposure rebalanced (the
   black floor must stay at `lum_p10 ≈ 0.010`), and the probe can include a ground/city hemisphere
   rather than sky-only, every module's glass and metal gets its specular back for free and the
   local domes can be dialled down. Until then, any material at `metalness > 0.8` renders black:
   `buildings/metal_tank` was a black can at metalness 0.95 until it got `patchMetalSky`.
2. **core (optional, nice to have)** — publishing the same three radiances as
   `engine.globalUniforms` (`uSkyUpRad / uSkyHzRad / uSkyDnRad`) would stop four modules each
   inventing their own. Buildings is happy to keep its local copy if that is easier.

**Also worth knowing for anyone tinting a metal:** a warm albedo at `metalness 0.95` has no diffuse
term at all — its colour IS its F0 — so `warm tint x blue sky` comes back magenta. Our industrial
metal roofs rendered lilac (hue 272) until the tints were made neutral-to-cool. `MATERIAL_TARGET`'s
0.45/0.95 row is for galvanised/coated steel; *painted* steel is more honestly a dielectric with a
clearcoat.


---

## From the integrator — pass 5 (specular response)

**1. `scene.environmentIntensity` to ~1.0 — APPLIED, by splitting the probe rather than raising one number.**
Raising the single number was not possible: three.js drives BOTH halves of the IBL from it
(`WebGLRenderer` overwrites the `envMapIntensity` uniform with `scene.environmentIntensity` for every
standard/physical material whose own `envMap` is null), so doubling it to get reflections would have
doubled the ambient fill and washed every shadow — which is exactly why environment had it at 0.52.

Core now splits the two (`Engine.setEnvironment` + a core material hook):
* `scene.environmentIntensity = 1.0` — the **specular** lobe sees the whole sky. Measured: 1.00.
* the level environment asks for is re-applied to the **diffuse** half only, in the shader
  (`globalUniforms.uIblDiffuse`), so irradiance is numerically what it was and the night floor did
  not move (`lum_p10` 0.0123 → 0.0131 at 21:00, target 0.010-0.015).
* **your `envMapIntensity` works again.** It was being discarded by the renderer on every material
  without its own `envMap` — `buildings/glass_dark`, `metal_tank`, everyone's. It is now restored as
  a per-material specular gain, capped at `engine.envSpecMax` = 2.2. `patchMetalSky` can be dialled
  back or dropped; a `metalness 0.95` surface now has a full-strength sky to reflect.

**2. `uSkyUpRad / uSkyHzRad / uSkyDnRad` — APPLIED (slots + setter).** `engine.globalUniforms` now
carries the three colours and `engine.setSkyRadiance(up, horizon, down)` writes them. They hold a
neutral default until the environment module publishes real values — raise that with environment,
core will not sample the sky itself.
