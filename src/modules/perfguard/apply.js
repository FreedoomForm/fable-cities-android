import { QUALITY } from '../../core/Config.js';

/**
 * Apply a quality preset to a RUNNING engine, without rebuilding the world.
 *
 * Two kinds of knob live in `engine.quality`:
 *
 *   LIVE — owned by the renderer, changeable on any frame:
 *     pixelRatio          the drawing buffer; quadratic in every per-pixel cost
 *     gtao / bloom / smaa post passes
 *     shadowMapSize       shadow map resolution (dispose the maps, three reallocates them)
 *     shadowDistance      csm.maxFar — a smaller cascade frustum culls MORE geometry out of the
 *                         four shadow passes, so this is a draw-call lever, not just a fill one
 *     drawDistance        read per frame by effects (fog/particle fade)
 *
 *   BAKED — read once in a module's `init()` and turned into geometry, instance counts and
 *   textures (`density`, `propDensity`, `particles`, `textureSize`, `cascades`, `reflections`,
 *   `lightBudget`, `anisotropy`). Those cannot change without regenerating the city, and two of
 *   them MUST NOT change at runtime at all: `cascades` and `lightBudget` add or remove lights,
 *   which makes three re-derive NUM_*_LIGHTS and recompile every registered material
 *   (ARCHITECTURE §3 — measured at 60 → 9.5 fps). We write the new values into `engine.quality`
 *   so later readers are consistent, but only the LIVE list actually changes this frame.
 *
 * That split is why the boot-time preset belongs in `Config`, before the Engine exists
 * (docs/requests/perfguard.md); the runtime guard can only ever reach the live half.
 */
export const LIVE_KNOBS = ['pixelRatio', 'gtao', 'bloom', 'smaa', 'shadowMapSize', 'shadowDistance', 'drawDistance'];

/**
 * `engine.quality` is one of the shared `QUALITY.*` objects from Config.js. Modules capture it by
 * reference in `init()`, so we must not swap the identity out from under them — but we must not
 * write through it either, since that would corrupt the shared preset table for the rest of the
 * page. Take a private copy once and hand that to the engine; everything that reads
 * `engine.quality` per frame follows it, and the shared table is left alone.
 */
function ownQuality(engine) {
  if (engine.quality && engine.quality.__perfguard) return engine.quality;
  const copy = { ...engine.quality, __perfguard: true, __base: engine.quality.name };
  engine.quality = copy;
  return copy;
}

/** The preset the world's geometry was actually built from (before any step-down). */
export function baseQualityName(engine) {
  return (engine.quality && engine.quality.__base) || (engine.quality && engine.quality.name) || 'high';
}

/**
 * Move the live renderer knobs to `presetName`.
 * → `{ from, to, changed:[string] }`. Safe to call with the preset already in effect (no-op).
 */
export function applyRuntimePreset(engine, presetName) {
  const target = QUALITY[presetName];
  if (!target) throw new Error(`unknown quality preset "${presetName}"`);
  const q = ownQuality(engine);
  const from = q.name;
  const changed = [];
  if (from === presetName) return { from, to: presetName, changed };

  // --- 1. drawing buffer -------------------------------------------------------------------
  if (target.pixelRatio !== q.pixelRatio) {
    const pr = Math.min(window.devicePixelRatio || 1, target.pixelRatio);
    if (Math.abs(engine.renderer.getPixelRatio() - pr) > 1e-3) {
      engine.renderer.setPixelRatio(pr);
      changed.push(`pixelRatio ${engine.renderer.getPixelRatio().toFixed(2)}`);
    }
  }

  // --- 2. post passes ----------------------------------------------------------------------
  const post = engine.post || {};
  for (const [key, pass] of [['gtao', post.gtao], ['bloom', post.bloom], ['smaa', post.smaa]]) {
    if (pass && !!target[key] !== !!pass.enabled) {
      pass.enabled = !!target[key];
      changed.push(`${key} ${pass.enabled ? 'on' : 'off'}`);
    }
  }

  // --- 3. shadows --------------------------------------------------------------------------
  // Cascade COUNT is deliberately left alone (adding/removing lights recompiles every material).
  // Resolution and distance are both free to change: three reallocates a disposed shadow map on
  // the next render, and CSM recomputes the cascade extents in updateFrustums().
  const csm = engine.csm;
  if (csm) {
    let touched = false;
    if (target.shadowMapSize !== csm.shadowMapSize) {
      csm.shadowMapSize = target.shadowMapSize;
      for (const l of csm.lights) {
        l.shadow.mapSize.setScalar(target.shadowMapSize);
        if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      }
      changed.push(`shadowMap ${target.shadowMapSize}`);
      touched = true;
    }
    if (target.shadowDistance !== csm.maxFar) {
      csm.maxFar = target.shadowDistance;
      changed.push(`shadowDistance ${target.shadowDistance}m`);
      touched = true;
    }
    if (touched) {
      csm.updateFrustums();
      // re-derives per-cascade bias/softness from the new texel footprint (Engine._applyCascadeShadow)
      engine.setShadowTuning({});
    }
  }

  // --- 4. publish the whole preset so per-frame readers stay consistent ----------------------
  const base = q.__base;
  Object.assign(q, target, { __perfguard: true, __base: base });
  // resize AFTER the preset is published: composer.setSize reallocates every pass target
  engine.resize();
  return { from, to: presetName, changed };
}

/**
 * Deepest step only: thin the traffic out. This is a public API call (§5 traffic.api), not a
 * reach into another module's internals, and vehicles are the single biggest per-frame
 * draw-call contributor left once the renderer knobs are exhausted.
 */
export function thinTraffic(world, factor = 0.6) {
  const api = world && world.traffic && world.traffic.api;
  if (!api || typeof api.setDensity !== 'function') return null;
  const current = typeof api.getDensity === 'function' ? api.getDensity() : 1;
  const next = Math.max(0.35, current * factor);
  if (Math.abs(next - current) < 0.02) return null;
  api.setDensity(next);
  return `traffic ${current.toFixed(2)} → ${next.toFixed(2)}`;
}
