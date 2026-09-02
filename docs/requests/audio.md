# audio → integrator / other modules

No core code change is required for the audio module to work. Two documentation-level requests and
integration notes for the other builders.

## 1. Add `world.audio` to the world contract table (§4)

| `world.…` | written by | contents |
|---|---|---|
| `audio` | audio | `api:{ unlock(), setVolume(v), setMuted(b), toggleMute(), getSettings(), play(name, opts), playWorld(kind, {x,z}), setDebug(b), getState(), renderOffline(opts) }, state, settings` |

Why: the UI module needs to know where the volume/mute API lives; tools/effects may want to trigger
positional one-shots (e.g. a fire → `playWorld('siren', { x, z })`).

## 2. Document the audio events in §6

- `audio:volume` — payload `number` (master 0..1) **or** `{ master?, ambience?, sfx?, ui?, muted? }`
- `audio:mute` — payload `boolean`, or omitted to toggle
- `audio:play` — `(name, opts?)` play a UI kit sound: `hover, click, toggle, select, place, road, zone,
  bulldoze, notification, warning, error, levelup, cash, open, close`
- `audio:sfx` — `{ kind:'siren'|'horn'|'thunder'|'bell'|'carpass', x?, z?, variant? }` positional one-shot
- emitted by audio: `audio:ready { sampleRate }`, `audio:state 'waiting'|'running'|'suspended'|'blocked'`,
  `audio:changed { settings }`, `audio:event { kind, variant, x, z, distance, duration }` (effects can flash
  lightning on `kind === 'thunder'`).

## Integration notes (no change needed)

- Audio starts on the first `pointerdown` / `keydown` / `touchend` anywhere, or immediately when the browser allows
  autoplay (headless screenshots). Nothing is logged when autoplay is blocked.
- UI module: any `button, [role=button], a, input, select, label, .btn, [data-sound]` inside `#ui-root` gets
  hover/click feedback automatically. Opt out with `data-sound="none"`; pick a specific kit sound with
  `data-sound="place"`, `data-sound-hover="none"`.
- World events already consumed: `tool:changed` (toggle), `entity:selected` (select), `notification`
  (kind → notification/warning/error/cash), `roads:changed` while the road tool is active, `zones:changed`
  while zoning, `building:added` while a placement tool is active (or payload `{ manual:true }`),
  `building:removed` while bulldozing, `building:levelup`.
- Environment module: the mix reads `world.env.windStrength, rain, snow, fogDensity, nightFactor, temperature,
  weather`. Until `env.rain/snow` are written, the weather preset name (`rain|storm|snow`) is used as a fallback.
- Traffic / simulation: `world.traffic.vehicles` and `world.economy.population` drive the city hum, traffic wash,
  horn/siren frequency and the crowd murmur — please keep them updated every sim tick.


APPLIED by integrator (2026-09-02): deprecation fixes (PCFShadowMap, HDRLoader), engine.post.depthTexture, engine.LAYER_NO_AO / LAYER_REFLECTED, engine.addMaterialHook + globalUniforms + setSunModulation + setFogHeight, events.listenerCount, shot.mjs retry, ARCHITECTURE.md contract additions (time/services/audio/economy rows, entity:selected + infoview:changed events, terrain.api.conformPath/conformDisc, budget clarification, cache-key note). Not applied: unified world.surfaceHeight (use roads.api.nearest), per-pass stats.

## Round 1 fix notes from the audio module (2026-09-02)

- **Blocker fixed inside audio:** every AudioParam write now goes through `src/modules/audio/params.js`
  (finite/clamped, never throws; skipped/caught counts in `world.audio.api.getState().guard` and the debug HUD).
  The mix state sanitises every world input (`num()`), the virtual-vehicle sim rejects NaN lanes, and the
  module tick is fenced — `[engine] error in audio … non-finite` cannot recur in other modules' logs.
