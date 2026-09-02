# Core requests from the `menu` module

The start screen currently needs **no** core change to work — everything below is already handled inside
`src/modules/menu/**` with a fallback. These are the places where a small core change would let the menu
drop a workaround. Nothing here is urgent; all of it is backwards compatible.

## 1. Call `menu.setProgress(fraction, text)` alongside `setLoading()` — the one that matters

§5b documents `setProgress(fraction, text)` as part of the contract, and the module exports it, but
`src/main.js` never calls it: it writes into `#loading-bar` / `#loading-status` in `index.html` instead.

**Workaround in place:** `watchCoreProgress()` in `src/modules/menu/index.js` attaches a `MutationObserver`
to `#loading-bar` (attribute `style`) and `#loading-status` (character data) and mirrors what it reads.
Read-only, no core file touched — but it is coupled to the ids and to the fact that the bar is driven by
an inline `style.width`.

**Proposed** in `boot()`, next to the existing `setLoading` helper:

```js
const setLoading = (fraction, text) => {
  if (loadingBar) loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  if (loadingStatus && text) loadingStatus.textContent = text;
  ctx.modules.menu?.setProgress?.(fraction, text);      // ← one line
};
```

`setProgress` is already null-safe and a no-op once the screen is gone.

## 2. Let the menu overlay live above `#loading`

After the choice resolves, `main.js` un-hides `#loading` (z-index 100) while the modules initialise. The
menu keeps its own panel up to show progress, the city name and the controls card, so it must render above
that. **Workaround in place:** the overlay is appended to `document.body` at `z-index: 400` instead of
`ctx.uiRoot` (which is inside a `z-index: 10` stacking context). That works today and needs nothing from
core; it is recorded here only so nobody "fixes" it back to `uiRoot`.

If core would rather own the ordering, either give `#ui-root` a `z-index` above `#loading`, or hide
`#loading` entirely while `ctx.modules.menu` is still on screen.

## 3. Optional: finer loading progress

Progress jumps in module-sized steps (`i / (list.length + 1) * 0.9`), so it can sit still for several
seconds during a slow module and then for most of the demo-city build (a single `0.92` step). The menu
smooths this with a creep so the bar never looks frozen, but real sub-steps would be better. Two cheap
options: emit `assets:progress` more widely, or interpolate `setLoading` between `i` and `i+1` while a
module awaits.

## 4. `tools/matstats.mjs` hangs on its default URL (one-word fix, not in menu-owned code)

`tools/matstats.mjs` defaults to `http://127.0.0.1:5180/?seed=7&time=17.5`. That URL pins neither
`demo`, `showcase` nor `headless`, so `Config.menu` is **true**, boot waits for a click that never comes
and the tool times out (`Waiting failed: 150000ms exceeded`). `check.mjs` and `shot.mjs` both already
force `headless=1` and are unaffected; this is the only tool that does not.

**Proposed** (in `tools/matstats.mjs`, which the menu does not own):

```js
const url = flag('url', 'http://127.0.0.1:5180/?seed=7&time=17.5&headless=1');
```

Verified: `node tools/matstats.mjs --url "http://127.0.0.1:5180/?seed=7&time=17.5&headless=1"` works today.
The menu deliberately does **not** try to detect automation (e.g. `navigator.webdriver`) to work around
this — that would silently skip the screen for `shotpage.mjs` too, and the screen has to be screenshot-able.

## 5. Optional: `world.time.paused` during the start screen

The screen sets `world.time.paused = true` while it is up and **restores the previous value** when the
player chooses (the earlier placeholder left it pinned to `true`, so a menu-started game began paused).
Nothing needed from core — noted so the behaviour is not surprising.

## Contract the menu relies on (please do not change silently)

- `showStartScreen(ctx)` is awaited **before** the module loop, and `config.menu` is false whenever
  `?demo=`, `?showcase=` or `?headless=` pins the world. Every screenshot/check URL in §7 depends on that
  and the menu deliberately adds no new precondition.
- `game:ready` is emitted **after** `#loading` gets `.hidden`; the menu fades itself out on that event
  (plus a 120 s safety net, so a stuck module can never leave a player locked behind the overlay).
- `src/modules/terrain/Heightmap.js` is imported dynamically, read-only, for the seed preview and the
  backdrop (`new Heightmap({ size, spacing, seed }).sampleGen(x, z, lod)` — no `generate()`, no mutation).
  If the class or that method is renamed, the menu falls back to a built-in stand-in generator and the
  preview stops matching the real world. A heads-up would be appreciated.
