# Core requests — effects

## 1. `EffectComposer`'s two targets own SEPARATE depth attachments (blocker for any depth-aware pass)

`composer.renderTarget2 = renderTarget.clone()`, and `WebGLRenderTarget.copy()` does
`this.depthTexture = source.depthTexture.clone()` — so `renderTarget1.depthTexture !== renderTarget2.depthTexture`.

Consequence: `post.sceneDepth()` (= `composer.readBuffer.depthTexture`) is the real scene depth **only until
the first pass that swaps**. A second depth-aware pass after it either reads a stale attachment or — if it is
handed the correct one — samples the depth attachment of the framebuffer it is drawing into, which is a GL
feedback loop (`GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active Texture`, silently
undefined results). We hit this when we inserted a screen-space ground pass ahead of the existing particle
pass and had to merge the two passes into one to get correct results.

**Request:** either (a) share ONE depth texture between `renderTarget1` and `renderTarget2` (the RenderPass is
the only writer, so a shared attachment is safe and is what most engines do), or (b) expose
`engine.post.sceneDepthTexture` — a depth attachment the engine resolves/blits once after the RenderPass and
guarantees valid for every later pass regardless of buffer parity. (b) also lets more than one module own a
depth-aware pass without them having to know about each other.

## 2. `engine.post.gtao` radius is a massing term only

`GTAOPass` runs at `radius: 2.2` m. Nothing in the stack occludes at the 0.3-0.6 m scale where an object meets
the ground, which is the "objects look pasted on" note every blind judge made. effects now ships its own 8-tap
fine-radius AO inside its ground pass. If core would rather own that, a second short-radius AO term (or a
`radius` pair) on the GTAO pass would remove the duplication.

---

## Integrator round 5 (2026-09-02)

**1. Separate depth attachments — APPLIED, and the real symptom was worse than the ergonomics.**
Two fixes:

* **`engine.post.sceneDepthTexture()`** — a resolved R32F copy of this frame's scene depth
  (`.x` holds the same non-linear depth value the attachment does, so `texture2D(t, uv).x` is a
  drop-in for the DepthTexture). It is correct in EVERY pass regardless of buffer parity and is
  never the render target of another pass, so sampling it can never form a feedback loop. Two
  modules can now each own a depth-aware pass. The resolve pass is created lazily on first call —
  it costs nothing until someone asks for it. `post.sceneDepth()` is unchanged.
* **GTAO no longer swaps.** The engine composites the AO in place onto the pass' read buffer
  (`gtaoPass.output = OUTPUT.Off`, `needsSwap = false`, engine-owned blend quad). That was not a
  tidiness change: with GTAO swapping, the frame's swap parity flipped and a downstream depth-aware
  pass read an attachment nobody had written, which is what painted **hard black slabs across the
  ground in every aerial frame** (`shots/integration/base_aerial_17h5.png` vs `p4_aerial_17h5.png`,
  slab pixel fraction 0.0247 → 0.000). It also removes one fullscreen blit per frame.

Option (a) from your write-up — one shared depth texture for both composer buffers — was tried and
**does not work in r185**: `WebGLTextures.deallocateRenderTarget()` disposes `renderTarget.depthTexture`,
so the first `composer.setSize()` destroys the attachment the other buffer still references and the
frame goes blank. Do not retry it.

**2. GTAO radius is a massing term only — APPLIED, in the opposite direction to the one you expected.**
The pass now runs a **screen-space** radius (`screenSpaceRadius: true`, `radius 0.19` ×
`SCREEN_SPACE_RADIUS_SCALE 100` ≈ 19 drawing-buffer pixels), `distanceExponent 1.5`, `thickness 2.6`,
`scale 1.15`, `blendIntensity 0.88`. A fixed world radius was the bug: at street level 2.2 m was far
too coarse for a kerb, and at aerial range it was below one pixel, so every sample landed inside the
depth buffer's own quantisation. A pixel radius is scale invariant — ~0.9 m of tight contact
occlusion at 60 m, tens of metres of massing from the air. Verified visibly, not by parameter:
`shots/integration/ao_on.png` vs `ao_off.png` at the `closeup` preset show firm darkening under the
truck body, the bench, the tree bases and along the kerb line.

There is also an **AO distance fade** (`engine.aoFade`, default 400 → 1200 m of view depth). With
camera near 1 / far 15000 the 24-bit depth buffer quantises to whole metres past ~1 km, so anything
GTAO reports out there is invented. Your own fine-radius AO inside the ground pass is still welcome
for the sub-0.5 m scale; core will not chase that with a second GTAO instance.

**Two notes back to effects:**
* `EffectsPass.render()` still reads `readBuffer.depthTexture` directly. That is correct today
  (the pass sits immediately after the RenderPass, before any swap) and I have not touched it — but
  if the pass ever moves later in the chain, switch to `engine.post.sceneDepthTexture()`.
* The sun glare is very strong looking down a street into a low sun
  (`shots/integration/p4f_closeup_17h5.png` at 17:33 is blown out across the middle third). Worth a
  cap that scales with `1 - nightFactor` and with how close the sun is to the horizon.
* The steam-plume fallback on `com-*` / `office` / `*-high` at level ≥ 2 (`rng() < 0.16`, index.js
  ~line 761) has been **removed** — see `docs/requests/buildings.md` #1. Buildings publishes
  `b.vents` for industrial records only, deliberately, and the fallback was putting a plume on one
  in six downtown towers.

---

## Pass 5 (effects) — two asks, one core, one environment

