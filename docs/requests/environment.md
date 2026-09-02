# environment — notes to core and to other modules

## Round 3 (2026-09-02) — what changed and what it means for you

### world.env contract fixes (please re-read if you cached anything)

* **`world.env.skyColor` was black every daylight frame** and is now correct. The hemisphere colour was
  being written into a scratch `THREE.Color` that later frames of the same function reused for the cloud
  ambient, so by publish time it held `(0,0,0)`. If your module read `env.skyColor` and worked around a
  black value (e.g. by falling back to `env.horizonColor`), you can drop the workaround: it is now the
  hemisphere sky radiance, floored so it can never be black (contract §4).
* **`world.env.sunColor.r` was 0 whenever the sun was below the horizon** (the Beer-Lambert transmittance
  collapses and the normalisation divided by the max channel). It now holds a physical ~2200 K low-sun
  colour all the way through the ramp, so `sunColor` is always a usable tint even when `sunIntensity == 0`.

### To buildings — the `uWetness` redefinition is fixed on our side

`environment/MaterialHook.js` now only declares `uniform float uWetness;` when the fragment shader does not
already contain that declaration, so a material that declares it in its own `onBeforeCompile` (which runs
*before* the global hooks — see `Engine.registerMaterial`) no longer fails with
`ERROR: 0:222: 'uWetness' : redefinition`. You can keep your declaration; ours steps aside. The uniform
object bound is still `engine.globalUniforms.uWetness`, so one write reaches every material either way.

### To effects — sunset cloud banding

The reported horizontal stair-step banding at 18.5 h should be gone: the cloud march now runs at
`resolutionScale` 0.75 on `high` (1.0 on `ultra`) with a tighter Gaussian reconstruction kernel and a
lower temporal history weight (0.94), and the noise LOD/jitter path is unchanged otherwise. A row-profile
scan of the current 21:03 sky shows only smooth ±2 LSB/row cloud structure, no 1-px steps. If you still
see steps in a specific frame, send the exact URL + time and we will re-check.

Also fixed: a **dotted diagonal line across the night sky**, which was ours — `fwidth()` explodes across a
star cube-face seam, blowing the procedural star splat radius up so all nine neighbouring cells lit the
same pixel. It was visible with effects disabled too, so it was never your lens flare.

### To terrain / roads — night level

Night is now *darker and blue* rather than brighter and grey: the astronomical-night ambient key dropped
~12 % and the hemisphere ground term is cooled and desaturated at night, so a moonlit landscape lands
around sRGB 28-40 with `b > r` instead of a neutral 83. The dusk ramp is unchanged and still monotonic
(`ambientKey`: 1.02 noon → 1.80 golden hour → 0.46 at −8° → 0.30 at −22°). `env.moonDirection`,
`env.moonColor`, `env.moonIntensity` and `env.nightFactor` are unchanged. If a night frame now reads too
dark for you, say so with a screenshot rather than lifting it locally — the key belongs here.

### New, available to everyone

* **Directional aerial perspective.** The global material hook now tints scene fog per pixel: warm in the
  sun-facing hemisphere, cool blue away from it (`uFcFogWarm` / `uFcFogCool`, both 1,1,1 at midday and under
  a thick medium). Nothing to do on your side — it applies to every lit material through the existing
  `<fog_fragment>` patch.
* **Cloud shadows** are stronger and their cell scale now matches the volumetric layer
  (`CloudShadow.js` shares `uCloudBase/uCloudTop/uBaseScale` with `Clouds.js`).
  `world.env.api.cloudShadowAt(x, z)` returns exactly what the material hook samples.

### To core — nothing blocking

`engine.addMaterialHook`, `engine.setSunModulation`, `engine.setFogHeight` and `engine.globalUniforms`
cover everything this module needs. Two small conveniences, neither urgent:

1. A documented ordering guarantee for material hooks (environment must patch `lights_fragment_begin`
   after any module that replaces the chunk wholesale). Today it works because hooks run after the
   material's own `onBeforeCompile`; a note in ARCHITECTURE.md §3 would make it contractual.
2. Per-pass draw-call/triangle stats (`__game.stats()` accumulates all passes), so the cloud pass's cost
   can be reported separately from the main pass.

---
## Integrator round 4 (2026-09-02)

**APPLIED (core, all backwards compatible):**
* `engine.post.sceneDepth()` — the composer's `readBuffer.depthTexture`, i.e. the depth the RenderPass
  actually wrote this frame. `post.depthTexture` is kept but documented as renderTarget1's attachment only.
  Also `post.insertAfterRender(pass)`, `post.addPass(pass, index)`, `post.removePass(pass)`, `post.render`.
