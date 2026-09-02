/**
 * perfguard — hardware detection at boot + a runtime frame-time guard.
 *
 * The game is tuned on an Apple M5 Pro (≈2100 draw calls / 8.6 M triangles at `quality=high`).
 * Strangers will open it on Intel UHD laptops, on 4K panels, on phones. This module decides what
 * such a machine should start at, and steps the preset down if the machine turns out to be
 * slower than it looked. It never steps up, never picks `ultra`, and never fires more than twice.
 *
 * ── Where it runs ─────────────────────────────────────────────────────────────────────────────
 * `src/modules/registry.js` is core, so perfguard is not registered yet; the ui module imports
 * `attach(ctx)` from here (`src/modules/ui/settings.js`) and that is what starts it today.
 * `attach()` is idempotent and also called from `init()`, so the day the integrator adds
 *   { name: 'perfguard', order: 1, load: () => import('./perfguard/index.js') }
 * nothing here has to change. See docs/requests/perfguard.md for the two-line change in
 * `main.js` that would let the detected preset reach the world BEFORE it is generated — that is
 * the only way the baked half of a preset (vegetation density, instance counts, texture size,
 * shadow cascade count) can follow the detection at all.
 *
 * ── URL parameters ────────────────────────────────────────────────────────────────────────────
 *   ?perfguard=0   detection still runs and is reported, but nothing is ever changed
 *   ?perfguard=1   force both on, even under ?headless=1
 *   ?perftarget=N  override the guard's target fps (for verifying it fires)
 *
 * Both the boot-time auto-pick and the guard are OFF whenever the URL pins the world
 * (`?quality=`, `?headless=1`, `?showcase=`), so every screenshot, showcase and check URL in
 * ARCHITECTURE §7 renders exactly what it asked for and stays reproducible.
 */
import { detectHardware, recommendQuality, describeHardware, isCheaper, stepDown, PRESET_ORDER } from '../../shared/quality.js';
import { applyRuntimePreset, thinTraffic, baseQualityName } from './apply.js';
import { createGuard, GUARD_DEFAULTS } from './guard.js';

export const name = 'perfguard';

const STORE_KEY = 'fable.quality';
const AUTO_KEY = 'fable.quality.auto';

let S = null;   // singleton state; attach() is idempotent

/** Module interface. Registered or not, `attach` is what actually starts anything. */
export async function init(ctx) { attach(ctx); }
/** The frame hook is installed by `attach()` via engine.onUpdate, so this stays empty. */
export function update() {}
export function dispose() {
  if (!S) return;
  S.unhook && S.unhook();
  S = null;
}

const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, v) { try { window.localStorage.setItem(key, v); } catch { /* private mode */ } },
};

/**
 * Start (or re-attach to) the perf guard. Safe to call any number of times, from any module.
 * → the `window.__game.perf` API object.
 */
