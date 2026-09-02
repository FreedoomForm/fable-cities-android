# simulation → core / integrator requests

Nothing in core blocks the simulation module today; the items below are conventions other
modules should know about, plus small optional core additions.

## Conventions the simulation module established (no core change needed)

- `world.economy.income / expenses / net` are **per game week** (`world.economy.period === 'week'`,
  ARCHITECTURE §4 as written — fix round 2 reverted the round-1 monthly experiment). A budget report
  (`economy:budget`, `economy.budget`) closes every 7 game days from the hourly loop and carries
  `delta` (net vs the previous week); the notification text says "/ week · ▲/▼ ¤n vs last week".
  The HUD already labels flows from `economy.period`. Service `upkeep` in `SERVICE_TYPES` is weekly.
- `world.time` gains `minute`, `weekday` (0 = Mon … 6 = Sun, real calendar), `totalDays`.
  Speed steps map to real-time multipliers `[0, 1, 2, 4]` (`simulation.api.speedMultipliers`).
- `world.services`: `{ api, list, types, version, infoView }`. `list` records are
  `{ id, type, name, x, y, z, yaw, w, d, height, radius, capacity, upkeep, workers, state, efficiency }`.
  Events: `service:added`, `service:removed`, `services:changed`, `services:infoview`.
- `world.simulation = { api }` mirrors the module export so tools/ui can reach it via `world`.
- Service buildings are **rendered by the simulation module** (visuals.js, merged meshes, lazy
  loaded). If the buildings module wants to own that rendering later, call
  `world.simulation.api` … `internals().visuals.dispose()` or start the game with
  `?services_visuals=0`.
- Extra `world.economy` fields: `employed, unemployment, jobFill, education, pollution, congestion,
  landValue, residentialCapacity, jobsByClass, coverage{service→0..1}, budget (last weekly report),
  milestone {name,next,nextPopulation,progress}, alerts[]`.
- Traffic may publish `world.traffic.congestion` (0..1); the simulation reads it for happiness and
  falls back to `vehicles / (segments × 14)`.

## Requests to other modules

- **terrain / props**: please clear vegetation (trees, grass tufts) inside service-building
  footprints — iterate `world.services.list` (`x, z, w, d, yaw`, allow +5 m margin) on
  `service:added` / `services:changed`, the same way zoned buildings are cleared. The simulation
  already calls `world.terrain.api.flatten(cx, cz, w, d, y)` when it exists.
- **ui**: `world.economy.net/income/expenses` are per **week** (`economy.period === 'week'`) — read the period from the world, never hard-code it.
- **ui**: `infoview:changed` is also emitted by the simulation when a *service coverage* view opens or closes
  (`{ view: 'fire'|'power'|…|null, buildings: true, terrain: true, source: 'simulation', legend: { title, desc, low, high, stops[], unit, stat, facilities } }`)
  — the legend panel can bind to `legend` for the eight coverage views instead of its own catalogue entry.
- **tools**: the service tool can call `world.services.api.canPlace(type, x, z, { yaw })` for a
  live ghost validity check (`{ ok, reason }`) and `place(type, x, z, { yaw })` to build; costs
  are deducted automatically and `notification` fires on failure.

## Flag to the integrator (fix round 2)

- **Stand-in building stock.** `world.buildings.list` is still empty (buildings + zoning are 1 ms stubs), so
  the simulation showcase feeds the economy a deterministic synthetic list and *renders* it as massing
  blocks (`src/modules/simulation/standins.js`: one InstancedMesh + one roof InstancedMesh, procedural
  facade shader with per-pane night lights, `registerMaterial`, `LAYER_REFLECTED`). The stand-ins drop
  themselves the moment `world.buildings.list` becomes non-empty — nothing to remove when the buildings
  module lands; `showcase.js` also prefers `buildings.api.fastForward` when it exists.
- **Driveways.** Service sites connect to the network through `roads.api.nearest` + `roads.api.sampleEdge`
  (sidewalk outer edge). The drop-kerb is a sloped overlay across the sidewalk (the road mesh itself is
  untouched). If roads later expose a real kerb-cut API (`roads.api.addDriveway(segmentId, t, width)`),
  the simulation will call it instead — see `buildDriveway()` in `visuals.js`.

## Round-3 notes (2026-09-02)

- **ui — coverage views in the catalogue.** `INFO_VIEWS` in `src/modules/ui/catalog.js` carries only
  `power` and `water` of the eight service coverage views. The simulation renders a coverage overlay
  for all eight (`world.services.api.setInfoView('fire'|'police'|'health'|'education'|'sewage'|'garbage'|…)`)
  and already emits the legend for each one on `infoview:changed`
  (`{ view, legend: { title, desc, low, high, stops[], unit, stat, facilities }, source: 'simulation' }`).
  Please add the missing six entries (or bind the panel to the emitted `legend` when
  `source === 'simulation'`) — `hud.infoview.show(id)` currently falls through to `hide()` for them,
  which switches the overlay back off. The simulation showcase therefore uses `water` for its
  `simulation_infoview` preset (override with `?infopreset=fire`).
