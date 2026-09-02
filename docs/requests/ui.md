# Core requests from the `ui` module

## 1. `world.time` ownership — resolved, please document

The simulation module (`simulation/clock.js`) advances `world.time` every frame and emits `time:tick`.
The UI's round-1 clock fallback has been **removed**; the HUD only reads the clock now.

**Proposed:** add a row to the §4 table — `time | simulation | hour, day, month, year, speed, paused,
secondsPerHour, elapsedGameSeconds, weekday, totalDays — emits time:tick every frame, sim:tick every game minute`.

## 2. `tool:select` when the tools module is absent (still a placeholder)

The UI emits `tool:select` and, because the bus is synchronous, checks `world.tool` right afterwards. If the
request was not applied (`world.tool.active !== tool` or a different `type` / `view`), the UI sets
`world.tool` and emits `tool:changed` itself so the HUD stays consistent. This no longer touches
`events._listeners`. Once the tools module lands and always applies (or rejects by resetting `world.tool`)
every `tool:select`, this fallback is inert.

**Proposed (nice to have):** expose `events.listenerCount(name)` on `EventBus` so modules can detect an
unhandled event without heuristics:

```js
listenerCount(event) { const s = this._listeners.get(event); return s ? s.size : 0; }
```

## 3. `entity:selected` payload shape

The UI accepts `null`, `{ kind, id }`, `{ kind, id, entity }`, or a raw building/segment/lot record and looks
the entity up in `world.buildings.list`, `world.roads.segments`, `world.zones.lots` when only an id is given.

**Proposed:** document `events.emit('entity:selected', { kind:'building'|'road'|'lot', id, entity })` (and
`null` on deselect) in §6; tools should include the `entity` reference to avoid the lookup.

## 4. Info views — new UI events for overlay renderers

When an info view is armed the UI shows a legend panel and emits
`infoview:changed { view: 'traffic'|'landvalue'|'pollution'|'happiness'|'power'|'water'|'zoning'|null, buildings: bool, terrain: bool }`
(the two booleans are the legend's "Colour buildings / terrain" toggles). For `power` / `water` the UI also
calls `world.services.api.setInfoView('power'|'water'|null)` so the simulation's coverage overlay appears.

**Proposed:** add `infoview:changed` to §6 and let the roads / buildings / terrain modules tint their
materials from it (traffic → `segment.traffic`, happiness → `building.happiness`, …).

## 5. Speed steps vs. multipliers

`world.time.speed` is a step 0-3; the simulation maps it to `[0, 1, 2, 4]×` (`simulation.api.speedMultipliers`).
The UI reads that array for its tooltips. Please keep the contract "speed is a step" (or document the multipliers
in §3) so both stay in sync.


APPLIED by integrator (2026-09-02): deprecation fixes (PCFShadowMap, HDRLoader), engine.post.depthTexture, engine.LAYER_NO_AO / LAYER_REFLECTED, engine.addMaterialHook + globalUniforms + setSunModulation + setFogHeight, events.listenerCount, shot.mjs retry, ARCHITECTURE.md contract additions (time/services/audio/economy rows, entity:selected + infoview:changed events, terrain.api.conformPath/conformDisc, budget clarification, cache-key note). Not applied: unified world.surfaceHeight (use roads.api.nearest), per-pass stats.

## 6. Budget period label (round 3)

The HUD now labels every flow (`net`, `income`, `expenses`, upkeep, taxes) with `world.economy.period`
(`'week' | 'month'`) instead of a hard-coded "/ month" — ARCHITECTURE §4 says flows are per **week**, while
`simulation/economy.js` currently writes `e.period = 'month'`. Whichever the simulation settles on, the HUD follows;
please keep `economy.period` set (the HUD falls back to 'month' when it is missing).

## 7. Nothing else needed from core

`events.listenerCount`, `infoview:changed` and the `entity:selected` payload are in the contract now — thank you.
The HUD reads `world.services.api.coverageAt(x, z)` / `.stats()` for the selection panel's service row and the
info-view statistics, and `world.roads.nodes` for junction counts; all of these render as '—' / are omitted when
the owning module has not produced the value.

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

**To ui, from the integrator:** `world.economy.period` is now seeded as `'week'` by `World` (ARCHITECTURE §4),
so the HUD's label binding has a value from frame 0; `simulation/economy.js` still writes `'month'` — that is
flagged in `docs/requests/simulation.md`. `world.services.list` / `version` are seeded too, so the selection
panel no longer has to guard for `undefined`.
Screenshot note: during the demo city's scripted nine-week history the toast stack used to cover a quarter of
the frame; the demo now mutes `notification` while it builds (`events.mute`), so the HUD is clean in the
first screenshots. Nothing to change on your side.

---

## From buildings — the "Let the clock run" onboarding card is now wrong

Growth was rebalanced this round (`src/modules/buildings/index.js`: `BUILD_HOURS`,
`MEAN_FILL_HOURS`, `STARTER_RATE`, `LIVE_STEP`). At the **default speed (1x)** a freshly zoned
street now puts up its first construction site in ~6-10 s and its first **finished** house in
~30-38 s, and reaches 8-9 finished houses inside 125 s — measured with `node tools/playtest.mjs`
(new step "7a. the first two minutes at DEFAULT speed", `shots/playtest-buildings/report.json`).

The Getting Started card visible in `shots/playtest-buildings/14-growth-default-speed.png` reads:

> **Let the clock run** — "Nothing is built while time crawls. Push the speed to **4x** up in the
> clock — the plots start building straight away."

That is no longer true and now reads as a bug report: in that very screenshot the city has nine
houses at 1x. Suggested replacement: "Zoned plots build themselves. Watch the first scaffolding go
up, or push the clock to 4x if you are impatient." Speed is a convenience now, not a prerequisite.
