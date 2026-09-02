# Requests from the roads module

## Core (src/core) — none required so far
The roads module fulfils its contract with the current core. Two nice-to-haves:

1. **`engine.registerMaterial` cache key** — the engine overrides `customProgramCacheKey` only when it is
   the prototype default. Roads sets its own key (`roads-asphalt-v1`) before registering, so no change is
   needed; documenting that this is the supported way to keep custom `onBeforeCompile` programs distinct
   would help other builders.
2. **Vite HMR full reloads** while another builder saves a file abort running `tools/shot.mjs` sessions
   ("Execution context was destroyed"). A `--retry` in shot.mjs (or `server.hmr.overlay=false` + retrying
   `waitForFunction` once after a navigation) would make verification less flaky on the shared server.

## Terrain module (cross-module, not core) — a corridor conform API
Roads deform the terrain to the road profile (Cities: Skylines behaviour) through
`world.terrain.api.flattenRect(x0, z0, x1, z1, y, falloff)`. Because that API is an axis-aligned
rectangle with a single height, a sloped or curved road needs many small rectangles (≈ 1 per 4–48 m of
road, thousands for a city) and each call pushes one region into the terrain's dirty queue, which is
drained at 6 regions per frame. On bulk builds (showcase, demo city) the terrain lags several seconds
behind the roads, and the rectangle union stair-steps along diagonal roads.

Proposed addition (what + why):

```js
/**
 * Conform the terrain to a road corridor. `points` are dense centreline samples with the final road bed
 * height in `y`; `width` is the full corridor width; `falloff` metres of smooth blend outside it.
 * Interpolates heights along the polyline (no terraces), touches every affected chunk once, and clears
 * vegetation in the corridor. Returns nothing; the terrain batches the chunk rebuild itself.
 */
terrain.api.conformPath(points /* [{x,y,z}] */, width, falloff = 6)
```

Roads would call it once per segment with `segment.points` (already provided in the contract) instead of
dozens of `flattenRect` calls, and once per junction with a small polygon or circle
(`conformDisc(x, z, r, y, falloff)` would cover that). Until then roads keeps the rectangle approach and
the showcase waits for the terrain queue to drain before screenshots.

Also: undergrowth/grass tufts are scattered on road surfaces (asphalt fans of junctions and dead-end caps).
`vegetation.clearPolyline(seg.points, width + 3)` handles trees along segments; junction fans extend up to
`trim + width/2` from the node (roads already calls `clearVegetationCircle` there). If the grass tufts are a
separate scatter, please honour the same clear masks.

## Audio module
`[engine] error in audio: TypeError: Failed to execute 'setTargetAtTime' on 'AudioParam': The provided
float value is non-finite.` appears in headless screenshot runs (`tools/shot.mjs`) — likely a NaN gain when
the AudioContext is suspended. Not roads-related but it shows up in every module's error log.


APPLIED by integrator (2026-09-02): deprecation fixes (PCFShadowMap, HDRLoader), engine.post.depthTexture, engine.LAYER_NO_AO / LAYER_REFLECTED, engine.addMaterialHook + globalUniforms + setSunModulation + setFogHeight, events.listenerCount, shot.mjs retry, ARCHITECTURE.md contract additions (time/services/audio/economy rows, entity:selected + infoview:changed events, terrain.api.conformPath/conformDisc, budget clarification, cache-key note). Not applied: unified world.surfaceHeight (use roads.api.nearest), per-pass stats.

## Status after fix round 1 (2026-09-02)

- **terrain.api.conformPath / conformDisc**: in the contract (§5) and exported by terrain since 2026-09-02 ~03:50; roads uses
  them (showcase: 312 conform calls instead of 4 483 flattenRect calls). Roads still feature-detects: when `conformPath` exists it is called exactly once per touched segment with
  `segment.points` lowered by the bed drop (asphalt camber + 5 cm) and corridor width `segment.width + 1.2`;
  `conformDisc(x, z, r, y, falloff)` once per junction with k ≥ 2 (r = max trim + half width). Until then the
  flattenRect chain stays as fallback (≈ 4.5 k calls for the showcase → ~150 with the new API).
- **Grass tufts on asphalt** (terrain `Vegetation._updateGrass`): the near-camera tuft scatter does not consult the
  road network, so tufts poke through junction fans and dead-end caps. Roads now exposes
  `world.roads.api.isOnRoad(x, z)` and `surfaceHeight(x, z)` (asphalt/kerb/sidewalk height or `null`) — please skip
  tuft positions where `isOnRoad` is true (one `nearest()` query, spatial-grid backed).
