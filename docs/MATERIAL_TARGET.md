# Material response targets

> **Measured 2026-09-02.** Numbers below were current then. Re-run the tool named in this file before relying on them.

## The diagnosis

Measured live with `node tools/matstats.mjs` at hour 17.5, seed 7:

```
materials: 235  ·  roughness p10 0.38  median 0.90  p90 1.00
buckets:  <0.2 (mirror/glass): 8   0.2-0.4 (paint/wet): 16   0.4-0.7 (semi-gloss): 59   >=0.7 (matte): 152
clearcoat > 0: 1 material in the entire scene
scene environmentIntensity: 0.52
```

**65% of every material in the game is roughness ≥ 0.7, which is chalk.** A surface that rough samples the
environment map as an almost uniform blur, so the PMREM probe contributes nothing and there is effectively no
specular response anywhere in the frame. Exactly one material in the scene has a clearcoat lobe.

This single fact explains every blind-comparison verdict we lost:

| What the judge wrote | What it measures as |
|:--|:--|
| "car paint carries a real clearcoat lobe with sharp specular streaks" (reference) | our vehicle paint: no clearcoat, roughness too high |
| "glass is dark and reflective" (reference) | our glass: roughness 0.9 or a black card |
| "it is raining hard and the asphalt is a matte pale-tan surface with zero specular reflection" (ours) | wet asphalt roughness unchanged from dry |
| "every shadow is soft-edged with correct contact darkening under the wheels, so nothing floats" (reference) | no grounding specular or contact response |

Diffuse albedo work is now largely done and measuring on target. **Specular response is the whole remaining gap.**

## Targets

Set the BASE value; a roughness map should vary around it, not replace it. `envMapIntensity` 1.0 unless noted.

| Surface | roughness | metalness | clearcoat / ccRoughness | notes |
|:--|:--|:--|:--|:--|
| Vehicle body paint | 0.30 | 0.0 | **1.0 / 0.05** | the clearcoat is what makes car paint read as car paint |
| Vehicle glass | 0.06 | 0.0 | – | dark tint, must reflect sky; never body-coloured |
| Chrome / trim | 0.15 | 1.0 | – | |
| Tyres | 0.90 | 0.0 | – | correctly matte, leave alone |
| Headlight / taillight lens | 0.10 | 0.0 | – | emissive plus a real specular |
| Curtain wall / office glass | 0.05 | 0.0 | – | floor the specular at 8-15% of sky luminance so a vertical pane lands Y 0.04-0.12 at 17:30 with a top-to-bottom gradient |
| Punched window glass | 0.10 | 0.0 | – | never an opaque black card in a white frame |
| Solar panels | 0.10 | 0.0 | – | |
| Metal roof, corrugated, ducting | 0.45 | 0.95 | – | |
| Dry asphalt | 0.65 | 0.0 | – | currently 0.85-0.96 |
| **Wet asphalt** | **0.20** | 0.0 | – | plus albedo × 0.55; drive from `engine.globalUniforms.uWetness` |
| **Puddle** | **0.06** | 0.0 | – | must mirror lights and buildings |
| Road markings, painted | 0.55 | 0.0 | – | slightly glossier than the asphalt around them |
| Kerb, sidewalk, concrete | 0.80 | 0.0 | – | |
| Cobble, setts | 0.70 | 0.0 | – | wet: 0.30 |
| Brick, plaster, render | 0.88 | 0.0 | – | correct as is |
| Roof tiles | 0.78 | 0.0 | – | |
| Street lamp pole, signal head | 0.40 | 0.85 | – | |
| Traffic signs | 0.35 | 0.0 | – | retroreflective faces |
| Water surface | 0.04 | 0.0 | – | sky-reflection dominated |
| Foliage, leaves | 0.70 | 0.0 | – | leaves have a waxy sheen; 0.88-0.90 is too matte |
| Grass, ground cover | 0.85 | 0.0 | – | |
| Bare soil, dirt | 0.95 | 0.0 | – | |

## Scene-level

- `scene.environmentIntensity` is 0.52. Glass and paint cannot reflect a sky that is dimmed by half.
  Raise it towards 1.0 and rebalance exposure and the hemisphere term to keep the black floor at its
  target (`lum_p10 ≈ 0.010`, currently 0.015 and correct — do not regress it).
- Every lit material must be registered so `envMap` reaches it. Check with `matstats.mjs`.
- Wetness must actually drive roughness. Today `uWetness` changes albedo but not the specular lobe,
  which is why rain looks matte.

## How to verify

```bash
node tools/matstats.mjs                    # summary, buckets, and the named surfaces
node tools/matstats.mjs --filter glass     # one family
node tools/matstats.mjs --all              # everything
```

Target distribution after this pass, whole scene:

```
<0.2 (mirror/glass):  35-60      (was 8)
0.2-0.4 (paint/wet):  40-70      (was 16)
0.4-0.7 (semi-gloss): 60-90      (was 59)
>=0.7 (matte):        60-100     (was 152)
clearcoat > 0:        >= 15      (was 1)
```

A screenshot check is not enough. Run `matstats.mjs` and put the numbers in your report.
