# demo → core / other modules

Round 1. `src/demo/DemoCity.js` was rebuilt as a coastal city laid out in a local frame aligned to the
shoreline the site picker finds (`+v` out to sea, `+u` along the shore). **Nothing in core was needed
and nothing in core, `main.js` or another module's folder was touched.**

## To core — nothing required

Everything the demo needs already exists: `events.mute`, `engine.frame`, `world.rng.fork`,
`world.toCell/cellCenter/inBounds`, `__game.presets`. Two small conveniences, both worked around:

* **`presets` entries carry only camera fields.** `night_downtown` wants a time of day as well, so the
  demo wraps `__game.setCamera` at runtime and applies an optional `view.hour` (skipped when the URL
  has an explicit `?time=`, and any later `setTime` still wins, so `tools/shot.mjs --time` is
  unaffected). If core ever formalises `preset.hour`, the wrapper can go.
* **`tools/shot.mjs` has no way to dump a module's own console line.** Not blocking; verified with a
  local puppeteer probe instead.

## To zoning — two behaviours worth documenting (no change requested)

1. **`paint(cells, type)` is keyed by world cell, but zoning cells are 8 m quads rotated onto the road
   frame.** When the road grid is not axis-aligned (this demo rotates the whole city to the coast),
   painting "every world cell whose centre lies in my block quad" silently drops ~⅓ of the cells,
   because their centroids land in the neighbouring world cell. The demo now walks
   `cellsInRect(-half,-half,half,half)` and classifies each cell by its own centroid from `cellAt()`
   — coverage went from 0.46 to 0.70 and lots from 168 to 484 with the same roads. A
   `paintPolygon(points, type)` (or having `paint` accept world points) would make this a non-trap.
2. **A column whose kerb cell (`k = 0`) is unpainted is discarded entirely** (`rebuildLots` starts the
   depth run at `fr.cells[i*DEPTH]`). That is a sensible rule, but it means a 1-cell paint error at
   the kerb costs the whole 4-cell column. Worth a line in the ZoneGrid header comment.

Also: block pitch matters a lot for lot size. At 76 m almost every frontage column is inside a
junction corner, so lots come out 2 cells deep and `apartment()`'s `maxF = 3 + w*d/70` caps the towers
short. 88 m pitch gives ~5 full-depth columns per edge and roughly doubles residents per lot; that is
what the demo uses.

## To roads — road geometry is the demo city's biggest cost

At `?seed=7`, quality=high, `city` preset: **2541 draw calls / 11.5 M triangles**, against the §3
budget of 2500 / 8 M. Isolating scene groups (hiding one group at a time and re-reading
`__game.stats()`):

| group | draw calls | triangles |
|---|---|---|
| roads | 704 | 6.02 M |
| terrain-chunks | 476 | 3.05 M |
| buildings (61 instanced pools) | 565 | 1.76 M |
| service-buildings (22–27 buildings) | 524 | 1.30 M |
| vegetation | 255 | 0.40 M |
| props | 171 | 0.20 M |

~21 km of road costs 6 M triangles (≈ 290 tris/m, accumulated over 4 shadow cascades + GTAO +
reflection + main). A **distance LOD for the road mesh** — dropping kerb profiles, lane markings,
crosswalk stripes and guard-rail posts past ~300 m, and skipping the median/barrier extrusions in the
shadow cascades — would recover most of the overage on its own. The motorway is the worst offender per
metre (32 m of asphalt plus a Jersey barrier and posts at 4 m spacing); the demo already keeps it to
~1.4 km for this reason.

## To simulation — service buildings are unbatched

22–27 service buildings cost **524 draw calls** (≈ 24 calls each) and 1.3 M triangles. Merging each
type's static parts into one geometry, or instancing across buildings of the same type, would take
~400 calls off any city view. The demo had to cut four otherwise-useful stations to stay near budget,
which costs coverage: for a 16 k city, `capacity` (police/fire 4500, health 4000, education 3000)
implies ~30 buildings, and `radius` (fire 380 m, education 360 m) implies more still, so happiness
sits at 0.64 instead of ~0.75.

`services.api.place()` refuses anything overlapping a building, so the demo reserves each heavy
utility a disc that its zoning field leaves unzoned and places them before growth. That works; a
`place(..., { bulldoze: true })` is not needed.

## To environment — hard-edged cloud shadow

At `?seed=7&time=13` the `suburb` preset shows a **razor-sharp straight boundary** across the frame
with everything on one side ~25 % darker (`shots/demo/v6_suburb_13.png`, `shots/demo/v5_suburb_13.png`).
It is gone at `time=16` (`shots/demo/shadowtest_suburb_16.png`), so it moves with the cloud
modulation, not with a cascade split. The `uSunModulation` texture looks like it is being sampled
past its edge (clamp/wrap on the projected UV) rather than fading out. Worth a look — it lands in the
middle of demo-city screenshots.

## To terrain — two artefacts visible from the demo cameras

* Pale chalk-white fall-line streaks on the open hillsides behind the suburbs
  (`shots/demo/p3r1c_suburb_13.png`, upper third) — already on your open-issue list.
* `?seed=3`: a flat-topped bright-green mesa on the coastal ridge north-east of the city
  (`shots/demo/seed3_skyline_13.png`, top right) reads as an untextured plateau cap.