### 1. `scene.environmentIntensity` is 0.52 and it caps every specular lobe in the game
`docs/MATERIAL_TARGET.md` names this explicitly: "Glass and paint cannot reflect a sky that is
dimmed by half. Raise it towards 1.0 and rebalance exposure and the hemisphere term to keep the
black floor at its target." It is written by the **environment** module (`engine.setEnvironment`),
so effects cannot change it.

Measured today (`node tools/matstats.mjs`): `environmentIntensity 0.5187`, `exposure 1.60`,
`hemisphereIntensity 0.553`, `sunIntensity 2.99`.

Effects has had to compensate locally for it in two places, and both are hacks that should be
deleted the day the probe is at full strength:
* `PuddleField.js` — the water material carries `envMapIntensity: 1.9` so that 1.9 × 0.52 ≈ 1.0.
* `WetSurfaces.js` `INJECT_RADIANCE` — wet upward faces get `indirectSpecular *= 1.40` plus a small
  Fresnel sky term, because a 0.20-roughness dielectric returning half the sky reads matte.

If environment raises the intensity, ping effects and both compensations come out. Grading is
already anchored on a GPU luminance meter, so the exposure rebalance will be absorbed automatically;
`lum_p10` is currently measuring 0.0071-0.0179 across the effects presets against the 0.007-0.017
LOOK_TARGET band, so there is no headroom to give away.

### 2. `USE_UV` does not exist in three r185 — worth a line in ARCHITECTURE.md §3
`WebGLProgram` only ever defines `USE_UV1` / `USE_UV2` / `USE_UV3`; `USE_UV` itself is defined
nowhere in `node_modules/three/src`, so `varying vec2 vUv` is never declared for a standard material
and **any `#ifdef USE_UV` block in a material hook is dead code that compiles silently**. Two
features in this module (the road-space puddle field and the snow tyre tracks) sat inside such a
block for two review rounds and never ran once — which is why round 4's headline deliverable was
"absent from every frame". Both now sample a world-space drainage map instead.

A one-line warning in the "Global material hooks" paragraph of §3 would stop the next module walking
into it. A module that genuinely needs UVs in a hook must set `material.defines.USE_UV = ''` itself
(defines are part of the program cache key, so that is safe) and must not assume another module's UV
units.

### Noted, not ours
* `traffic/pedestrian` fails to link with `Program Info Log: Too many attributes (aState)` on every
  load of the effects showcase. Pre-existing, reproduced with the effects hook removed.


---

## From the integrator — pass 5

**A standard material has no `vUv` — APPLIED to ARCHITECTURE.md §3.** The "Global material hooks"
paragraph now warns that `USE_UV` is never defined for a plain `MeshStandardMaterial`, that an
`#ifdef USE_UV` block in a hook is dead code which compiles silently, and that a module needing UVs
must set `material.defines.USE_UV = ''` itself.

### Measured regression you now own: wet surfaces are double-compensated

`?seed=7&weather=rain`, `closeup`, 17:30, same frame with the old probe binding and the new one
(160x90 px of carriageway, x 700-860 / y 340-430):

| surface | old binding | new binding | change |
|:--|--:|--:|--:|
| wet carriageway | Ymean 0.134, peak/mean 6.34 | Ymean **0.228**, peak/mean **3.82** | +69 % |
| wet sidewalk | Ymean 0.095, peak/mean 8.87 | Ymean **0.164**, peak/mean 5.25 | +72 % |
| dry vertical facade | Ymean 0.177 | Ymean 0.214 | +21 % |
| glass tower | Ymean 0.326 | Ymean 0.345 | +6 % |

+21 % on an ordinary surface is the physical restoration and is meant to stay. The +70 % is confined
to `fxFlat`-weighted upward faces, i.e. it is `WetSurfaces.js`' own compensation being applied on top
of a probe that no longer needs compensating — `reflectedLight.indirectSpecular *= 1.0 + 0.40 *
fxWetSheen;` and `+= uFxSky * Fw * fxWetSheen * 0.045;` (lines ~266-272), both written against
"scene.environmentIntensity is 0.52 so restore the missing half". **Please delete or re-derive them
from `scene.environmentIntensity` so they collapse by themselves, the way traffic's `uEnvComp` does.**
Right now the rain frame reads as a uniform pale blue-grey sheet (peak/mean fell 6.34 → 3.82) which
is the *opposite* of wet: a wet road should get DARKER (albedo x 0.55, per MATERIAL_TARGET) and gain
contrast, not brighten and flatten. Your own night-rain figure of peak/mean 23.28 is the right shape.

**Also, for the wet-road work:** the probe is no longer at half strength. `scene.environmentIntensity`
is 1.0 for the specular lobe, and `material.envMapIntensity` — which the renderer used to discard on
every material without its own `envMap` — is honoured again as a per-material specular gain (cap
2.2). So `PuddleField`'s 1.9 and the `WetSurfaces` compensation terms are now doing what their
comments claim, and the two "scene.environmentIntensity is 0.52" comments are stale. Please re-measure
your rain frames before adding any more compensation on top: a 0.20-roughness wet road is now
reflecting a whole sky, and the sheen terms stack on that.

**GTAO was re-tuned** (radius 19 → 17 screen px, `thickness` 2.6 → 1.6 m, `scale` 1.15 → 1.65,
`blendIntensity` 0.88 → 1.0, denoiser radius 3 → 2) for firmer contact darkening under kerbs, wheels
and eaves. Nothing in the pass API changed.
