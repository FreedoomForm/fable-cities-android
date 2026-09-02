# Blind comparison — verdicts from run wf_040bfb0b-ab3

Four judges each saw one of our frames and one real Cities: Skylines II frame, labelled only A and B,
order shuffled, with no indication which game either came from.

**Result: we lost all 4 pairs.**

| Pair | Our frame | Our score | Reference score |
|:--|:--|--:|--:|
| 1 | `p3_skyline_13.png` | 5.5 | 8.5 |
| 2 | `p3_downtown_21.png` | 5 | 8 |
| 3 | `p3_waterfront_13.png` | 5 | 8 |
| 4 | `p3_suburb_13.png` | 3.6 | 8.4 |

## What the judges said

### Pair 1 — ours 5.5 vs reference 8.5

Image B is unambiguously the stronger render despite being a cluttered tool-mode screenshot rather than a beauty shot: its asphalt carries real aggregate grain, tire-wear darkening in the wheel paths, worn lane decals and a painted route number, and its grass, shrubs and autumn canopies vary in hue and silhouette tree-to-tree. B also has genuine directional lighting — long soft-edged tree and vehicle shadows, a large off-screen building shadow raking across the lower frame, contact shadows under every car, and ambient occlusion tucked under guardrails and curbs — so surfaces read as three-dimensional. Detail density and scale are also correct in B: lane widths, curb radii, sidewalks, streetlights, traffic signals and distinct vehicle models (truck-and-trailer, vans, sedans) all sit at believable relative sizes. Image A composes a pleasant establishing shot with credible aerial haze, layered mountain silhouettes and decent volumetric clouds, and its HUD is clean and legible, but the render underneath is flat. A's sun direction is barely readable — building facades are lit almost identically, cast shadows are near-absent and there is no base AO, so the downtown reads as a carpet of boxes rather than massing; the towers and mid-rises are visibly cloned with near-identical silhouettes and blank facades, roofs have no clutter, and roads are empty of traffic so there are no scale cues. A's water is its worst material: a flat cyan noise field with no sky reflection, no sun glint, no depth gradient and no shore foam or wet-sand band, and it occupies roughly the bottom third of the frame, which both wastes the composition and puts the weakest asset in the most prominent position. A also shows edge shimmer on distant rooflines and a soft, low-frequency terrain splat with an obvious cutout seam where the mountains meet the sky. B's only real deductions are self-inflicted rather than technical — heavy UI occlusion, a garish flat purple zoning overlay plane, and a close-range framing that leaves no atmospheric depth to evaluate.

**What would close the gap:**

- Enable a real sun with cast shadows: long directional building shadows falling across streets and onto neighboring blocks, plus contact AO at every building base, so massing reads volumetrically instead of as a flat carpet of boxes.
- Rebuild the water shader — sky and terrain reflections (SSR or planar), a sun specular glint lobe, multi-scale animated normal maps, depth-based shallow-to-deep color ramp, and shoreline foam with a wet-sand darkening band replacing the current hard uniform beach line.
- Add ground-level population and clutter: moving vehicles with contact shadows on the road network, streetlights, signage, lane markings, sidewalks, parking lots, and rooftop HVAC/antennas/water tanks so roofs and streets stop reading as blank planes.
- Break asset repetition in the building set — vary facade window grids, balconies, ground-floor retail, setbacks, roof heights and per-instance albedo/dirt masks so the white mid-rises no longer read as visible clones.
- Upgrade terrain materials to a multi-layer splat with per-layer normal and roughness maps plus macro-variation noise to kill tiling, and give the mountains proper cliff/scree shading and a treeline-to-rock transition instead of uniform saturated green.
- Fix the image pipeline: TAA or higher-quality AA to remove the shimmer on distant rooflines and thin edges, add SSAO, subtle bloom on glass, and a tone curve with more contrast and less washed-out midtone.
- Recompose the shot — push in or raise the camera so the empty lower third of open water is replaced by waterfront content (piers, docks, boats, promenade), and add a foreground element to establish a near/mid/far depth layering.
- Populate roads and plazas with vehicles and pedestrian-scale props so the viewer can size the towers against something known; right now nothing in frame establishes absolute scale.

### Pair 2 — ours 5 vs reference 8

