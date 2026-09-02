/**
 * The runtime frame-time guard: a Schmitt trigger over a rolling window of frame times.
 *
 * Design goals, in order:
 *   1. Never oscillate. A guard that flips between presets is worse than one that never fires.
 *   2. Never react to a hitch. Shader compiles, GC, a tab switch and another app stealing the GPU
 *      all produce single frames of 100-2000 ms that say nothing about the steady state.
 *   3. Step down at most twice, then stop measuring and cost nothing.
 *
 * How it avoids each failure mode:
 *   MEDIAN, not mean, of a ~2 s window          — one 900 ms hitch cannot move a median.
 *   Frames over `spikeMs` are dropped entirely  — an alt-tab is not a performance signal.
 *   A DEBT accumulator with two thresholds      — this is the hysteresis. Debt grows only while
 *     the median is below `targetFps` and drains only while it is above `recoverFps`; between
 *     45 and 55 fps nothing moves at all, so a machine sitting exactly on the target never
 *     triggers. Firing needs `sustainMs` of *continuous* shortfall.
 *   A cooldown after every change              — the frames right after a preset change are
 *     polluted by shader recompiles and render-target reallocation; measuring them would
 *     immediately "prove" the change did not help and fire again.
 *   A warm-up after boot                       — the first seconds are asset decode and first-use
 *     shader compilation, not gameplay.
 *
 * Pure state machine: `sample(nowMs, frameMs)` in, `'stepDown'` or null out. No engine, no DOM.
 */
export const GUARD_DEFAULTS = {
  targetFps: 45,      // below this the frame budget is considered missed
  recoverFps: 55,     // above this the debt drains — the gap 45..55 is the hysteresis dead-band
  windowMs: 2000,     // rolling window the median is taken over
  sustainMs: 4000,    // continuous shortfall required before stepping down
  cooldownMs: 8000,   // ignore everything for this long after a step (and after warm-up)
  warmupMs: 6000,     // ignore the first frames of the session
  evaluateMs: 250,    // how often the median is recomputed (cost control)
  spikeMs: 400,       // frames longer than this are hitches, not signal — dropped
  maxSteps: 2,        // hard limit on automatic downgrades per session
};

export function createGuard(options = {}) {
  const opt = { ...GUARD_DEFAULTS, ...options };
  const budgetMs = 1000 / opt.targetFps;
  const recoverMs = 1000 / opt.recoverFps;
  const maxDebt = opt.sustainMs * 1.5;

  const times = [];     // timestamps, parallel to `frames`
  const frames = [];    // frame durations in ms
  let debt = 0;
  let steps = 0;
  let lastEval = 0;
  let blockedUntil = opt.warmupMs;   // relative to the first sample
  let t0 = null;
  let lastMedian = 0;
  let dropped = 0;

  function reset(nowMs, holdMs) {
    times.length = 0;
    frames.length = 0;
    debt = 0;
    lastMedian = 0;
    blockedUntil = (nowMs - t0) + holdMs;
  }

  return {
    get steps() { return steps; },
    get exhausted() { return steps >= opt.maxSteps; },
    get debtMs() { return debt; },
    get medianMs() { return lastMedian; },
    get droppedSpikes() { return dropped; },
    get options() { return { ...opt }; },

    /** Forget the window (tab hidden, camera teleport, a manual quality change). */
    forget(nowMs, holdMs = opt.cooldownMs) {
      if (t0 == null) return;
      reset(nowMs, holdMs);
    },

    /**
     * Feed one rendered frame. → `'stepDown'` when the guard has decided, otherwise null.
     * The caller applies the change and must then call `stepped(nowMs)`.
     */
    sample(nowMs, frameMs) {
      if (t0 == null) t0 = nowMs;
      const t = nowMs - t0;
      if (!(frameMs > 0) || frameMs > opt.spikeMs) { dropped++; return null; }
      if (steps >= opt.maxSteps) return null;

      times.push(nowMs);
      frames.push(frameMs);
      const cutoff = nowMs - opt.windowMs;
      while (times.length && times[0] < cutoff) { times.shift(); frames.shift(); }

      if (t < blockedUntil) return null;
      if (nowMs - lastEval < opt.evaluateMs) return null;
      lastEval = nowMs;
      // a partial window is not evidence — need most of `windowMs` worth of frames
      if (frames.length < 20 || (times[times.length - 1] - times[0]) < opt.windowMs * 0.6) return null;

      const sorted = frames.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      lastMedian = median;

      const dt = opt.evaluateMs;
      if (median > budgetMs) debt = Math.min(maxDebt, debt + dt);
      else if (median < recoverMs) debt = Math.max(0, debt - dt);
      // between recoverMs and budgetMs: hold. This is the dead-band.

      if (debt >= opt.sustainMs) return 'stepDown';
      return null;
    },

    /** Confirm a step was applied: burn one of the two allowed steps and start the cooldown. */
    stepped(nowMs) {
      steps++;
      reset(nowMs, opt.cooldownMs);
      return steps;
    },
  };
}
