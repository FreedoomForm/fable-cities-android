# Fable Cities — Architecture & Module Contract

A browser-based city builder in **Three.js (r185) + Vite**, plain ES modules (no TypeScript).
Read this whole file before touching code. It is the contract that lets a dozen builders work in parallel.

## 1. Layout & ownership

```
index.html, vite.config.js, package.json      integrator only
src/main.js, src/core/**                       integrator only  (Engine, Config, World, Input, CameraController, AssetLoader, DebugAPI)
src/shared/**                                  shared utils (random.js, math.js, noise.js). You may ADD files, never modify existing ones.
src/modules/<name>/**                          owned by that module's builder. Never edit another module's folder.
src/demo/**                                    demo-city builder (integrator maintains DemoCity.js)
public/assets/<module>/**                      module-owned assets; public/assets/shared/** for shared PBR sets (see §8)
tools/**                                       verification tooling (shot.mjs, check.mjs, assets/*)
docs/requests/<module>.md                      if you need a change in core, write it here (what + why). Do not edit core.
```

Modules (init order): `terrain → environment → roads → zoning → buildings → props → traffic → effects → simulation → tools → ui → audio`, then `demo`.

## 2. Module interface

```js
export const name = 'roads';
export async function init(ctx) { ... }      // may await asset loads; keep under ~3 s
export function update(dt, elapsed) { ... }  // per frame; dt seconds (clamped ≤ 0.1)
export function dispose() { ... }            // optional
```

`ctx` = `{ engine, renderer, scene, camera, world, events, assets, input, cameraController, config, modules, moduleStatus, uiRoot }`.

A module that throws at import/init is isolated (recorded in `window.__game.moduleStatus`) — the rest of the game keeps running. Never leave the file in a syntactically broken state for long; other builders' screenshots share the dev server.

## 3. World, units, conventions