export function attach(ctx) {
  if (S) return S.api;
  const { engine, events, config, world } = ctx;

  // --- 1. hardware detection ---------------------------------------------------------------
  // Always runs, even when we are forbidden from acting on it: the numbers belong in the
  // screenshot log and the settings panel regardless.
  let hardware, recommendation;
  try {
    hardware = detectHardware(engine.renderer && engine.renderer.getContext());
    recommendation = recommendQuality(hardware);
  } catch (err) {
    console.warn('[perfguard] hardware detection failed', err);
    hardware = { renderer: 'detection failed', gpuTier: 1, gpuLabel: 'unknown', cores: 0, memoryGB: null, dpr: 1, viewport: [0, 0], mobile: false, gpuConfidence: 'guessed' };
    recommendation = { name: 'medium', base: 'medium', reasons: ['detection threw: ' + (err && err.message)], hardware };
  }

  const param = config.params ? config.params.get('perfguard') : null;
  const pinnedQuality = !!(config.params && config.params.has('quality'));
  // `?headless=1` and `?showcase=` are the reliable *tooling* markers — tools/shot.mjs and
  // tools/check.mjs both force headless. `?quality=` alone is NOT: the start screen's own quality
  // control reloads the page with it (menu/index.js applyQuality), so a player who picked
  // "Medium" arrives with `?quality=medium` and still deserves the safety net.
  const toolingUrl = !!config.headless || !!config.showcase;
  const force = param === '1';
  const off = param === '0';
  /** Boot-time auto-pick: skipped whenever a preset was asked for explicitly, by anyone. */
  const autoPickEnabled = force || !(off || pinnedQuality || toolingUrl);
  /** Runtime guard: off only for tooling, so screenshots stay deterministic. */
  const enabled = force || !(off || toolingUrl);
  const targetFps = Number(config.params && config.params.get('perftarget')) || GUARD_DEFAULTS.targetFps;

  const log = [];
  const guard = createGuard({ targetFps });

  S = {
    ctx, engine, events, world, guard, log, enabled, autoPickEnabled,
    hardware, recommendation,
    baseQuality: baseQualityName(engine),
    notified: false,
    userOverride: false,
    sampling: false,
    lastT: 0,
    unhook: null,
    api: null,
  };

  const record = (entry) => {
    log.push({ at: +(performance.now() / 1000).toFixed(1), ...entry });
    if (log.length > 20) log.shift();
  };

  /** One quiet message, the first time we change anything by ourselves. Never repeated. */
  function tellPlayerOnce(title, text) {
    if (S.notified) return;
    S.notified = true;
    const send = () => { try { events.emit('notification', { kind: 'info', title, text, life: 9000 }); } catch { /* no ui module */ } };
    // the toast host is created during ui init and the loading screen is still up here —
    // hold the message until the player can actually see it
    if (window.__game && window.__game.ready) setTimeout(send, 900);
    else events.once ? events.once('game:ready', () => setTimeout(send, 1400)) : events.on('game:ready', () => setTimeout(send, 1400));
  }

  function moveTo(preset, why, { notify = null, deepStep = false } = {}) {
    let result;
    try {
      result = applyRuntimePreset(engine, preset);
    } catch (err) {
      console.warn('[perfguard] could not apply preset', preset, err);
      return null;
    }
    if (deepStep) {
      const t = thinTraffic(world, 0.6);
      if (t) result.changed.push(t);
    }
    record({ from: result.from, to: result.to, why, changed: result.changed });
    console.info(`[perfguard] ${result.from} → ${result.to} (${why}) · ${result.changed.join(', ') || 'no live knob differed'}`);
    if (notify) tellPlayerOnce(notify.title, notify.text);
    return result;
  }

  // --- 2. the boot decision ------------------------------------------------------------------
  const running = engine.quality.name;
  S.recommendedApplied = false;
  if (autoPickEnabled && isCheaper(recommendation.name, running)) {
    moveTo(recommendation.name, `hardware detection: ${describeHardware(hardware)}`, {
      notify: {
        title: `Graphics set to ${cap(recommendation.name)}`,
        text: `Picked for ${hardware.gpuLabel}. Change it any time in Settings.`,
      },
    });
    S.recommendedApplied = true;
    store.set(STORE_KEY, recommendation.name);
  } else {
    console.info(`[perfguard] ${describeHardware(hardware)} → recommends ${recommendation.name}; running ${running}` +
      `${autoPickEnabled ? '' : ' (preset pinned by the URL)'}${enabled ? '' : ' (guard off for this URL)'}`);
  }

  // --- 3. the runtime guard --------------------------------------------------------------------
  const autoPref = store.get(AUTO_KEY);
  S.auto = enabled && autoPref !== '0';

  function tick() {
    if (!S || !S.auto || S.userOverride || guard.exhausted) return;
    const now = performance.now();
    if (document.hidden) { guard.forget(now); S.lastT = 0; return; }
    if (!S.lastT) { S.lastT = now; return; }
    const frameMs = now - S.lastT;
    S.lastT = now;
    if (!S.sampling) return;                       // still inside the boot grace period
    if (guard.sample(now, frameMs) !== 'stepDown') return;

    const from = engine.quality.name;
    const to = stepDown(from, 1);
    if (to === from) { guard.stepped(now); return; }   // already at `low`, nothing left
    const second = guard.steps >= 1;
    moveTo(to, `sustained shortfall: median ${guard.medianMs.toFixed(1)} ms over ${(guard.options.sustainMs / 1000)} s (target ${targetFps} fps)`, {
      deepStep: second,
      notify: {
        title: `Graphics lowered to ${cap(to)}`,
        text: `Your device was not holding ${targetFps} fps. You can set it back in Settings.`,
      },
    });
    guard.stepped(now);
    store.set(STORE_KEY, to);
  }

  S.unhook = engine.onUpdate(function perfguardTick() {
    try { tick(); } catch (err) { console.warn('[perfguard] tick failed', err); S.auto = false; }
  });

  // Only start measuring once the city exists and the loading screen is gone; and drop the
  // window whenever something reallocates render targets or steals the GPU.
  const begin = () => { S.sampling = true; S.lastT = 0; guard.forget(performance.now(), GUARD_DEFAULTS.warmupMs); };
  if (window.__game && window.__game.ready) begin();
  else events.on('game:ready', begin);
  events.on('engine:resize', () => { S.lastT = 0; guard.forget(performance.now(), 1500); });
  document.addEventListener('visibilitychange', () => { S.lastT = 0; if (!document.hidden) guard.forget(performance.now(), 1500); });

  // --- 4. public API ----------------------------------------------------------------------------
  const api = {
    hardware,
    /** `{ name, base, reasons[] }` — what detection thinks this machine should run. */
    recommendation,
    describe: () => describeHardware(hardware),
    presets: PRESET_ORDER,
    get enabled() { return S.enabled; },
    get autoPick() { return S.autoPickEnabled; },
    get auto() { return S.auto; },
    /** The preset the world's geometry was built from — the guard cannot change this half. */
    get baseQuality() { return S.baseQuality; },
    get quality() { return engine.quality.name; },
    get guard() {
      return { steps: guard.steps, exhausted: guard.exhausted, debtMs: Math.round(guard.debtMs), medianMs: +guard.medianMs.toFixed(2), sampling: S.sampling, ...guard.options };
    },
    log,
    /** Turn the runtime guard on/off (persisted). Detection is unaffected. */
    setAuto(on) {
      S.auto = !!on && S.enabled;
      store.set(AUTO_KEY, on ? '1' : '0');
      if (S.auto) { S.lastT = 0; guard.forget(performance.now(), 1500); }
      return S.auto;
    },
    /** Apply a preset's LIVE knobs now. A manual call stops the guard — respect the human. */
    setPreset(preset, { manual = true } = {}) {
      if (!PRESET_ORDER.includes(preset)) return null;
      if (manual) { S.userOverride = true; store.set(STORE_KEY, preset); }
      return moveTo(preset, manual ? 'set by the player' : 'programmatic');
    },
    /** Verification hook: pretend the machine missed the budget for `seconds`. */
    simulateShortfall(seconds = 6, fps = 20) {
      const step = 1000 / fps;
      let t = performance.now();
      S.sampling = true;
      guard.forget(t, 0);
      for (let i = 0; i < (seconds * 1000) / step; i++) {
        t += step;
        if (guard.sample(t, step) === 'stepDown') {
          const from = engine.quality.name;
          const to = stepDown(from, 1);
          const second = guard.steps >= 1;
          if (to !== from) moveTo(to, `simulated shortfall at ${fps} fps`, { deepStep: second, notify: { title: `Graphics lowered to ${cap(to)}`, text: `Your device was not holding ${targetFps} fps. You can set it back in Settings.` } });
          guard.stepped(t);
        }
      }
      return api.status();
    },
    /** JSON-safe snapshot — this is what a screenshot log or a critic should read. */
    status() {
      return {
        hardware: { ...hardware },
        recommended: recommendation.name,
        reasons: recommendation.reasons,
        enabled: S.enabled,
        autoPick: S.autoPickEnabled,
        auto: S.auto,
        baseQuality: S.baseQuality,
        quality: engine.quality.name,
        guard: api.guard,
        log: log.slice(),
      };
    },
  };
  S.api = api;
  if (window.__game) window.__game.perf = api;
  else events.on('game:ready', () => { if (window.__game) window.__game.perf = api; });
  return api;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
