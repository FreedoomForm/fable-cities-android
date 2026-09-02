# Requests from the `zoning` module

## To `ui` — read zone colours from `world.zones.api.types` (low priority, cosmetic)

`src/modules/ui/catalog.js` hard-codes `ZONE_COLORS`. The zoning palette moved `res-low` from
`#8fd95a` to `#4ad19a`: the old pale yellow-green was isoluminant with the grass albedo once the
overlay switched from an opaque fill to a multiply tint (a yellow-green multiplier over yellow-green
grass is invisible), so it now leans mint/teal. Everything else is unchanged
(`res-high #1f9d63`, `com-low #62c6ff`, `com-high #2b6fdc`, `ind #f1b634`, `office #b57cf0`).

`world.zones.api.types` already returns `{ id, index, label, color, demand, width, depth }` for all
six types — reading `color` from there keeps the HUD legend, the zone tool chips and the ground
overlay in sync automatically. No core change needed.

## To `core` — nothing outstanding

`engine.addMaterialHook`, `engine.globalUniforms`, `engine.registerMaterial`, `LAYER_NO_AO` and the
HDR (HalfFloat, pre-tone-mapping) transparent pass were everything the overlay needed. The overlay's
fill pass relies on that HDR buffer: it uses `CustomBlending` (`dst *= src.rgb`) so the zone colour
modulates the *lit* ground, which is what makes it dim correctly at night. Please keep the
composer's render target linear/HDR with tone mapping in the output pass.

## Notes for `buildings`

* `world.zones.lots[]` carries `{ id, cells, x, y, z, w, d (metres), width, depth (cells), yaw,
  type, roadSegmentId, side, frontage:{x,y,z,nx,nz,t,length}, corners[8], buildingId }`.
  `yaw` rotates local +Z to face the road; `w` runs along the road, `d` away from it.
* Lot depth is now the full painted depth (2 … 4 cells), no longer capped per zone type, so a
  low-density lot can be 32 m deep. Scale the building to `w`/`d` rather than assuming a size.
* `zones.api.stats().coverage` reports `lotCells / zonedCells` (currently ~0.85 in the showcase);
  the remainder are painted cells that geometry cannot turn into a 2×2 parcel. They are drawn
  slightly desaturated and are never handed out as lots.

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

**To zoning, from the integrator:** no core change needed and none made. The demo city paints 28 blocks
through `paintRect` and reserves eight civic blocks that are never zoned so `services.api.place` has a free,
road-served site — 259 lots, 253 buildings, no refusals. The `res-low` palette change is a `ui` matter and is
recorded there.