A is a high-altitude data/info-view shot, so it deliberately drains color from the world, yet at 3x zoom it still shows an order of magnitude more simulated substance than B: individually varied building footprints and rooflines, highway interchanges with correct ramp geometry, rail yards, piers and waterfront terracing, parking lots resolved down to individual cars, street trees, park paths, and terrain with genuine erosion relief and forest canopy that reads as thousands of distinct trees rather than a texture. Its scale hierarchy is convincing — downtown towers, mid-rise transition, then a suburban grid of correctly-sized single-family lots — and it is essentially artifact-free apart from JPEG compression, with soft AO and contact shadows grounding every mass. B has real strengths and is not a weak image in isolation: the night mood is coherent, the warm streetlight pools and red aircraft-warning beacons on the antennas are a nice touch, the mid-rise and residential band on the right has properly scaled window grids, rooftop AC units, a helipad, tree cover and parked cars, and the UI is clean and modern. But its downtown core is where a AAA shot has to sell itself and it does not: the towers are stacked boxes with hard unbevelled corners, no cornices or setback variation, and only three or four repeating archetypes, and their emissive "windows" are enormous quads spanning what would be two or three floors, which quietly breaks the scale read of the whole skyline. Materials are flat matte dark blue-grey with no specular, no mullion depth, no glass reflectivity, and the lit windows emit no bounce onto neighbouring facades or the ground — the emission is a texture, not a light. The water is the single biggest miss: a near-black flat plane that reflects none of the lit skyline sitting directly on it, with a hard horizon seam, a lighter banding strip above it, no shoreline foam or wet transition, and buildings that terminate straight into it with no seawall or dock. The sky is a plain vertical gradient with two blurred cloud smears and no stars, moon, or horizon scattering, and there is no distance haze, so far towers sit at the same contrast as near ones and the image has almost no depth cueing. Add a large untextured green field dropped in the middle of the downtown core, sparse traffic for a claimed 16k population, and aliased single-pixel antennas at a 1280x720 native render versus A's 1920x1080, and the gap is clear even accounting for A's abstracted presentation.

**What would close the gap:**

- Give the water a real surface: screen-space or planar reflections of the lit skyline, an animated normal map for ripple breakup, depth-based color falloff from shore to deep, and shoreline foam plus a wet-sand/seawall transition instead of buildings meeting a flat black plane
- Fix the horizon: remove the hard seam and the lighter banding strip between water and sky, and blend them with atmospheric scattering so the two share a gradient
- Rebuild the tower facade shaders — reduce window cell size to one-floor height on a consistent per-building floor grid, add mullion/spandrel geometric depth, and give the glass a specular/roughness response so it catches moonlight and neighbouring window light
- Make the window emission actually light the world: bloom spill onto adjacent facades, a faint emissive bounce onto streets and rooftops below, and per-window color temperature variation instead of a uniform warm-white decal
- Add exponential height fog / distance haze so far towers desaturate and lose contrast, restoring depth separation between foreground, midground and the far shore
- Increase tower variety: more silhouette archetypes, setbacks, crowns, spires, podium bases, varied footprint sizes and rotations, so the skyline stops reading as four repeated meshes
- Detail the ground plane in the core: replace the bare green field with plazas, sidewalks with curbs, parking, signage, awnings, and street-level props; raise traffic and pedestrian density to match the stated population
- Render at 1920x1080 with TAA/MSAA so the thin antennas and building edges stop aliasing into single-pixel stairsteps
- Introduce terrain elevation and material variation — the current site is a perfectly flat pad with a uniform flat-green grass texture and no ground texture blending near roads or water
- Add rooftop and mid-block detail to the low-rises: currently several roofs are flat untextured planes, and the rooftop sign decals read as floating unlit quads

### Pair 3 — ours 5 vs reference 8

