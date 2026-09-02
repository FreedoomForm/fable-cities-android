# props → core / other modules

Nothing here blocks the props module; everything below is either a finding other builders will hit or a
nice-to-have. props needs **no** change to core to work.

## Findings other modules should know about

- **Toggling `light.visible` recompiles every lit material.** props keeps a fixed pool of real
  `PointLight`s for the street lamps. The first implementation switched them off during the day with
  `light.visible = false`; three re-derives the lights state and every program's
  `NUM_POINT_LIGHTS`, so *all* registered materials recompiled on the dawn/dusk transition —
  1280×720 dropped from 60 fps to **9.5 fps** in the night showcase. The pool now stays in the scene
  from `init()` and idles at `intensity = 0`. Any module that wants dynamic lights should do the same
  (allocate up-front, never toggle `visible` or add/remove).
- **`engine.registerMaterial` + `alphaMap`.** `alphaMap` samples the *green* channel, not alpha; for
  canvas textures with a real alpha channel use `map` + `alphaTest` alone.
- **`world.buildings.list[].w/d` are the LOT dimensions, not the built footprint** (buildings/index.js
  sets `w: lot.w, d: lot.d`). props needs the real mass to keep hedges out of walls and to find a
  driveway; it currently approximates the footprint as a per-zone-type fraction of the lot
  (`FOOTPRINT` in PropScatter.js). See the request to buildings below.

## Requests to buildings

1. **Publish the real footprint** on the building record — `fw`, `fd` (and ideally `fx`, `fz` for the
   front setback, since houses are pushed toward the road). props, traffic (kerb cuts) and any future
   pathfinding all need the mass, not the plot. Today props guesses, so a house that happens to fill
   its plot can still get a hedge through a wall.

## Requests to roads

1. **Median trees.** `ROAD_TYPES.avenue.trees` are rendered by roads as noise-displaced icospheres
   (`makeTreeGeometry` in RoadMaterials.js). Next to the card-based street trees props now plants on
   the same avenue they read as flat plastic balloons and are the worst-looking thing in every props
   screenshot. Either (a) adopt the card approach, or (b) add `roads.api.setMedianTrees(false)` the way
   `setStreetLights` works, and props will plant them (the spec assigns avenue median trees to props).
2. **A parking lane on the local road.** `local` is 12 m with `cwHalf 3.8` and one lane centred at
   1.9 m each way, so there is no room for a parked car: props parks against the kerb at 2.7 m from the
   centreline and a passing vehicle can overlap it. A `parkingLat` on the type (or a 14 m
   "two-lane road with parking" variant) would fix it properly.
3. **`roads.api.lampsOf(segmentId) → [{x,y,z,kind}]`.** props re-derives the lamp head positions from
   `types.<id>.definition.lamps` + `seg.phase/trimA/trimB` to hang real PointLights and warm halos on
   them; a public accessor would make that exact and would survive a change to the lamp layout.
   Junction corner lamps are not re-derived today (only mid-block ones).
4. `sampleEdge` returning the tangent as well would save props reconstructing it from the normal.

## Requests to core (nice-to-have, not blocking)

1. **A shared light budget.** `engine.registerLight(light, priority)` (or just a documented cap per
   module) would stop several modules from each allocating their own PointLight pool and blowing the
   forward-lighting cost. props claims 12 at `quality=high` (14 at ultra, 6 medium, 2 low).
2. **`engine.quality.propDensity`** (or any per-module density multiplier in `QUALITY`) — props scales
   its caps and cull distances by `quality.density`, which is also the vegetation/particle knob, so a
   user who wants fewer trees also loses street furniture.

## Requests to terrain (nice-to-have)

- `terrain.api.groundTint(x, z)` (already requested by roads) would let props tint hedge/fence bases to
  the ground splat instead of using one green.

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

**To props, from the integrator:** `engine.quality.propDensity` now exists (0.4 / 0.7 / 1.0 / 1.4) — scale
street furniture with it instead of `density`. `engine.registerLight(light)` + `engine.quality.lightBudget`
give you the documented cap you asked for (32 at high); your 12-light pool is well inside it, and the
"allocate up front, never toggle `visible`" rule is now in ARCHITECTURE §3 so other modules follow it.