* `addMaterialHook` now really recompiles: `_recompileRegistered()` bumps `engine._hookVersion`, and every
  registered material's `customProgramCacheKey` carries `|h<version>` (a material's own cache key is wrapped,
  not replaced). Modules no longer have to bump the keys themselves.
* Material-hook **ordering is now contractual** (ARCHITECTURE §3): material's own `onBeforeCompile` → CSM →
  global hooks in registration order. A hook must feature-detect before declaring a uniform.
* GTAO pre-pass: core sets `material.allowOverride = false` on any mesh whose geometry has no `normal`
  attribute, so a normal-less mesh can no longer blacken the AO buffer under it.
* `engine.registerLight(light, priority)` + `engine.quality.lightBudget` (8/16/32/48) — a shared, documented
  light budget with a one-shot warning. Nothing is culled for you.
* `engine.quality.propDensity` (0.4/0.7/1.0/1.4) — street furniture scales independently of `density`.
* `input.claimKey(key)` / `releaseKey` / `isClaimed` — a tool can take `R` (or any key) and `CameraController`
  skips it; a claim holds until the frame after the last call, so it survives the camera update at the top of
  the next frame. `input.isHeld` / `justPressedRaw` read the raw state inside the claiming module. Camera tilt
  also answers to `T` / `G` now, so `R` / `F` can be claimed without losing tilt.
* `input.injectClick(ndc, button)` — dispatches real pointer events on the canvas for automation, and the drag
  record carries `target` / `overUIAtDown` / `synthetic`.
* `events.mute(name|names) → unmute()` — drop an event during scripted world-building (the demo city).
* `World.time` seeds `minute/weekday/totalDays`; `World.economy` seeds `employed/unemployment/net/period:'week'`;
  `World.services` seeds `list: []`, `version: 0`. `__game.stats()` now reports `money` and `happiness`.

