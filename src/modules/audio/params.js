/**
 * Guarded AudioParam writes — the ONLY way the audio module touches an AudioParam.
 *
 * Web Audio throws a TypeError for any non-finite value (`setTargetAtTime(NaN)`), a RangeError for
 * exponential ramps through zero and NotSupportedError when automation events overlap. A single
 * throw inside update() surfaces as "[engine] error in audio" in every headless run. These helpers
 * validate value/time/time-constant, clamp to the param's nominal range, never throw, and count what
 * they had to skip in `guard` (exposed through api.getState().guard and the debug HUD) so a NaN
 * upstream is visible in the numbers instead of the console.
 */
export const guard = { skipped: 0, caught: 0, last: null };

const fin = Number.isFinite;

function clampTo(p, v) {
  const lo = p.minValue, hi = p.maxValue;
  return v < lo ? lo : v > hi ? hi : v;
}
function skip(op, v) {
  guard.skipped++;
  guard.last = `${op}(${String(v)})`;
}
function caught(op, err) {
  guard.caught++;
  guard.last = `${op}: ${err && err.message ? err.message : err}`;
}

/** param.setTargetAtTime(value, t, timeConstant) */
export function setT(p, v, t, tc) {
  if (!p || !fin(v) || !fin(t) || !fin(tc) || tc <= 0) return skip('setT', v);
  try { p.setTargetAtTime(clampTo(p, v), t < 0 ? 0 : t, tc); } catch (e) { caught('setT', e); }
}
/** param.setValueAtTime(value, t) */
export function setV(p, v, t) {
  if (!p || !fin(v) || !fin(t)) return skip('setV', v);
  try { p.setValueAtTime(clampTo(p, v), t < 0 ? 0 : t); } catch (e) { caught('setV', e); }
}
/** param.linearRampToValueAtTime(value, t) */
export function linRamp(p, v, t) {
  if (!p || !fin(v) || !fin(t)) return skip('linRamp', v);
  try { p.linearRampToValueAtTime(clampTo(p, v), t < 0 ? 0 : t); } catch (e) { caught('linRamp', e); }
}
/** param.exponentialRampToValueAtTime(value, t) — values ≤ 0 fall back to a linear ramp (exp ramps cannot cross zero). */
export function expRamp(p, v, t) {
  if (!p || !fin(v) || !fin(t)) return skip('expRamp', v);
  const x = clampTo(p, v);
  try {
    if (x > 0) p.exponentialRampToValueAtTime(x < 1e-4 ? 1e-4 : x, t < 0 ? 0 : t);
    else p.linearRampToValueAtTime(x, t < 0 ? 0 : t);
  } catch (e) { caught('expRamp', e); }
}
/** param.setValueCurveAtTime(curve, t, duration) — every sample must be finite, duration > 0. */
export function setCurve(p, curve, t, dur) {
  if (!p || !fin(t) || !fin(dur) || dur <= 0 || !curve || curve.length < 2) return skip('setCurve', dur);
  for (let i = 0; i < curve.length; i++) if (!fin(curve[i])) return skip('setCurve', curve[i]);
  try { p.setValueCurveAtTime(curve instanceof Float32Array ? curve : Float32Array.from(curve), t < 0 ? 0 : t, dur); } catch (e) { caught('setCurve', e); }
}
/** param.cancelScheduledValues(t) */
export function cancelAt(p, t) {
  if (!p || !fin(t)) return skip('cancelAt', t);
  try { p.cancelScheduledValues(t < 0 ? 0 : t); } catch (e) { caught('cancelAt', e); }
}
/** param.value = v */
export function setVal(p, v) {
  if (!p || !fin(v)) return skip('setVal', v);
  try { p.value = clampTo(p, v); } catch (e) { caught('setVal', e); }
}
/** Finite number or fallback — for sanitising mix-state inputs before they reach any param. */
export function num(v, d = 0) { return fin(v) ? v : d; }
/** Reset counters (offline renders start clean). */
export function resetGuard() { guard.skipped = 0; guard.caught = 0; guard.last = null; }