- **Traffic module (when it lands):** please publish `world.traffic.vehicles` as an array of records
  `{ id, x, y?, z, vx?, vz?, speed? (m/s), type?: 'car'|'van'|'truck'|'bus' }` (or expose `api.getVehicles()`);
  audio attaches positional engine/tyre voices with doppler to the nearest ones. A bare count still works.
- **Zoning / buildings:** audio reads `world.zones.lots[].type` and `world.buildings.list[].{type,state}` for the
  per-lot ambiences (industrial, commercial, residential, office, construction, park). Nothing else needed.
- Showcase notes about the simulated city are `console.info` (not warnings) so headless warning counts stay clean.

## Round 2 fix notes from the audio module (2026-09-02)

All five round-1 critique items are fixed inside `src/modules/audio/**` — no core change is needed.

- **§5 contract (blocker):** `world.audio.api.toggle()` now exists (`toggleMute` kept as an alias), and
  the UI kit resolves spelling aliases (`UISounds.resolveSoundName`): `notify|info|message|beep →
  notification`, `warn|alert → warning`, `money|buy → cash`, `demolish|delete → bulldoze`,
  `build|plop → place`, … Unknown names are counted in `api.getState().ui.unknown` and never logged.
- **Non-finite positions (major):** `audio:sfx` / `playWorld` sanitise the position (non-finite is
  rejected, |x|,|z| clamped to `world.half`), and `OneShots._pos()` re-validates and falls back to a
  road position; any event whose position goes non-finite is retired. New `api.selfTest()` throws
  NaN/±Infinity/strings/1e9 at every public entry point (49 cases): 0 throws, guard delta 0/0, every
  spawned event finite, settings restored.
- **Showcase (major):** it now builds a REAL district through your APIs — `terrain.flattenRect` +
  `clearVegetationRect` → `roads.build` (2 avenues + 6+6 local streets + spurs) → `zones.paintRect`
  per block (suburb → mid-rise ring → downtown core, industry east, a block zoned last so it is still
  under construction) → `buildings.fastForward` ×3 → `traffic.setDensity/spawnBurst`. Typical result:
  ~200 buildings, 500+ vehicles, 2.1 k residents / 4.2 k jobs. The mix is driven by those real numbers
  (`world.economy.population` stays 0 without the simulation running, so the HUD footer says
  "2.1k residents · 4.2k jobs (from 196 buildings)" — never an invented population).
- **Markers:** the additive depth-test-off discs are gone. Emitters are now constant-screen-size
  "sound glyph" sprites (depthTest on, LAYER_NO_AO, ≤ 0.9 opacity) plus a terrain-following ripple ring
  that expands from each siren/horn/bell at 34 m/s. `?audiodebug=0` turns the whole audio debug view
  off (markers **and** mix monitor) and the showcase may not override it — use it for a clean city shot.
- **Mix:** bird gain now falls with REAL height (`1/(1+(alt/95)^1.7)`) and with urbanisation, so from
  360 m the birds sit under the city hum instead of 10 dB over it; a clock jump (`time:set`) flushes
  scheduled bird calls and cricket chirps within ~120 ms; rain follows `env.rain` when
  `env.precipitation` is undefined (ARCHITECTURE spec trigger) while `precipitation === 0` still means
  "wet ground, no falling rain"; `urban` now counts jobs as well as residents.
- **New for other modules:** `world.services.list` entries now get an ambience (utilities → industrial
  hum, school → crowd, clinic/police/fire → HVAC). `world.traffic.api.getVehicles()` is consumed for
  per-vehicle engine/tyre voices with doppler — thank you, it works.

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

**To audio, from the integrator:** nothing needed from core this round. `world.audio` is in the contract
(§4), `events.listenerCount` is there, and the new `events.mute(name)` is for scripted world-building only —
it is not used on any `audio:*` event. Verified: `?showcase=audio` and the demo city both run with zero
console errors.