Image B is clearly the more convincing AAA product, and the gap is widest exactly where it matters most: lighting and materials. B has a low-angle directional sun producing long, correctly-shaped shadows, a large soft off-screen occluder shadow sweeping the lower-left that instantly reads as real depth, cool sky-fill bounce inside those shadows, and firm contact shadows grounding every vehicle; its car paint has clearcoat specular, its glass is tinted and reflective, its chrome and tires read as distinct materials, and the asphalt carries genuine grain with scuffed, perspective-correct lane paint. Image A, by contrast, is lit by a flat noon ambient with almost no cast shadows at all, so buildings, trees and cars appear pasted onto the ground rather than sitting on it, and the absence of any AO or contact darkening flattens the whole vista. A's surfaces are the weakest element: the terrain is a large uniform untextured green with no macro variation or decals, the sand is a smooth gradient with no wet line or surf foam, and most buildings are plain white boxes with decal-like window strips and no facade PBR detail. A's water is a painted-looking gradient plane with no wave normals, no skyline reflection and a hard shoreline seam, and the tree clumps show crunchy alpha-test shimmer and a single lime hue. A is also rendered at 1280x720 with visible stairstep aliasing on every building edge and thin railing, where B is a clean 1080p frame with only mild aliasing on distant parking lines. To be fair to A, it attempts a far harder shot — a full coastal city vista with a genuinely good cloud bank, a strong diagonal coastline leading line and a coherent road network — while B is at a near-macro zoom where detail is cheap to achieve; B also has real compositional weaknesses, with the info panel eating the top-left quadrant, a lot of dead asphalt in the lower right, and a noticeably simple low-poly pedestrian. Even discounting for that, B's physical plausibility and per-pixel material honesty put it well ahead, whereas A's flat lighting and untextured ground are the classic tells of a pre-AAA render.

**What would close the gap:**

- Add real sun shadows: cascaded shadow maps with the sun dropped to a 25-40 degree angle so every building, tree, streetlight and car throws a long, readable shadow onto the ground plane — currently image A is effectively shadowless, which is its single biggest realism deficit.
- Layer in SSAO/contact shadows and a distance-scaled AO term so objects darken where they meet the terrain, roads and each other, instead of appearing pasted on.
- Texture the terrain: multi-layer ground materials (grass, dirt, gravel, sidewalk) with detail normal maps and low-frequency macro-variation noise to break up the uniform flat green, plus wear/path/driveway-apron decals at building and road edges.
- Rebuild the water: animated wave normal maps, screen-space reflections of the skyline and shoreline, depth-based absorption/transmission near the beach, and a foam/surf band with a wet-sand darkening strip so the land-water intersection is no longer a hard geometric seam.
- Upgrade building materials to real PBR facades — brick, precast concrete panel, curtain wall with per-floor reflection variance — with recessed window frames and mullions that have actual geometric depth, plus roof clutter (vents, ducts, parapets, railings) and varied albedo so the district is not a field of white boxes.
- Render at 1920x1080 or higher with TAA or MSAA plus proper mip/LOD bias on foliage to eliminate the edge stairstepping and the crunchy alpha-test shimmer on the tree canopies.
- Add aerial perspective: distance haze that desaturates and lifts the far skyline and background mountains, plus a filmic tonemap with modest bloom, to build the atmospheric depth the flat noon exposure currently lacks.
- Increase detail density at street level — pedestrians on sidewalks, parked cars, more vehicle variety, bus stops, signage, awnings, benches, trash bins — so the city reads as inhabited rather than as empty massing.
- Diversify the vegetation with several tree species at varied heights, hues and ages, with proper LOD/impostor cross-fade, to break up the blobby single-tone clumps.
- Fix the framing: the large clipped grey rooftop in the foreground collides with the bottom toolbar and dead-ends the composition — raise or tilt the camera so the near ground plane stays legible and the leading line into the coast is uninterrupted.

### Pair 4 — ours 3.6 vs reference 8.4

Image A is a wet-night street-level shot that does almost everything a AAA city-builder beauty frame needs: layered emissive sources (traffic signal, neon storefronts, street lamps, thousands of individually-lit windows) that spill and bloom onto surrounding geometry, a road with genuine specular wetness carrying colored light smears from the police bar and the neon, and rain streaks plus a soft blue night haze that give the corridor real atmospheric depth from foreground signal head to the vanishing point. Detail density is high and stratified — motorcycle, bench, wayfinding signs, storefront awnings, pedestrians with a dog, varied vehicle silhouettes — and the perspective composition uses the receding facades and the road as strong leading lines with a believable human-scale relationship between signal head, cars and people. Its flaws are real but minor: the foreground signal housing reads waxy with an odd uniform orange wash, some facade window strips repeat visibly, the rain is a flat uniform overlay rather than depth-aware, and pedestrian shading is simple. Image B is a daytime oblique suburban view that reads as an early prototype: the terrain is a single near-uniform green with no ground clutter, no blade detail, no path or dirt variation, and the water is a flat blue gradient with no shoreline foam or wave normal. Buildings are untextured boxes with painted-on rectangular windows, no material differentiation between siding, roof and trim, no roof furniture, no decals or grime, and the distant skyline is a cluster of gray blocks; lighting is broadly ambient with weak, low-contrast shadows and no contact/ambient occlusion grounding, so nothing sits in the world. Scale is also off — the trees dwarf the houses, the foreground house presents large blank walls with six identical undersized windows, and vehicles read small against very wide carriageways — and edges on roofs, poles and lane markings show clear aliasing. B's HUD is clean and legible and its camera angle is a legitimate builder viewpoint, but even accounting for the greater camera distance, an AAA aerial frame would still carry roof detail, facade variety and ground dressing that are entirely absent here.