- **Units are metres. +Y up. Ground is the XZ plane. North = −Z. Yaw = rotation about +Y.** Map spans `[-world.half, +world.half]` on X and Z (`world.size` = 2048 by default).
- Zoning grid cell = `world.cellSize` = 8 m (Cities: Skylines grid). `world.toCell(x,z)` / `world.cellCenter(cx,cz)`.
- **Determinism:** all procedural generation uses `makeRng(seed)` from `src/shared/random.js` (`world.rng`, or `world.rng.fork(salt)`), never `Math.random()`. Screenshots must be reproducible for a given `?seed`.
- `world.time.hour` ∈ [0,24). `world.env.nightFactor` ∈ [0,1] (0 day, 1 night) — use it to switch on lights. `world.env.sunDirection` is the direction light *travels* (points down).
- Materials: PBR (`MeshStandardMaterial` / `MeshPhysicalMaterial`), correct `colorSpace` (albedo/emissive sRGB, everything else linear), `RepeatWrapping`, anisotropy = `engine.maxAnisotropy`. No `MeshBasicMaterial` for world geometry except unlit emissive glow.
- **Shadows:** every lit material must be passed through `engine.registerMaterial(mat)` (or `engine.registerObject(obj)`) *before first render* so cascaded shadow maps work. Set `castShadow` / `receiveShadow` explicitly.
  Bias and softness are derived **per cascade** from that cascade's texel footprint, not set globally: `shadow.normalBias` ≈ 1.9 texels, `shadow.bias` a small *world* offset, `shadow.radius` a constant **0.5 m penumbra**. Tune with `engine.setShadowTuning({ penumbra, normalBiasTexels, depthBias, depthBiasPerTexel, maxNormalBias, minRadius, maxRadius })` — all in metres/texels, applied to every cascade. Note r185 maps `PCFShadowMap` to a Vogel-disk PCF (soft, `shadow.radius` widens it); **`PCFSoftShadowMap` is deprecated and silently degrades to one hard tap** — do not set it.
  Never set `scene.overrideMaterial` around a `renderer.render()`: `WebGLShadowMap` picks its depth material from it, so alpha-cut foliage casts solid cards and every cascade is re-rendered. **`Object3D.onBeforeShadow` cannot swap in a cheaper caster in r185** — `WebGLShadowMap.renderObject` reads `objects.update(object)` into a local *before* calling the callback, so a `geometry` swap there is ignored. Use a separate shadow-only mesh instead (`colorWrite:false, depthWrite:false`, sharing the original's `instanceMatrix` for an `InstancedMesh`).
  `shadowTuning.maxNormalBias` is a hard cap in **metres** (0.9). The normal offset is what kills acne, but it also lifts the receiver sample off the ground: above ~1 m nothing car-sized casts a visible shadow in the far cascades, so raise it only with a screenshot to justify it.
- **Layers:** `engine.LAYER_NO_AO` (=1) — put particles/billboards/transparent effects here so the GTAO pre-pass skips them (that pre-pass uses `scene.overrideMaterial`, so it cannot alpha-test; core also sets `material.allowOverride = false` on any mesh whose geometry has no `normal` attribute, which would otherwise write a zero normal and blacken the AO under it). `engine.LAYER_REFLECTED` (=3) — enable on large static geometry (terrain, roads, buildings) so it appears in planar water reflections.
- **Global material hooks:** `engine.addMaterialHook((shader, material) => {...})` patches every lit material (existing + future). Shared uniforms live in `engine.globalUniforms` (`uSunModulation` + `uSunModulationXf` for cloud shadows via `engine.setSunModulation(tex, xf)`, `uFogHeight` via `engine.setFogHeight(y0, H)`, `uWetness`, `uTime`). Only the environment module registers hooks that touch lighting/fog; other modules read the uniforms.
  **A standard material has no `vUv`.** three.js only emits `varying vec2 vUv` for materials that use a UV-sampled map, and `USE_UV` is never defined for `MeshStandardMaterial` by itself — so an `#ifdef USE_UV` block in a hook is dead code that compiles silently and never runs. Sample world space, or set `material.defines.USE_UV = ''` on your own material (defines are part of the program cache key, so that is safe).
  **Ordering is contractual:** for one material the order is (1) the material's own `onBeforeCompile`, (2) the CSM patch, (3) global hooks in registration order. So a hook may rely on a chunk another module replaced wholesale, and a material that declares a uniform itself wins over a hook that would declare the same one — a hook must feature-detect (`if (!shader.fragmentShader.includes('uniform float uWetness'))`) before declaring. Adding or removing a hook bumps `engine._hookVersion`, which is part of every registered material's program cache key, so hooks really reach materials three.js already compiled.
- **Post-processing:** `engine.post` = `{ render, gtao, bloom, smaa, output, renderTarget, sceneDepth(), sceneDepthTexture(), insertAfterRender(pass), insertBeforeOutput(pass), addPass(pass, index), removePass(pass) }`.
  **Use `post.sceneDepthTexture()`.** It is a resolved R32F copy of this frame's scene depth — `texture2D(t, uv).x` returns exactly what the DepthTexture would — and it is correct in EVERY pass regardless of buffer parity, is never another pass's render target (so it can never form a feedback loop), and costs nothing until the first module asks for it. `post.sceneDepth()` (the composer's `readBuffer.depthTexture`) is only valid while no pass has swapped since the RenderPass; `post.depthTexture` is renderTarget1's attachment and is kept for compatibility only. EffectComposer's two buffers own *separate* depth attachments and sharing one is not possible in r185 (`deallocateRenderTarget` disposes it).
  The **GTAO pass does not swap**: the engine composites the AO in place onto the read buffer, so a pass inserted after it still sees valid depth. Its radius is **screen-space** (~17 drawing-buffer pixels — ≈0.8 m of contact occlusion at street level, tens of metres from the air; `thickness` 1.6 m stops anything further away from occluding at all) and it fades out over `engine.aoFade` (a `Vector2` of view depth in metres, default 400 → 1200) because the depth buffer quantises to whole metres past ~1 km.
- **Image-based light (the specular budget):** three drives both halves of the IBL off one number — `WebGLRenderer` overwrites the `envMapIntensity` uniform with `scene.environmentIntensity` for every standard/physical material whose own `envMap` is `null`, so ambient fill and reflections move together *and every `envMapIntensity` a module authors is discarded*. Core splits them: `engine.setEnvironment(tex, intensity)` binds the probe at **full strength** for the specular lobe (`scene.environmentIntensity = max(1, intensity)`) and re-applies the requested `intensity` to the diffuse half only, in the shader (`globalUniforms.uIblDiffuse`). Each material's authored `envMapIntensity` is restored as its own specular gain, capped at `engine.envSpecMax` (2.2). So: **`material.envMapIntensity` works again and means "×sky"**, ambient fill is exactly what environment asked for, and no module needs to divide by `scene.environmentIntensity` any more (`engine.envRequested` is the diffuse level if you need it). A material that sets its OWN `envMap` is left alone.
- `engine.setSkyRadiance(up, horizon, down)` publishes the sky's three radiances as `globalUniforms.uSkyUpRad / uSkyHzRad / uSkyDnRad` for modules that fake a local probe (environment writes them; everyone else reads).
- **Lights:** `engine.registerLight(light, priority)` books a light against the shared `engine.quality.lightBudget` (8/16/32/48 by quality) and warns once if the total is exceeded. Nothing is culled for you. **Never toggle `light.visible` or add/remove lights at runtime** — three re-derives `NUM_POINT_LIGHTS` and recompiles every registered material (measured: 60 → 9.5 fps). Allocate the pool in `init()` and idle unused lights at `intensity = 0`.
- **Quality knobs:** `engine.quality` = `{ name, pixelRatio, shadowMapSize, cascades, shadowDistance, gtao, bloom, smaa, anisotropy, drawDistance, density (vegetation/scatter), propDensity (street furniture only), particles, reflections, textureSize, lightBudget }`.
- If your material has its own `onBeforeCompile`, set `material.customProgramCacheKey = () => 'mymodule-v1'` BEFORE `engine.registerMaterial` so distinct programs stay distinct.
- Custom shaders: `ShaderMaterial` with `lights: true` and the standard `#include <lights_fragment_begin>` chunks is CSM-compatible; pure unlit shaders are fine for sky/effects. Prefer `onBeforeCompile` patches of `MeshStandardMaterial` (e.g. wind sway, splat maps) — `registerMaterial` preserves your `onBeforeCompile`.
- Performance budget @1080p, quality=high, on Apple Silicon, with the demo city: **≥ 50 fps, ≤ 2500 draw calls, ≤ 8 M triangles** as reported by `__game.stats()` — these numbers are ACCUMULATED over all passes of a frame (4 shadow cascades + GTAO pre-pass + water reflection + main pass). Use `InstancedMesh`/`BatchedMesh`, merged geometry, LOD, frustum culling. Scale detail with `engine.quality` (`density`, `drawDistance`, `textureSize`, `particles`).

## 4. World contract (who writes what)

| `world.…` | written by | contents |
|---|---|---|
| `time` | simulation | `hour, minute, day, weekday (0=Mon), month, year, totalDays, speed (step 0-3 → multipliers [0,1,2,4] in simulation.api.speedMultipliers), paused, secondsPerHour` — simulation advances the clock every frame and emits `time:tick`, `sim:tick` once per game minute |
| `terrain` | terrain | `ready, size, waterLevel, getHeight(x,z), getNormal(x,z,out), isWater(x,z), raycast(ray,outVec3)→bool, api:{ heightmap, biome(x,z), flatten(cx,cz,w,d,y)? }` — emit `terrain:ready` |
| `roads` | roads | `version, nodes:Map, segments:Map, api` (see §5) — emit `roads:changed` after every mutation |
| `zones` | zoning | `version, lots:[], api` (see §5) — emit `zones:changed` |
| `buildings` | buildings | `version, list:[], api` (see §5) — emit `building:added / building:removed / building:levelup` |
| `props` | props | `api:{ refresh() }` |
| `traffic` | traffic | `api:{ setDensity(f) }, vehicles, pedestrians` |
| `services` | simulation | `{ api, list, types, version }` (World seeds `list: []`, `version: 0` so readers never see `undefined`) — `api.place(type,x,z)`, `coverageAt(x,z)`, `setInfoView(view)`; records `{ id, type, name, x, y, z, yaw, w, d, height, radius, capacity, upkeep, workers, state, efficiency }`; events `service:added`, `service:removed`, `services:changed`. Service buildings are rendered by simulation (visuals.js) |
| `audio` | audio | `api: { unlock, setVolume, setMuted, toggle }`; events in: `audio:volume` (number or `{master, ambience, sfx, ui, muted}`), `audio:mute`, `audio:play(name)` (hover, click, toggle, select, place, road, zone, bulldoze, notify, error), `audio:sfx {kind,x,z}`; events out: `audio:ready`, `audio:state` |
| `economy` | simulation | `money, population, households, jobs, workers, employed, unemployment, income, expenses, net` (all flows are **per game week**, `economy.period === 'week'`), `taxRate, happiness, demand{residential,commercial,industrial,office}, education, pollution, congestion, landValue, coverage{service→0..1}, budget, milestone, alerts[]`. `World` pre-seeds `minute/weekday/totalDays` and `employed/unemployment/net/period` so the HUD can bind before the simulation initialises. |
| `env` | environment | sun/sky/fog/weather/wind/nightFactor (also calls `engine.setSun/setHemisphere/setFog/setEnvironment/setExposure`) |
| `tool` | ui / tools | `active` ('select','road','zone','bulldoze','service',…), `options` |
| `selection` | tools | selected entity `{ kind:'building'|'road'|'lot', id }` |

## 5. Public module APIs

**roads.api**
```js
build(points /* [{x,z},…] world coords */, typeId /* 'local'|'avenue'|'highway'|'path' */, { curve: 'straight'|'bezier' }) → { segments:[id], nodes:[id] }
remove(segmentId)
types                              // { local:{ width:12, lanes:2, speed:50 }, avenue:{ width:24, lanes:4 }, highway:{…}, path:{…} }
snap(x, z, radius)                 // → { x, z, nodeId?, segmentId?, t? } for tools
nearest(x, z, maxDist)             // → { segment, t, point:{x,y,z}, tangent:{x,z}, distance } | null
sampleEdge(segmentId, t, side /* -1 left | +1 right */) → { x, y, z, nx, nz }   // road edge (sidewalk outer edge), normal pointing away from road
segmentsInRadius(x, z, r)          // → [segment]
laneGraph()                        // → { lanes:[{ id, segmentId, dir:+1|-1, points:[{x,y,z}], speed, width }], connections:Map<laneId, laneId[]> } for traffic
```
Segment record: `{ id, a:nodeId, b:nodeId, type, width, length, curve:THREE.Curve, points:[Vector3] (dense samples, y = terrain), lanes:[…] }`. Node: `{ id, x, y, z, segments:[id] }`.

**zones.api**
```js
paint(cells /* [{cx,cz}] */, zoneType /* 'res-low'|'res-high'|'com-low'|'com-high'|'ind'|'office' | null (erase) */)
paintRect(x0, z0, x1, z1, zoneType)
lotsFor(zoneType?)                 // lots: { id, cells:[{cx,cz}], x, z (centre), w, d (metres), yaw, type, roadSegmentId, frontage:{x,z,nx,nz}, buildingId|null }
setOverlayVisible(bool)            // coloured zone tiles (tools turn this on while zoning)
```
Zoning creates cells only within 4 cells (32 m) of a road, oriented to the road, and merges them into lots of 2×2 … 4×4 cells.

**buildings.api**
```js
spawn(lot, { level, seed }) → building     // called by growth logic; demo uses it directly
remove(id)
fastForward(gameSeconds)                   // instantly grow according to demand (demo start)
building = { id, lotId, type, level(1-5), x, y, z, yaw, w, d, height, floors, residents, jobs, state:'construction'|'built', progress }
```

**terrain.api** — `getHeight/getNormal/isWater/raycast` (on `world.terrain`), `api.flattenRect(x0,z0,x1,z1,y,falloff)`, `api.conformPath(points /*[{x,y,z}]*/, width, falloff=6)` (roads call this once per segment — heights interpolated along the polyline, vegetation cleared in the corridor), `api.conformDisc(x,z,r,y,falloff)` (junctions), `api.clearVegetationRect/Circle`, `api.biome(x,z)`. Terrain must also clear vegetation under `world.services.list` footprints (`services:changed`) and under lots with buildings.
**props.api** — `refresh()` re-scatters street furniture after roads change (props also listen to `roads:changed`).
**traffic.api** — `setDensity(0..2)`, `spawnBurst(n)`.
**simulation.api** — `setSpeed(0-3)`, `setTax(type, rate)`, `tick()`, `stats()`.
**tools** — activate via `events.emit('tool:select', 'road', { type:'avenue' })`; tools set `world.tool`, draw ghost previews, call the APIs above and emit `tool:changed`, `entity:selected`.
**ui** — renders HUD into `ctx.uiRoot` (its own CSS file), listens to `sim:tick`, `economy:changed`, `time:tick`, `tool:changed`, `entity:selected`, `notification`.


## 5b. Start screen and world modes

The game boots into one of two worlds, chosen by the player before anything is generated:

- **New city** — an empty map built from the player's seed. No roads, no zones, no buildings. The player lays the first road with the road tool.
- **Demo city** — `src/demo/DemoCity.js` runs and grows a city of roughly 16,000 people.

`src/modules/menu/index.js` is imported **directly by `src/main.js` before the module loop**, because the
player's seed has to reach the terrain generator. Its `init()` is therefore a no-op. Contract:

```js
showStartScreen(ctx) -> Promise<{ mode:'new'|'demo', seed:number, cityName:string, quality?:string }>
setProgress(fraction, text)   // optional, mirrors the core loading bar while modules initialise
hide()
```

Core applies the result before initialising modules: it sets `config.seed`, `world.seed`, a fresh
`world.rng`, `world.economy.cityName` and `config.demo`, then emits `game:start` with the choice.
`ctx.startChoice` holds it for anyone who needs it later.

**The screen is skipped whenever the URL pins the world** — any of `?demo=`, `?showcase=` or `?headless=`
present — so every screenshot, showcase and check URL in §7 keeps working unchanged. `?menu=1` forces it on,
`?menu=0` off. Never make the start screen a precondition for a URL that tooling uses.

A module that must behave differently in an empty world reads `world.buildings.list.length === 0` or listens
for `game:start`; it must not assume a demo city exists.

## 6. Events

`terrain:ready`, `roads:changed`, `zones:changed`, `building:added`, `building:removed`, `sim:tick` (once per game minute), `economy:changed`, `time:tick` (every frame with `{hour, day}`), `time:set`, `time:speed`, `weather:set`, `tool:select (tool, options)`, `tool:changed`, `entity:selected` — payload `{ kind:'building'|'road'|'lot'|'service', id, entity }` or `null` on deselect (tools MUST include `entity`), `infoview:changed { view:'traffic'|'landvalue'|'pollution'|'happiness'|'power'|'water'|'zoning'|null, buildings, terrain }` (emitted by ui; roads/buildings/terrain tint accordingly), `notification` `{ kind, title, text }`, `service:added`, `services:changed`, `audio:*` (see §4), `assets:progress`, `engine:resize`, `modules:ready`, `game:ready`.
`events.listenerCount(name)` tells you whether anyone handles an event. `events.mute(name|names)` drops an event until the returned fn is called — for scripted world-building only (the demo city fabricates nine weeks of history and must not emit nine weeks of `notification` toasts); never in steady state.

## 6b. Showcase (mandatory)

Every module ships `src/modules/<name>/showcase.js`:
```js
export async function showcase(ctx) { /* build a representative scene for THIS module using its own api, register camera presets */ 
  window.__game.presets.roads_hero = { target: { x: 0, z: 0 }, distance: 120, yaw: 0.6, pitch: 0.35 };
}
```
It runs after all modules initialised when the URL has `?showcase=<name>` (which also disables the demo city unless `demo=1`). Critics review modules through their showcase plus the full demo city, so make the showcase honest and representative — no cherry-picked angles.

## 7. Verification (mandatory before you report done)

The dev server runs at **http://127.0.0.1:5180** (integrator starts it; if it is down: `npm run dev &`). Do not start a second server on 5180.

```bash
node tools/shot.mjs --out shots/<module>/name.png --preset city,street,aerial --time 13,20.5   # writes PNGs + name.log.json
node tools/check.mjs                                                                              # module status, console errors, perf
```
Then **Read the PNG(s)** and inspect the `.log.json` (GPU string, errors, draw calls, fps). URL params: `?seed=…&time=…&cam=…&quality=…&weather=…&demo=0&focus=terrain,environment`. `--eval "__game.setTool('zone')"` runs JS before the shot; `--view '{"target":{"x":..,"z":..},"distance":..,"yaw":..,"pitch":..}'` sets a raw camera. `window.__game` exposes `world, scene, camera, setCamera, setTime, setWeather, setTool, stats(), sceneSummary(), presets`. A preset may carry `time` (`{ target, distance, yaw, pitch, time: 16.2 }`) and `setCamera` applies it; an explicit `--time` still wins. Demo/other code can add presets (`__game.presets.downtown = {...}`).
The demo city (`src/demo/DemoCity.js`, `?demo=1`, on by default) builds a real town through the public APIs — motorway + ramp, two avenues, a local grid, districts (downtown → mid-rise → suburbs, industry and offices east), eight civic blocks reserved for `services.api.place`, then nine game weeks of simulation so the city is populated (≈ 250 buildings, 1.3 k residents, 620 vehicles, all eight services covered). It re-points `city / street / aerial / skyline / closeup / top` at the actual town centre and adds `downtown, suburb, industry, highway, junction, ramp, civic`; `__game.demo` holds `{ cx, cz, STEP, HALF }`. Cameras that must stay out of buildings are placed over a road centre line (yaw 0 = camera on +Z of the target, yaw 90° = +X).

Zero console errors, all modules `ok`, fps within budget, and a screenshot you would be proud to put next to Cities: Skylines II.

## 8. Assets

Only **CC0** assets: Poly Haven (`node tools/assets/polyhaven.mjs <id> --res 1k --fmt jpg|hdr|gltf`), ambientCG (`node tools/assets/ambientcg.mjs Asphalt012 1K JPG`), Kenney, Quaternius, or procedurally generated. Every download appends to `public/assets/CREDITS.md`. Keep textures ≤ 2K, models ≤ 5 MB, total `public/assets` under ~250 MB. Load via `ctx.assets.loadTexture / loadPBR / loadGLTF / loadHDR`. Shared PBR sets live in `public/assets/shared/<name>/` — if a set you need already exists, reuse it.

## 9. Quality bar

The reference is **Cities: Skylines II**: photographic PBR materials with visible micro-detail, physically plausible sun/sky/shadows with soft contact shadows, atmospheric depth (fog, haze, sky gradient), night with thousands of warm window lights and street lighting, lively traffic, believable road geometry with markings, curbs, sidewalks and intersections, varied building silhouettes with rooftop detail, dense vegetation, subtle post effects (AO, bloom, colour grading) — never flat colours, never plastic-looking, never "programmer art".
