# Core requests from the `tools` module

Nothing here blocks the module — every item has a working workaround in
`src/modules/tools/**`. Listed so the integrator can decide.

## 1. `R` / `F` are camera keys, so tools cannot use `R` to rotate a ghost

`CameraController.update()` binds `r` / `f` to camera tilt. Cities: Skylines II rotates the
placement ghost with `R`, which is the key players reach for first. The service tool therefore
uses `,` / `.` instead and says so in its read-out chip.

**Proposed:** move camera tilt to `T` / `G` (or make the tilt keys configurable), and let the
active tool claim `R`. Alternatively expose `input.claimKey('r')` so a module can take a key for
the frame and the camera skips it.

## 2. No "spend / refund" hook on the economy

`world.economy.money` is owned by the simulation. Roads and bulldozing have a price, so the road
tool does `world.economy.money -= cost` and re-emits `economy:changed` — the same thing
`simulation/services.js` does internally for service buildings.

**Proposed:** `world.economy.api = { spend(amount, reason) → bool, refund(amount, reason) }`, so
budget bookkeeping (and the "not enough funds" rule) lives in one place. The tools already refuse
a build they cannot pay for, but they cannot record it as a budget line.

## 3. Pointer capture while a tool drags

`Input` gives `drag` / `endedDrag`, which is enough. Two small things would help:
* `input.pointerOverUI` is only refreshed on `pointermove`; a click that starts on the canvas and
  ends over the HUD is still reported as a canvas click. The zoning marquee copes, but a
  `pointerDownTarget` flag on the drag record would be exact.
* A synthetic-click hook for automation. The tools module exposes its own
  (`__game.modules.tools.debugClick()`), used by the screenshot tooling; a core equivalent
  (`input.injectClick(ndc, button)`) would let every module be driven the same way.

## 4. Screen-space outline pass (nice to have)

CS2 draws a real silhouette outline around the selected building. That needs a mask render + a
composite inside the post chain; `engine.post` exposes the depth texture but no way to add a pass.
The tools module draws a holographic cage + corner brackets + ground ring instead, which is a
deliberate look, not a fallback — but if `engine.post.addPass(pass, order)` ever appears, a true
outline would be a one-file change.

## 5. `buildings.api.at(x, z)` is the only public building picker

Picking walks the ray in XZ and asks `buildings.api.at()` per step (services are exact ray/OBB
tests). It is accurate to the record's oriented box, not to the real mesh silhouette. A
`buildings.api.raycast(ray)` (or per-instance ids on the InstancedMesh pools) would make picking
pixel-exact against the actual geometry.

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

**To tools, from the integrator:**
1. **APPLIED** — `input.claimKey('r')` (+ `releaseKey`, `isClaimed`). While claimed, `input.isDown('r')` /
   `justPressed('r')` return false for everyone else, so the camera skips it; read the raw state with
   `input.isHeld('r')` / `justPressedRaw('r')` inside your own module. Call it every frame the claim should
   hold — it expires the frame after the last call, which is exactly what makes it survive the camera update
   at the top of the next frame. Camera tilt also answers to `T` / `G` now, so nothing is lost.
2. **DECLINED (redirected)** — `world.economy.api.spend/refund` belongs to the simulation module, not core.
   Raised in `docs/requests/simulation.md`; `world.economy.money -= cost` + `economy:changed` still works.
3. **APPLIED** — the drag record carries `target`, `overUIAtDown` and `synthetic`, and
   `input.injectClick(ndc, button)` dispatches real pointer events on the canvas for automation.
4. **PARTLY APPLIED** — no outline pass in core, but `engine.post.addPass(pass, index)`,
   `insertAfterRender`, `insertBeforeOutput` and `removePass` now let tools add its own mask+composite pass.
5. **DECLINED** — `buildings.api.raycast(ray)` is the buildings module's call, not core's.
**Also, please fix:** simulation reports a stale dashed white service outline left in the `tools-overlay`
group after `services.api.place(...)` with `world.tool.active === 'select'` and no selection
(`?showcase=simulation`). It is visible in the demo city too — clear the vector layer when the placement
ghost is dismissed.