- **tools — stale overlay outline.** After `world.services.api.place(...)`, the `tools-overlay`
  group keeps drawing a dashed white outline of one service footprint even though
  `world.tool.active === 'select'`, `world.selection === null` and no pointer has touched the canvas.
  It shows up across the fire-house apron in `?showcase=simulation` (visible in
  `shots/simulation/p3r1_simulation_detail_13.png`; hiding the `tools-overlay` group removes it —
  `shots/simulation/dbg11.png`). Emitting `tool:select 'select'` from the showcase does not clear it.
  Please clear the vector layer when the placement ghost is dismissed.
- **Service upkeep rebalanced** (weekly): power 1150, health 820, education 720, police 590,
  fire 560, sewage 480, garbage 420, water 260 — a ~1,800-resident town with all eight services,
  ~6.8 km of road and 10-12 % taxes now runs about +¤300-500/week instead of −¤5,600.
- **Showcase treasury.** `?showcase=simulation` hands over ¤78,400 after its nine-week fast-forward
  (`SHOWCASE_TREASURY` in `showcase.js`) so the weekly delta and the milestone rewards are legible
  against the balance; the sandbox default (`World.js` ¤350,000) is untouched.

## Optional core additions (nice to have)

1. **`World.time` defaults**: add `minute: 0, weekday: 0, totalDays: 0` to the constructor so the
   fields exist before the simulation module initialises (harmless if left to the module).
   ```diff
   -      elapsedGameSeconds: 0,
   +      elapsedGameSeconds: 0,
   +      minute: 0, weekday: 0, totalDays: 0,
   ```
2. **`World.economy` defaults**: add `period: 'week'` and `employed: 0, unemployment: 0` so the
   UI can bind to them before `module:ready:simulation`.
3. **DebugAPI.stats()**: consider including `money`, `happiness` next to `population` so
   `tools/check.mjs` logs show economy health at a glance.
   ```diff
   -  population: world.economy.population,
   +  population: world.economy.population, money: Math.round(world.economy.money), happiness: world.economy.happiness,
   ```


APPLIED by integrator (2026-09-02): deprecation fixes (PCFShadowMap, HDRLoader), engine.post.depthTexture, engine.LAYER_NO_AO / LAYER_REFLECTED, engine.addMaterialHook + globalUniforms + setSunModulation + setFogHeight, events.listenerCount, shot.mjs retry, ARCHITECTURE.md contract additions (time/services/audio/economy rows, entity:selected + infoview:changed events, terrain.api.conformPath/conformDisc, budget clarification, cache-key note). Not applied: unified world.surfaceHeight (use roads.api.nearest), per-pass stats.

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

**To simulation, from the integrator:** all three optional core additions are applied — `World.time` seeds
`minute/weekday/totalDays`, `World.economy` seeds `employed/unemployment/net/period:'week'` (note: ARCHITECTURE
§4 says flows are per **week**, and `economy.js` writes `'month'` — please settle it, the HUD follows
`economy.period`), and `__game.stats()` reports `money` and `happiness`. `World.services` also seeds
`list: []` / `version: 0`.
`simulation.api.fastForward` is now on the demo-city path: the demo places the eight services on reserved
civic blocks, then fast-forwards nine game weeks and restores `world.time.hour` so `?time=` still holds.
Result at `?seed=7`: 1.33 k residents, happiness 0.79, coverage 0.80-1.00 on all eight services, +weekly
budget, one benign "Businesses need workers" alert. `services.api.place` refuses a site that overlaps a
building or a road, which is correct — the demo reserves the blocks instead.

---

## From buildings (growth rebalance, first-session pass)

Growth pacing was retuned so a visitor from a link sees something inside two minutes: at the
**default speed** a zoned street now produces a construction site in ~6 s and a **finished** house in
~30 s (was: first site 25 s, first finish ~13 real minutes). Construction still runs through all
eight scaffolding stages, ~3 s per stage. Constants live in `src/modules/buildings/index.js`
(`BUILD_HOURS`, `MEAN_FILL_HOURS`, `STARTER_RATE`, `LIVE_STEP`).

What buildings needs back from the simulation:

1. **Demand must not sit at zero.** Every empty lot's fill probability is
   `(hours / MEAN_FILL_HOURS) * clamp(economy.demand[kind] * 1.5, 0.10, 1.25)`. The floor was
   lowered 0.22 → 0.10 this round precisely so the demand bars matter more, which also means a
   demand meter stuck at 0 now slows growth **12×** rather than 4×. In the audited run
   `demand.residential` decayed 0.60 → ~0.47 → ~0 while population stayed at 1, so residential
   growth throttled itself. Please make sure demand is recomputed from real households/jobs once
   the population count is fixed.
2. **Residents/jobs are already on the record.** `building.residents` and `building.jobs` are set at
   spawn (from the generator recipe) and are non-zero for every `state === 'built'` residential
   building — `world.buildings.api.stats()` returns the city totals (`residents`, `jobs`,
   `byState`). Population should follow `state === 'built'`, not `state === 'construction'`;
   `building:completed` fires the moment a building becomes occupiable.
3. **A completion is a good moment to move people in.** `building:completed` now fires within ~30 s
   of a first-time player painting a zone, so anything keyed to it (first-citizen toast, milestone)
   lands inside the first session.
