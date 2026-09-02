# Shared asset library — `public/assets/shared/`

All assets are **CC0** (ambientCG / Poly Haven). Reuse these before fetching anything new.
Load with `ctx.assets.loadPBR({ map, normalMap, roughnessMap, aoMap, displacementMap, ... })` using explicit URLs
(`/assets/shared/<set>/<file>`), `ctx.assets.loadGLTF('/assets/shared/models/<id>/<id>_1k.gltf')`,
`ctx.assets.loadHDR('/assets/shared/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr')`.
All textures are 1K JPG, tileable, OpenGL-convention normals (Y+). Every folder has `info.json` (id, source, license).

## PBR texture sets

Slots: **map** = base colour · **normal** · **rough** · **ao** · **disp** (displacement/height) · extra slots noted.
Two file-naming families exist (legacy sets from earlier modules were kept as-is):
`albedo/normal/roughness/ao/displacement.jpg`, `color/normal/roughness/ao/displacement.jpg`, and Poly Haven `Diffuse/nor_gl/arm(AO=R,rough=G,metal=B)/Displacement.jpg`.

| Folder | Source | map | normal | rough | ao | disp | extra | Intended use |
|---|---|---|---|---|---|---|---|---|
| `asphalt/` | ambientCG Asphalt010 | albedo.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | | roads — dark fresh asphalt |
| `asphalt_light/` | ambientCG Asphalt031 | albedo.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | roads — worn, lighter asphalt (old streets, parking) |
| `concrete/` | ambientCG Concrete034 | albedo.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | | curbs, sidewalks, bridge piers, plain facades |
| `concrete034/` | ambientCG Concrete034 | color.jpg | normalgl.jpg | roughness.jpg | – | – | | (duplicate of `concrete/`, legacy naming) |
| `concrete_wall_008/` | Poly Haven concrete_wall_008 | Diffuse.jpg | nor_gl.jpg | arm.jpg (G) | arm.jpg (R) | Displacement.jpg | metal=arm B | rough cast-concrete walls, retaining walls, brutalist buildings |
| `paving_slabs/` | ambientCG PavingStones070 | albedo.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | sidewalks, plazas (large grey slabs) |
| `paving_cobble/` | ambientCG PavingStones128 | albedo.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | old-town streets, pedestrian zones (cobblestones) |
| `bricks_red/` | ambientCG Bricks059 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | facades — classic red brick |
| `bricks_yellow/` | ambientCG Bricks075A | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | facades — beige/yellow brick |
| `bricks_white/` | ambientCG Bricks060 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | facades — light/whitewashed brick |
| `plaster_modern/` | ambientCG Plaster001 | color.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | | facades — clean matte outdoor plaster (tint via material.color) |
| `plaster_rough/` | ambientCG Plaster003 | color.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | | facades — rough white render/stucco |
| `plaster_painted/` | ambientCG PaintedPlaster017 | color.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | | facades — painted plaster, residential |
| `facade_glass/` | ambientCG Facade001 | color.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | metalness.jpg | curtain wall / office glass facade (day) |
| `facade_glass_night/` | ambientCG Facade009 | color.jpg | normal.jpg | roughness.jpg | – | displacement.jpg | metalness.jpg, emission.jpg | glass facade with lit windows — use emission for night |
| `roof_tiles_clay/` | ambientCG RoofingTiles013A | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | opacity.jpg (edge mask, usually ignore) | pitched roofs — terracotta tiles |
| `roof_tiles_clay_b/` | ambientCG RoofingTiles014A | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | opacity.jpg | pitched roofs — second clay tile pattern |
| `corrugatedsteel005/` | ambientCG CorrugatedSteel005 | color.jpg | normalgl.jpg | roughness.jpg | ambientocclusion.jpg | – | metalness.jpg | industrial roofs, sheds, warehouses |
| `metalplates006/` | ambientCG MetalPlates006 | color.jpg | normalgl.jpg | roughness.jpg | – | – | metalness.jpg | industrial props, containers, rooftop machinery |
| `grass/` | ambientCG Grass004 | albedo.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | terrain — lush lawn/park grass |
| `Grass004/` | ambientCG Grass004 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | (duplicate of `grass/`, legacy naming) |
| `Grass003/` | ambientCG Grass003 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — second grass variant (meadow) |
| `aerial_grass_rock/` | Poly Haven aerial_grass_rock | Diffuse.jpg | nor_gl.jpg | arm.jpg (G) | arm.jpg (R) | Displacement.jpg | | terrain — distant/aerial grass with rock, hillsides |
| `Ground033/` | ambientCG Ground033 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — light dry sandy dirt |
| `Ground048/` | ambientCG Ground048 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — dry ground / dirt (dry grass zones, lots) |
| `Ground054/` | ambientCG Ground054 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — beach/mud/sand transition |
| `forest_floor/` | ambientCG Ground038 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | terrain — forest floor (leaves, branches, dirt) under trees |
| `sand/` | ambientCG Ground055S | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | terrain — clean beach sand |
| `Rock030/` | ambientCG Rock030 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — cliffs / steep slopes (grey rock) |
| `Rock035/` | ambientCG Rock035 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | terrain — second rock variant |
| `wood_planks/` | ambientCG Planks021 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | displacement.jpg | | decks, piers, fences, benches, construction sites |
| `Bark012/` | ambientCG Bark012 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | tree trunks (procedural trees) |
| `Bark014/` | ambientCG Bark014 | color.jpg | normal.jpg | roughness.jpg | ao.jpg | – | | tree trunks — fir/pine bark |