**DECLINED / not applied:**
* `world.economy.api.spend/refund` — the economy is the simulation module's; core will not own a budget ledger.
  Ask simulation for `economy.api` in `docs/requests/simulation.md` (tools' direct `money -=` still works).
* Unified `world.surfaceHeight(x, z)` — still declined; use `max(terrain.getHeight, roads.api.surfaceHeight)`.
* Per-pass draw-call/triangle stats — `renderer.info` is per-frame; splitting it needs a wrapper around every
  pass. Not worth the risk this round.
* A real outline pass in core — `post.addPass` now lets the tools module add its own.
* A shared alpha-coverage shader chunk for mip-faded alphaTest — leave it in the modules until a second module
  actually needs it; core will not own a foliage shader.
* `conformDisc(..., { gx, gz })` plane variant / `conformPolygon` — terrain's API, not core's.

**To environment, from the integrator:** both conveniences are answered. (1) Material-hook ordering is now
contractual in ARCHITECTURE §3 — material's own `onBeforeCompile` → CSM → global hooks in registration order,
and a hook must feature-detect before declaring a uniform (your `uWetness` guard is the reference case).
(2) Per-pass stats are **declined** again: `renderer.info` is per-frame and splitting it would need a wrapper
around every pass; judge the cloud pass by toggling it instead. Verified live: the demo city and all 12
showcases render with zero console errors and `world.env.skyColor` / `sunColor` are non-degenerate at 13:00
and 21:00.

---

## Round 4 (environment) — one arbitration request

**`engine.globalUniforms.uWetness` has two writers each frame, and the loser is the one with the truth.**
`environment/index.js` writes it from `world.env.wetness` (which snaps instantly on
`env.api.setWeather(w, { instant: true })`); `effects/WetSurfaces.js:384` then writes its own smoothed
value from a later `update()`, so the last writer wins. Observable symptom (r3 open issue, still open and
NOT fixable inside environment): after an instant jump from snow/rain to `clear`, `uWetness` stays around
0.74 for 45+ frames while `world.env.rain` is already 0, so any screenshot taken right after a weather jump
shows soaked ground under a clear sky.

Request: make the ownership explicit in ARCHITECTURE §3 — either (a) environment owns `uWetness` and effects
reads it, or (b) effects owns it and environment stops writing. Either is fine; two owners is not. If (b),
please also say that the owner must snap on `weather:set` with `instant`. No code change needed in core
beyond the one-line contract statement.

*(Not a request, for the record: `tools/check.mjs` on the demo city reports 2659 draw calls / 12.0 M
triangles against the §3 budget of 2500 / 8 M. Nothing in this round's environment changes adds geometry —
the environment showcase itself renders at 1635-2063 calls and 4.3-5.0 M triangles — but somebody should own
the demo-city overage.)*

---

## Integrator round 5 (2026-09-02) — from the integrator, three lighting asks

Core did its half of judge defect 2 (flat lighting) this round: per-cascade shadow bias / normal bias
/ softness, a 0.74-lambda cascade split, a screen-space GTAO radius with a distance fade, and the
removal of the black slabs that GTAO's buffer swap was painting on the ground. The measured global
numbers are now on target — at `city` / seed 7 / 17:33: `lum_p10` 0.008 (target 0.010), ground shadow
ratio 21.4 (target 19.5), far÷near haze 2.12 (target 2.15). **The remaining lighting faults are all
on values environment writes, and core deliberately does not override them.**

**1. Sky fill is too blue, and the reference is not.** At 17.5 you hand core
`hemi.color #a1befd` (hue ~224) at intensity 0.556 with `environmentIntensity` 0.52. The result is a
shadow hue of 210° and — worse — a **lit** hue of 230° in the `city` frame, where the four CS2
daytime beauty frames measure a lit hue of **34–58°** and a shadow hue of **62–196°**. LOOK_TARGET
row 13 asks for a warm key and a cool fill; we have a cool key *and* a cool fill. Please warm the
directional light further (hue ~40°) and/or pull the hemisphere sky colour back off full blue —
the split should come from the *contrast* between the two, not from making everything blue.

**2. The aerial frame is washed flat by haze.** `shots/integration/p4_aerial_17h5.png` (distance
1320 m) measures `lum_p10` **0.122** against a 0.010 target and a ground shadow ratio of **2.21**
against 19.5, with vegetation at Y 0.177 against 0.056. The near/mid frames are on target, so this is
purely the far end of the aerial-perspective curve: it is lifting blacks far too hard past ~800 m.
LOOK_TARGET rows 11/12 want far÷near luminance 2.15 and far contrast 35–52% of near — not a uniform
grey wash.

**3. Night ambient floor.** Terrain reports that at hour 21 it receives `ambientIntensity 0.104` ×
sky `(0.052, 0.074, 0.13)` and has had to add its own `uNight` sky-bounce term purely to keep the
landform readable (`docs/requests/terrain.md` #3). The night city frames themselves look good
(`shots/integration/p4_city_21.png`, `p4_aerial_21.png`), so this is about unlit landform, not about
the city. Please either raise the night floor a little or tell terrain to keep its term permanently.

**Also, still open from demo:** the hard-edged straight cloud-shadow boundary at `?seed=7&time=13`,
`suburb` preset (`docs/requests/demo.md`). The `uSunModulation` projection looks like it is being
sampled past its edge rather than fading out.

**No core change requested of you.** `engine.setSun / setHemisphere / setFog / setEnvironment /
setExposure` are unchanged. New this round, in case they are useful:
`engine.setShadowTuning({ penumbra, normalBiasTexels, … })` and `engine.aoFade` (a Vector2 of view
depth in metres over which GTAO fades to 1).


---

## From the integrator — pass 5 (please read, your contract changed)

`engine.setEnvironment(texture, intensity)` no longer writes `intensity` straight into
`scene.environmentIntensity`. **`intensity` is now the DIFFUSE fill level only.** Core binds the
probe at full strength for the specular lobe (`scene.environmentIntensity = max(1, intensity)`) and
re-applies your number to the diffuse half in the shader (`globalUniforms.uIblDiffuse`).

Why: three.js drives both halves of the IBL off that one number, so your 0.40-0.52 — chosen, rightly,
to stop the probe becoming a second ambient light — also halved every reflection in the game. That
was the single measured cause of "no specular response anywhere in the frame" in the blind
comparisons. Diffuse irradiance is unchanged to the last bit; the night floor measures `lum_p10`
0.0131 at 21:00 (target 0.010-0.015) against 0.0123 before the change.

**So: keep tuning `S.envIntensity` for shadow depth exactly as you were. It no longer costs
reflections.** If you want the specular sky dimmer (overcast, storm), set `engine.envSpecularBase`;
if you want the diffuse half trimmed without touching the specular, `engine.envDiffuseTrim`.

Two follow-ups that are yours, not core's:
* **`engine.setSkyRadiance(up, horizon, down)`** now exists and publishes `uSkyUpRad / uSkyHzRad /
  uSkyDnRad` to every lit material. Buildings, roads, terrain and effects each maintain their own
  three-sample sky approximation; please write these once per probe refresh so they can stop.
* **`env.sunElevation`** (radians, negative below the horizon) — traffic asks for it in
  `docs/requests/traffic.md` #6 so headlight timing stops depending on `nightFactor`'s meaning.
* The night ambient floor (#3, from terrain) and the hard-edged cloud-shadow boundary at
  `?seed=7&time=13` are still open and still yours.
