# Core requests from the `perfguard` module

`perfguard` owns hardware detection and the runtime frame-time guard.

```
src/shared/quality.js          detectHardware() · recommendQuality() · classifyGPU()   (pure, no THREE)
src/modules/perfguard/index.js attach(ctx) → window.__game.perf
src/modules/perfguard/apply.js applyRuntimePreset(engine, name) — the LIVE half of a preset
src/modules/perfguard/guard.js createGuard() — the rolling-window Schmitt trigger
```

Nothing below is required for the module to work — it runs today, imported by
`src/modules/ui/settings.js`. Each request buys back a piece of the preset that a *runtime*
change can never reach.

---

## 1. Register `perfguard` in `src/modules/registry.js` (order 1)

```js
{ name: 'perfguard', order: 1, load: () => import('./perfguard/index.js') },
```

**Why.** Today the module is started by `src/modules/ui/settings.js` importing `attach(ctx)`.
That works, but it makes a performance guard depend on the HUD being present: `?focus=terrain`
or a broken ui module silently disables it. `attach()` is idempotent and is already called from
`init()`, so this line is the whole change — no code in the module moves.

Order 1 (before `terrain`) additionally means `engine.quality` is corrected *before* the modules
that read it, which recovers the `density` / `propDensity` / `particles` / `textureSize` knobs
listed as BAKED in `apply.js`. It does **not** recover `cascades`, `reflections` or `pixelRatio`:
those are consumed in the `Engine` constructor, which runs before any module. See #2.

## 2. Seed the start screen's quality control from the detected hardware

This is the one that actually matters, and it is now almost free, because
`src/modules/menu/index.js` already has a quality selector and already knows how to apply one
(`applyQuality()` reloads with `?quality=`, which is correct — `Engine` reads the preset once, at
construction). The only problem is where its default comes from:

```js
const currentQuality = config.quality || 'high';        // menu/index.js — always 'high'
```

`high` is tuned on an Apple M5 Pro: **≈2100 draw calls and 8.6 M triangles**. On an Intel UHD
laptop that is a slideshow, and the visitor never learns that a cheaper preset exists.

**Proposed** (menu module, 3 lines):

```js
import { detectHardware, recommendQuality } from '../../shared/quality.js';
// …
const pinned = config.params.has('quality');
const recommended = recommendQuality(detectHardware()).name;   // never returns 'ultra'
const currentQuality = pinned ? config.quality : recommended;
// and, when !pinned && recommended !== config.quality, run the existing applyQuality(recommended)
// path once on open — the panel already shows "Applying Low quality…" and nothing has been
// generated yet, so the reload costs the visitor nothing.
```

`recommendQuality` is pure (no THREE, no engine, no DOM writes) precisely so it can be called
this early, and it returns `reasons: string[]` if the panel wants to explain the choice.

**Alternative if the menu should stay unaware of hardware** — do it in `main.js`, one line after
`new Config()`, which also covers the `?menu=0` path:

```js
const config = new Config();
if (!config.params.has('quality')) config.quality = recommendQuality(detectHardware()).name;
```

Either version must keep the existing escape hatch: an explicit `?quality=` in the URL always
wins, so every screenshot, showcase and check URL in ARCHITECTURE §7 is untouched.

## 3. `main.js` currently drops `choice.quality`

ARCHITECTURE §5b documents the start-screen contract as returning
`{ mode, seed, cityName, quality? }` and `menu/index.js` does return `quality`, but `main.js`
applies only `seed`, `cityName` and `demo`. The field is dead. Either apply it (it can only be
honoured for the live half at that point, since `Engine` is already constructed) or drop it from
the documented contract so the next module does not rely on it.

## 4. Nice to have — `engine.setQuality(name)`

`applyRuntimePreset()` in `apply.js` currently reaches for `engine.csm.shadowMapSize`,
`engine.csm.maxFar`, `light.shadow.map.dispose()` and `engine.setShadowTuning({})` (used only for
its side effect of re-running the private `_applyCascadeShadow()`). All of it is documented
behaviour, but a small core method would be a better home for it:

```js
setQuality(name)   // applies the live half of QUALITY[name]; returns { from, to, changed[] }
```

Core also knows the two things a module cannot safely change at runtime — cascade **count** and
`lightBudget` — because both add or remove lights and force a full material recompile
(ARCHITECTURE §3, measured 60 → 9.5 fps). Keeping that knowledge in one place would stop the next
module from trying.