Gravel: `public/assets/simulation/tex/Gravel022/` (ambientCG Gravel022, owned by the simulation module — read-only for others; Color/NormalGL/Roughness.jpg). Additional bricks/facade there: `Bricks051`, `Facade006`.

## HDRI — `hdri/`

| File | Source | Use |
|---|---|---|
| `kloofendal_48d_partly_cloudy_puresky_1k.hdr` | Poly Haven kloofendal_48d_partly_cloudy_puresky (1k, Radiance HDR) | daytime partly-cloudy sky: environment/IBL via `ctx.assets.pmrem()`, sky background |

## glTF models — `models/<id>/<id>_1k.gltf` (+ `.bin`, `textures/*.jpg`, 1k textures, real-world metres, Y-up)

| Id | Size | Use |
|---|---|---|
| `street_lamp_01` | 3 MB | modern street lamp (roads/environment, night lighting anchor) |
| `street_lamp_02` | 2 MB | classic/ornate street lamp (old town, parks) |
| `painted_wooden_bench` | 2 MB | park bench |
| `modular_street_seating` | 8 MB | modern concrete/wood street seating (plazas) |
| `metal_trash_can` | 5 MB | public trash can |
| `trashbag` | 2 MB | garbage bag prop (alleys, collection) |
| `fire_hydrant` | 6 MB | fire hydrant (sidewalk detail) |
| `concrete_road_barrier` | 4 MB | jersey barrier (roadworks, construction sites) |
| `modular_chainlink_fence` | 7 MB | chain-link fence segment (industrial, lots) |
| `planter_box_01` | 3 MB | street planter box (plazas) |
| `potted_plant_01` | 7 MB | potted plant (storefronts, balconies) |
| `wild_rooibos_bush` | 3 MB | shrub/bush (parks, gardens, medians) |
| `covered_car` | 3 MB | tarp-covered parked car (parking lots, driveways) |

Not available as CC0 on Poly Haven at a usable size: traffic cones (none), trees (`fir_tree_01`, `pine_tree_01`, `jacaranda_tree`, `island_tree_01`, `tree_small_02` are 64–914 MB even at 1k → skipped; build trees procedurally with `Bark012/Bark014`). Vehicles: Kenney Car Kit GLBs live in `public/assets/simulation/models/` (CC0).

## License

Everything in this folder is CC0 1.0 (public domain) — ambientCG (https://ambientcg.com) and Poly Haven (https://polyhaven.com). Per-asset source URLs are in each `info.json` and in `public/assets/CREDITS.md`. No attribution required, but keep CREDITS.md updated.
