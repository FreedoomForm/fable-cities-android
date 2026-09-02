# Requests from **traffic**

Traffic reads `roads.api.laneGraph()`, `world.economy`, `world.time` and `world.env`; it writes
`world.traffic.{api, vehicles, pedestrians, congestion, list}` and `segment.traffic` (0..1) once per
`sim:tick`. Nothing in core blocks the module today — the notes below are requests to other modules.

## roads
1. **Lane connections at junctions** — `laneGraph().connections` currently links lane ends to lane
   starts, which traffic turns into Bézier connectors. Please keep giving *every* legal outgoing lane
   (including both lanes of a 4-lane avenue), otherwise outer lanes silently become dead ends and the
   fleet bunches into the inner lane.
2. **`lane.rank` / `lane.type`** — traffic infers road rank via `api.getSegment(id).type` (falls back
   to `local`). A `type` field directly on the lane record would remove the per-lane lookup.
3. **Stop-line offset** — traffic stops 0.7 m before the end of the approach lane. If the road module
   ever exposes the real stop-line position (`api.stopLine(segmentId, nodeId)`), queues will line up
   exactly with the painted line.
4. **Signal state** — traffic owns the phase cycle (`node.signalized`, green/amber/red). If the roads
   module wants the physical signal heads to match the phase, read
   `modules.traffic` → `world.traffic.api.stats().signals` is only a count today; ask and traffic will
   publish a per-node `{ nodeId, approachKey, state }` list.

## props
5. **Sidewalk furniture collides with the traffic showcase presets.** In runs on 2026-09-02 several
   street props (bus-shelter roofs / awnings) rendered as very large flat slabs and one long white
   beam lying along the kerb, visible in `shots/traffic/dbg2.png` (taken with
   `world.traffic.api.setEnabled(false)`, so it is not vehicle geometry). Worth a look.

## core (no changes needed)
`engine.registerMaterial`, `engine.LAYER_NO_AO` and `engine.quality` cover everything traffic needs.

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

**To traffic, from the integrator:** nothing needed from core, as you said. The demo city runs
`setDensity(1.25)` + `spawnBurst(220)` on a 119-segment network: 620 vehicles and 387 pedestrians, all on
their lanes in the `street` / `closeup` frames at `?seed=7`, no errors. `world.traffic.vehicles` is a count
in the demo; audio consumes `api.getVehicles()` successfully.

## core (DebugAPI) — from traffic, pass 4

5. **Camera presets should carry a default time.** `__game.setCamera(name)` reads only
   `{ target, distance, yaw, pitch }`. Beauty presets need a default sun: traffic now stores
   `time: 16.2` on `traffic_hero` / `traffic_detail` and `time: 21.2` on `traffic_night`, but nothing
   in core applies it, so anyone who runs `--preset traffic_hero` without `--time` still gets
   whatever hour the world happens to be at. Please make `setCamera` call `setTime(view.time)` when
   the preset defines one.
6. **Publish `env.sunElevation`.** Traffic decides when headlights come on. It now derives that from
   `env.sunDirection.y`, `world.time.hour` *and* `env.nightFactor` together, because `nightFactor`
   alone changed meaning mid-round and left the whole fleet dark at 21:00. A stable
   `env.sunElevation` (radians, negative below the horizon) owned by environment would let every
   module agree on when it is night.

## core / environment — from traffic, pass 5 (specular response)

7. **`scene.environmentIntensity` is 0.52 and it is the single biggest specular blocker.**
   `MATERIAL_TARGET.md` calls for `envMapIntensity` 1.0 on vehicle paint and glass, but the probe
   itself is dialled to half strength, so a windscreen at roughness 0.06 reflects a sky that is
   half as bright as the sky the same frame renders. Traffic works around it by scaling `radiance`
   in its own fragment shader by `uEnvComp = clamp(1 / scene.environmentIntensity, 1, 2.2)`, read
   from the scene every frame. **That factor collapses to 1.0 by itself the moment environment
   raises the probe to 1.0 — no traffic change is needed then.** Please raise it and rebalance
   exposure/hemisphere, per MATERIAL_TARGET "Scene-level".

8. **Cascade `normalBias` erases the shadow of anything car-sized past ~80 m.** With
   `shadowDistance: 1400` over 4 cascades at 2048, cascade 2/3 texels are 0.2-0.7 m and the
   ~1.9-texel normal bias offsets the receiver sample by more than a car's ground clearance, so a
   correctly-registered caster still throws no visible shadow. Traffic now casts from a padded
   24-triangle proxy (fattened 6% and raised 12% specifically to survive that erosion) — a hack that
   would be unnecessary with a shorter `shadowDistance` or a per-cascade normalBias cap in metres.
   Poles and trees survive it because they are tall; vehicles and street furniture do not.

9. **`Object3D.onBeforeShadow` cannot swap a cheap shadow caster in r185.** ARCHITECTURE.md line 43
   recommends swapping `geometry` in `onBeforeShadow` and restoring it in `onAfterShadow`. In
   r185 `WebGLShadowMap.renderObject` captures `const geometry = objects.update(object)` *before*
   calling `onBeforeShadow` and passes that local to `renderBufferDirect`, so the swap has no
   effect (three.module.js:9568-9600). Traffic instead uses a separate shadow-only `InstancedMesh`
   sharing the body's `instanceMatrix` with `colorWrite:false, depthWrite:false`. Please correct
   ARCHITECTURE.md line 43 so the next module does not lose an hour to it.


---

## From the integrator — pass 5

**5. Camera presets carry a default time — APPLIED.** `__game.setCamera(name)` now calls
`setTime(view.time)` when the preset defines one. `--time` still wins (shot.mjs sets the hour after
the camera), so `--preset traffic_hero` alone lands on 16.2 and `--preset traffic_hero --time 21`
still gives you 21.

**6. `env.sunElevation` — NOT CORE.** `world.env` is written by the environment module; asked there.

**7. `scene.environmentIntensity` 0.52 — APPLIED.** It measures 1.00 now, and the diffuse half is
held at the old level in the shader so shadows did not wash out (see docs/requests/buildings.md for
the mechanism). **Your `uEnvComp` now evaluates to 1.0 by itself, as you predicted — you can delete
it.** More importantly: the renderer was *discarding* `material.envMapIntensity` on every material
without its own `envMap`, so `props/car_glass` at 1.8 was really drawing at 0.52. That value is now
honoured as a per-material specular gain (cap `engine.envSpecMax` = 2.2).

**8. Cascade `normalBias` erases car-sized shadows — APPLIED.** `shadowTuning.maxNormalBias` was a
2.4 m cap, i.e. no cap at all: it never bound, so cascades 2/3 were offsetting the receiver sample
by up to 1.3 m. It is now **0.9 m**. Cascades 0/1 are unchanged (0.11 / 0.38 m); the far cascades are
clamped. Re-check whether the padded 24-triangle proxy is still needed; if you drop it, do it behind
a screenshot at 17.5 and 21.

**9. `onBeforeShadow` cannot swap geometry in r185 — APPLIED to ARCHITECTURE.md §3.** The line now
says so and points at the shadow-only-mesh pattern you used.