**What would close the gap:**

- Replace flat-color building shells with PBR facade materials: albedo + normal + roughness for siding, brick, stucco and shingle, plus per-instance color/material variation so identical meshes do not read as clones
- Add real window geometry and shading — recessed frames, glass with reflection/fresnel and a subtle interior parallax or cubemap — instead of painted rectangles on a flat wall
- Break up the terrain: multi-layer splat-mapped grass/dirt/gravel with macro variation and a detail normal at close range, plus scattered ground meshes (grass tufts, shrubs, rocks, driveways, garden beds, fences) so the lawn is not one uniform green
- Add contact shadows and ambient occlusion so buildings, trees, poles and cars are grounded; sharpen and darken the sun shadows and give the sun a definite direction rather than broad ambient fill
- Introduce atmospheric depth: aerial perspective/fog ramp with distance, a warmer sun-side and cooler shadow-side color split, and a proper sky-to-horizon gradient instead of a flat cloud plate
- Fix scale relationships — shrink tree canopies relative to two-story houses, increase window count/size on the foreground house, and re-check vehicle-to-lane-width ratio
- Upgrade the water: animated normal map, shoreline foam and wet-sand transition, depth-based color falloff and specular sun glint
- Add prop and decal density at the scale the camera shows — mailboxes, driveways with parked cars, trash bins, hedges, road grime, tire wear, patch decals, crosswalk wear, curb cuts and driveway aprons
- Enable proper anti-aliasing (TAA or high-quality MSAA/FXAA+sharpen) to kill the stair-stepping on roof ridges, poles and lane markings, and add mip/LOD tuning so distant geometry does not shimmer
- Give roofs real material and detail — shingle/tile normal, ridge caps, gutters, vents, chimneys, HVAC on the larger blocks — since roofs dominate this camera angle
- Replace the distant gray block skyline with LOD proxies that retain facade color, window banding and silhouette variety
- Add a subtle post stack: mild bloom on bright roofs/water, slight vignette, filmic tonemapping and color grading to lift the image out of flat sRGB

## The systemic defects, ranked by how often the judges named them

1. **Materials are flat.** Facades are untextured colour fields with painted-on window bands.
   Asphalt has no aggregate grain, no tyre-wear darkening in the wheel paths, no worn decals.
   Every judge named this first.
2. **Lighting is flat.** Frames are lit by a high noon sun: no long soft-edged shadows, no contact
   shadows under vehicles and props, no ambient occlusion tucked under kerbs and guardrails,
   no cool sky-fill bounce inside shadows. Surfaces therefore do not read as three-dimensional.
3. **Density is too low.** A 16,000-citizen city runs under ten vehicles at noon and shows no
   headlight or taillight trails at night. Ground cover is one flat green with no undergrowth.
4. **Variety is too low.** Downtown repeats one tower silhouette about forty times. Reference
   frames show individually varied footprints, rooflines, and vehicle types.
5. **Ground treatment is wrong.** Dense blocks sit on bright saturated lawn instead of paving,
   so aerials read as "buildings on a golf course".
6. **Colour is oversaturated.** Meadows and water run two to four times the saturation of the
   reference, with no atmospheric desaturation towards the horizon.

## Process note

Three of the four frames we submitted were daytime wide shots. The reference frames were
street-level, golden-hour and wet-night beauty frames. Comparing a plain noon overview against a
curated press shot loses on composition before materials are even considered. Future passes must
submit our strongest frames: low sun, night, street level, weather.