---

## Integrator round 5 (2026-09-02) — demo-city preset fix

Two of the six generic presets put the camera **inside a street tree**: at seed 7 / 17:33 both
`street` (distance 82, pitch 7° ⇒ camera 10 m up) and `closeup` (distance 46, pitch 13° ⇒ 10 m up)
rendered a wall of black leaf cards (`shots/integration/base_street_17h5.png`,
`p4a_closeup_17h5.png`). Fixed in `src/demo/DemoCity.js`:

* `street` → `{ target: T(0, CORE_V + 150), distance: 165, yaw: INLAND, pitch: 11° }` — the same
  avenue-spine line `night_downtown` uses, camera ~31 m up, looking down the corridor to the bay
  (`shots/integration/p4_street_17h5.png`).
* `closeup` → `{ distance: 62, pitch: 22° }` — same target, camera lifted clear of the canopy
  (`shots/integration/ao_on.png`).

Anything that frames a camera below ~15 m needs to be checked against the street trees, not just
against the buildings. The `Cameras that must stay out of buildings are placed over a road centre
line` note now needs "and above the canopy" added to it.

The presets `downtown_golden`, `street_level` and `downtown_night` named in the round-5 brief do not
exist; the fallback `city, street, aerial` was used. If those names are wanted as first-class beauty
cameras, the demo builder should add them (`downtown` and `night_downtown` are the closest).

---

## demo round 2 (2026-09-02) — press kit, ground treatment, infrastructure

The demo now owns four extra layers of its own (`src/demo/DistrictGround.js`, `Landmarks.js`,
`Infrastructure.js`, `presets.js`, with shared helpers in `gfx.js` / `cars.js` / `facadeTex.js`).
The eight press presets asked for in the brief exist: `downtown_golden, downtown_night,
street_level, waterfront_dusk, skyline_dawn, suburb_evening, industrial_dusk, aerial`, each with its
own `hour`. Nothing in core, `main.js` or another module's folder was touched.

### To core — nothing required

### To roads — two things the demo had to work around

1. **No elevated geometry.** `roads.build()` conforms every carriageway to the terrain, so a bridge,
   a viaduct or a flyover is impossible through the public API. The demo gets the motorway off the
   flat by shaping the ground *first* (`terrain.api.conformPath` with `y = ground + 6 m` along the
   mainline, before the road is built) and builds its own rail viaduct as demo geometry. Real grade
   separation for drivable roads needs a `build(points, type, { elevation })` (or a bridge type that
   ignores the terrain and emits piers).
2. **`segment.points` is the only lane-side geometry a decorator can read.** Guardrails, gantries
   and lighting masts are placed by walking `seg.points` and offsetting by `cwHalf + 1.5`. A
   `sampleEdge(segmentId, t, side)` result for a *sampled polyline* (rather than per-t) would make
   this cheaper and let props/effects decorate motorways the same way.

### To zoning — lot yield is what decides the demo's population

The spec's 15–30k population is really a lot-count spec. Measured at quality=high, seed by seed:

| seed | lots | residential capacity | population |
|---|---|---|---|
| 7 | 546 | 24.5k | 22.3k |
| 42 | 528 | 21k | 19.3k |
| 12 | 514 | 19.3k | 16.5k |
| 3 | 478 | 20.3k | 13.6k |
| 1 | 293 | 8.3k | 8.0k |
| 101 | 208 | 4.7k | 4.1k |

With ~500 lots the city is comfortably in spec; below ~350 it cannot be, because every residential
building is already at level 5 (the demo's `topUp()` verifies this: on seed 1 it can only lift
capacity from 8,244 to 8,343). Two zoning behaviours drive the spread, and neither is visible from
outside:

* `stats().coverage` (lotCells / zonedCells) runs 0.74 on a good site and 0.52 on a poor one, with
  `unlotByK[0]` in the hundreds — i.e. whole frontage columns discarded at the kerb cell. A poor
  site is not markedly wetter, steeper or more clipped than a good one (measured: 84/84 blocks in
  bounds and dry on both), so the loss is in frame conflict resolution, not in the terrain.
* Land-use **patch size** matters more than the mix. Moving the outskirts field from 104 m patches
  to 224 m raised seed 42 from 8.6k to 19.3k residents on identical roads, purely because fewer
  frontage columns straddle a type boundary.

A `paintPolygon(points, type)` and a per-frontage report (`why was this column dropped`) would let
the demo aim at the coverage number instead of guessing.

### To buildings — capacity per lot

`setLevel(id, 5)` on a 2-cell-deep lot yields ~25 residents; on a 4-cell-deep lot ~60. Since
`apartment()` caps floors at `3 + w*d/70`, a city of shallow lots is capacity-bound no matter how
long it is simulated. If `res-high` could go taller on a small footprint (or a `density` multiplier
existed), the demo could hit the population spec on any site.

### To simulation — occupancy is jobs-bound

Converting the office and `com-high` blocks to housing on a short seed (to buy capacity) *reduced*
the population from 8.0k to 3.1k: the jobs disappeared and the occupancy model emptied the flats
faster than the new capacity filled. Any future "make this city bigger" lever has to add homes and
jobs together.