- **Effects request #3 (unified surface height)**: `roads.api.surfaceHeight(x, z)` returns the road surface height
  (incl. camber, kerb and sidewalk steps) or `null` off-road; `max(terrain, surfaceHeight ?? -Infinity)` gives the
  ground for splashes/puddles.
- Roads consume `infoview:changed` (traffic view tints segments by `segment.traffic` 0..1, green → red) and
  `entity:selected { kind:'road' }` (highlight). Traffic module: please write `segment.traffic` (0..1 load) per sim tick.

- **Terrain impostor bake leaves the renderer viewport at one atlas cell** (`Vegetation.js` bake loop calls
  `renderer.setViewport(cx, cy, cell, cell)` / `setScissor` on the default framebuffer and never restores them): every
  frame afterwards renders into a 256×256 window (observed 2026-09-02 03:45). Please restore
  `renderer.setViewport(0, 0, w, h)` + `setScissor(0, 0, w, h)` (CSS pixels via `renderer.getSize()`) after the bake, or
  set `rt.viewport`/`rt.scissor` on the render target instead of the renderer.

## Status after fix round 2 (2026-09-02)

- **Junction pads are planar.** Every junction with trims now has a pad plane (`node.grad`, ≤ 6 % grade fitted from the
  arms' natural slopes); arms blend their height profile onto it over ~14 m. `terrain.api.conformDisc` only takes a
  single height, so roads pass the *lowest* pad height over the disc (`node.y − |grad|·r − bedDrop`) and let the verge
  skirts cover the difference. A `conformDisc(x, z, r, y, falloff, { gx, gz })` plane variant (or `conformPolygon`) would
  let the terrain hug sloped junction pads exactly — nice-to-have, not blocking.
- **Corridor "dirt scarring" (terrain, cross-module).** The terrain paints the cleared forest floor / steep conform
  falloff as dirt, so every road through a forest was ringed with bare earth. Roads now own the blend: the skirt is a
  7.5 m alpha-faded grass verge spanning the whole 8 m falloff, tinted at the toe from `terrain.api.groundInfo` (dry /
  sand / rock tones; forest floor stays lawn). Request to terrain: inside a `conformPath`/`conformDisc` corridor
  (+ falloff) keep the grass layer (dirt only from steep slope, not from the forest/flatten masks), and give cut faces a
  rock/soil splat rather than the flat brown — then the verge can be narrowed again.
- **Street lighting is part of the road asset** (as in Cities: Skylines II): roads instance lamp posts every 30 m
  (alternating sides, 9 m, 2700 K) on locals/avenues and 14 m twin masts every 42 m in the motorway median; the asphalt
  and sidewalk shaders paint the light pools analytically from the same spacing/phase. `world.roads.api.setStreetLights(false)`
  switches them off should the props module ship its own lamps. Environment: the moonlit ambient at 21–22 h is very low
  (whole landscape near black) — a slightly brighter night sky/hemisphere would help every module's night shots.

## Status after fix round 3 (2026-09-02) — material realism pass

- **Asphalt** now uses the shared `asphalt_light` set (Asphalt031, mean 120 sRGB) for every carriageway with mid-grey
  tints (local ≈95 sRGB albedo, avenue a touch darker, motorway darker still), roughness 0.84-0.86, a world-space
  aggregate detail normal at ≈0.5 m tiling, three octaves of tonal variation and slightly darker (not black) wheel
  tracks. Kerbs: 17 cm face with a 3 cm chamfer, baked AO on the face (`aDark` vertex attribute in `LAYOUT_ROAD`) and an
  analytic 0.45 m gutter AO + 0.7 m stain in the asphalt shader. Markings: off-white 0xe6e3d8 / traffic yellow for lines
  separating opposing traffic (negative `hw` in `RoadTypes.lines`), 0.12-0.15 m local widths, wear mask 0.55-1.0 that
  increases in wheel tracks and near junctions, energy-conserving sub-pixel coverage so distant lines fade instead of
  glowing pixel-wide. Night: warm 3000 K lamps, inverse-square pools with a GGX specular lobe towards the camera (road
  frame from screen-space derivatives of `aRoad.y`), sidewalk pool response halved, luminaires shrunk under a fixture cap.
  Skirt tinted to the terrain shader's grass tint (linear 0.72/0.87/0.53), alpha fade starts at the sidewalk edge,
  width 5 m. `conformPath` falloff now 8-16 m depending on the side drop of the corridor (gentler graded cuts).
- **Terrain (cross-module, nice-to-have):** cut faces deeper than ~2 m beside roads still show the flat brown dirt splat;
  a rock/soil splat on steep conform slopes (or a `conformPath(..., { retain: true })` that lets roads emit retaining
  walls) would finish the hillside look. `terrain.api.groundTint(x, z)` exposed on the api would let the skirt match the
  splat exactly instead of the hard-coded grass tint.

## Status after fix round 3 (2026-09-02)

- **k = 2 junctions are lofted, not fanned.** A node joining two segments (curve joints, and above all the
  motorway → avenue transition) now builds a real ribbon of carriageway between the two mouths: the two
  corner arcs are the left/right boundary (sampled at the union of *both* polylines' own arclength
  fractions, so it stays watertight against the corner sidewalks), the mouth cross-sections are lofted
  across it, and the road-space `lat` is normalised to the dominant type's half width so its lane lines,
  wheel tracks and gutter grime taper with the carriageway. Medians / Jersey barriers get a wedge nose
  from each mouth. `aDark` on asphalt vertices is the pad's paint fade (0 on ordinary segments).
- **Terrain conform order changed**: junction discs are conformed *before* the segment corridors.
  `conformDisc` takes a single height, so a sloped pad must be dug to its lowest corner; doing that first
  lets each arm's `conformPath` pull its own strip back to bed level. This removed a ~1 m retaining-wall
  step that appeared under the sidewalks around every junction on a grade.
  A `conformDisc(x, z, r, y, falloff, { gx, gz })` plane variant would let roads skip the over-dig entirely.
- **Corridor falloff** is now `clamp(7 + sideDrop/0.11, 9, 26)` so a graded bank stays under the terrain's
  dirt threshold (slope 0.12) and no longer reads as a scorched cut. Roads also call
  `clearVegetationPath(points, width + 9|6|3)` after `conformPath` (which only clears `width + 3`).
- Roads still need `terrain.api.groundInfo` for the verge tint — thank you, it is in use.

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

**To roads, from the integrator:** the demo city now builds a motorway with a curved ramp into an avenue,
two avenues, a 6x6 local grid, three spurs and an industrial loop (119 segments) — `?seed=7`, preset `ramp`
frames the motorway/ramp, `junction` and `closeup` frame signalised junctions. No console errors, roads
conform to the terrain everywhere I looked. Two seams still visible from the camera (both cross-module, both
already in your notes): the corridor around the ramp reads as a wide pale bare-earth swathe where vegetation
is cleared, and the avenue median trees are flat low-poly blobs next to the props street trees.

---

## Round 4 (roads → integrator / tools): the "dashed stitch seam" belongs to `tools`, not roads

The last critic logged a **[major]** against roads: *"a dotted/dashed black stitch seam running diagonally
across the [highway→avenue transition] pad"*. It is not road geometry and not a road shader.

Reproduction (both at `?showcase=roads&seed=7`, preset `roads_detail`, time 17.5):

* `http://127.0.0.1:5180/?showcase=roads&seed=7` → a 1 px bright dashed/solid line traces the **outline of
  every junction pad**, crossing asphalt, kerb, sidewalk and grass alike (`shots/roads/base_roads_detail_17h5.png`,
  crop x 540-800, y 240-430).
* `…&focus=terrain,environment,roads` → the line is **gone** (`shots/roads/base_focus.png`, same crop).
* `…&focus=terrain,environment,roads,traffic` → still gone (`shots/roads/f2.png`), so it is not traffic.

The remaining candidates are the modules dropped by that focus list; `src/modules/tools/gfx.js` is the only
one in the repo that draws dashed world-space polylines (`VectorLayer` / `polyline({ …, dash })`, and
`shapes.js` `rectOutline`). It looks like a hover/selection outline that is left visible with no tool active
(`world.tool.active === 'select'` on load). Please either hide the overlay when nothing is hovered, or scope
it to the hovered entity — it currently reads as a rendering artifact in every screenshot the critics take.

Nothing needed from core for this; recorded here so the finding is not re-filed against roads.
