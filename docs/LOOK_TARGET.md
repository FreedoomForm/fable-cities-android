# LOOK_TARGET — measured colour & lighting targets

> **Measured 2026-09-02.** Numbers below were current then. Re-run the tool named in this file before relying on them.

Measured 2026-09-02 from the 12 CS2 JPEGs in `reference/` and from
`shots/look/ours_{downtown,skyline,waterfront,suburb}_13.png` (seed 7, 1280x720, HUD cropped to
y 8.5–86%). Targets = median of the four UI-free **daytime beauty frames** (cs2_02, 04, 11, 12);
cs2_09 golden hour, cs2_08/10 night, cs2_03/07 info-views — excluded. Y = linear Rec.709 luminance,
C = OKLab chroma. Reproduce with `python3 tools/lookmeasure.py`.

## Times of day the reference beauty frames use

**No reference beauty frame is shot at noon.** Cast shadows in cs2_04/11/12 run 1.5–2.5x object
height = **sun elevation 22–34°**; cs2_09 is golden hour (5–10°), cs2_08/10 night, cs2_06 overcast
winter. At our latitude 47.3° on 30 Apr that band is **hour 15.6–16.6 (or 7.4–8.4)**. Our shots run
at hour 13 = **elevation 55°, shadow 0.70x height** — literal noon. Beauty shots must default to
hour 16.0–16.5.

## Targets

| # | Metric (how) | CS2 target | Ours now | Delta | Owner |
|---|---|---|---|---|---|
| 1 | `lum_p10` (black floor) | **0.010** (0.007–0.017) | 0.158 | **16x too bright** | environment, effects |
| 2 | `okL_mean` mean OKLab lightness | **0.44** (0.42–0.50) | 0.70 | +0.26 | environment |
| 3 | Ground shadow depth: top-quartile Y ÷ bottom-quartile Y, below y=45% | **19.5** (6.8–31.2) | 4.4 | **4.4x too flat** | environment |
| 4 | Vegetation luminance | **0.056** (0.048–0.080) | 0.271 | **4.8x too bright** | props, terrain |
| 5 | Vegetation chroma / hue | **C 0.053, hue 74°** | C 0.064, hue 76° | C +21%, hue OK | props, terrain |
| 6 | Water luminance / chroma | **0.081 / C 0.028** | 0.301 / C 0.036 | **3.7x bright**, C +29% | terrain |
| 7 | Building luminance | **0.177** (0.135–0.316) | 0.490 | **2.8x too bright** | buildings |
| 8 | Building chroma / hue / HSV sat | **C 0.036, hue 41°, S 0.31** | C 0.012, hue 52°, S 0.06 | **3x too GREY** | buildings |
| 9 | Sky luminance / hue | **0.268 / 214°** | 0.423 / 209° | 1.6x too bright | environment |
| 10 | Asphalt luminance / chroma | **0.058 / C 0.008** | 0.104 / C 0.011 | 1.8x bright (closest) | roads |
| 11 | Haze: far-third ÷ near-third non-sky Y | **2.15** (1.44–4.10) | 1.20 | far field 1.8x too dark | environment |
| 12 | Haze: far ÷ near normalised contrast | **0.35–0.52** | 1.00–1.76 | **3x too crisp** | environment |
| 13 | Shadow coolness: median (B−R)/Y, shadow minus lit | **+0.45 … +2.0** (med 0.70) | +0.08 | **9x too neutral** | environment |
| 14 | Chroma at matched lightness (0.35<okL<0.75) | **0.048** (0.026–0.059) | 0.050 | **already on target** | — |

## What each target means in practice

**1, 2 — the real "over-saturated" cause.** Row 14 is the headline correction: at equal lightness
our pixels carry the *same* chroma as CS2. We are not over-saturating materials — we deliver every
colour at 3x the lightness with no black floor, and bright chroma reads as garish. Do **not**
globally desaturate. environment must drop the exposure/ambient key until `lum_p10` falls from
0.158 to ~0.01: cut hemisphere fill hard (now `HemisphereLight(…, 0.55)` with AgX exposure 0.96 at
55° sun) and let shadowed geometry actually go dark.

**3 — shadow depth.** 4.4:1 is overcast, not sunny; target 19:1. This is sun ÷ ambient intensity,
not shadow-map quality: raise the directional key, drop hemisphere/IBL fill. A low sun alone gets
it to 5.3 — worth doing, but only ~25% of the fix.

**4, 5 — vegetation.** Greens are 4.8x too bright at slightly high chroma — that pairing is what
reads as cartoon. Hue is already right (76° vs 74°). Cut foliage albedo ~3x, let exposure carry the
rest, and add per-instance albedo jitter. CS2 daytime foliage sits at Y≈0.05: near-black in
silhouette, colour only on sunlit tops.

**6 — water.** The loudest surface in our frames: turquoise at Y 0.30 where CS2 is Y 0.08 / C 0.028.
Darken the base colour ~3.5x, pull chroma to 0.028, and get brightness from specular glint and sky
reflection instead of albedo.

**7, 8 — buildings.** Two faults in opposite directions: façades are 2.8x too bright *and* 3x too
grey (C 0.012 vs 0.036, S 0.06 vs 0.31). CS2 façades are warm brick/render at hue ~41°. Buildings
need to be **darker and more colourful** — a warm palette (hue 30–55°, S 0.20–0.40) with mean
albedo dropped so lit walls land near Y 0.18.

**9, 10 — sky and asphalt.** Sky hue is right (209° vs 214°) but 1.6x too luminous, flattening
every silhouette against it; both fall out of the target-1 exposure fix. Asphalt is our closest
surface at 1.8x.

**11, 12 — atmospheric perspective.** We have effectively none. In CS2 the far third is 2.15x
*brighter* than the near third and carries only 35–52% of its local contrast: haze lifts distant
blacks toward sky colour. Ours is 1.20x at 100–176% — our mountains are crisper than our
foreground. Raise fog density and make the fog **lift blacks** (blend toward sky colour, don't
multiply), tinted at sky hue 214°.

**13 — cool shadow fill.** CS2 shadows are 0.45–2.0 units bluer per unit luminance than lit
surfaces; ours are 0.08 — key and fill are the same colour. Give the directional light a warm tint
(~hue 40°, matching CS2's lit hue 34–47°) and the hemisphere term a distinctly cool one (~214°).
The warm/cool split then appears without touching material saturation.
