/**
 * Hardware detection and quality-preset selection.
 *
 * Pure functions — no THREE, no engine, no side effects — so they can run before the renderer
 * exists (the right place is `main.js`, one line after `new Config()`; see
 * docs/requests/perfguard.md) and can be unit-tested from node with a stub `gl`.
 *
 * The game is tuned on an Apple M5 Pro and costs ~2100 draw calls / 8.6 M triangles at
 * `quality=high`. On a mid-range laptop that is a slideshow, and a slideshow is worse than a
 * lower setting — so the starting preset is *guessed down*, never up, and `ultra` is never
 * chosen automatically (see AUTO_MAX).
 *
 * ── The mapping ───────────────────────────────────────────────────────────────────────────────
 * 1. GPU tier from the WebGL renderer string (see GPU_TIERS below):
 *      tier 0  software rasteriser (SwiftShader, llvmpipe, Basic Render Driver)   → low
 *      tier 1  weak integrated / phone (Intel HD·UHD, Iris Plus, PowerVR, Mali-T) → low
 *      tier 2  good integrated / entry dGPU (Iris Xe, Vega/7×0M, MX, GTX 10-16,
 *              Apple M-series *base*, Adreno 7xx, Arc A3xx)                       → medium
 *      tier 3  real discrete / Apple Pro·Max·Ultra (RTX, RX 6000+, Arc A7xx)      → high
 *      unknown / masked string → tier guessed from core count (>=8 → 2, else 1), flagged
 *        `confidence:'guessed'`.
 * 2. Caps (each can only lower the result):
 *      navigator.hardwareConcurrency <= 4                      → cap low
 *      navigator.hardwareConcurrency <= 6                      → cap medium
 *      navigator.deviceMemory <= 2 GB                          → cap low
 *      navigator.deviceMemory <= 4 GB                          → cap medium
 *        (the spec clamps the reported value at 8, so ">= 8" carries no information and
 *         is deliberately not used as a cap)
 *      touch device with no hover (phone/tablet)               → cap low
 *      gl MAX_TEXTURE_SIZE < 8192                              → cap medium
 * 3. Pixel pressure — the drawing buffer is `viewport × min(devicePixelRatio, preset.pixelRatio)²`.
 *      A 4K or Retina panel multiplies every per-pixel cost (GTAO, bloom, SMAA, the whole
 *      forward pass) without changing the draw-call count, so on tier <= 2 a projected buffer
 *      over PIXEL_BUDGET (4.5 Mpx) costs one more step down.
 * 4. Clamp to [low, AUTO_MAX]. AUTO_MAX is `high`: ultra is opt-in only.
 *
 * Every rule that fired is returned in `reasons` so the choice can be explained in the UI,
 * printed in the console and checked in a screenshot log.
 */

/** Preset names, cheapest first. Indexes into this array are the "steps" the guard walks. */
export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra'];

/** Automatic selection never goes above this — `ultra` is a deliberate choice, not a guess. */
export const AUTO_MAX = 'high';

/** Projected drawing-buffer pixels above which a non-discrete GPU gets one more step down. */
export const PIXEL_BUDGET = 4.5e6;

/** `pixelRatio` of each preset, mirrored here so the projection can run before the Engine exists. */
const PRESET_PIXEL_RATIO = { low: 1, medium: 1, high: 1.5, ultra: 2 };

/**
 * Renderer-string → tier. Ordered: the FIRST match wins, so put the specific patterns
 * (`apple m3 max`) before the general ones (`apple m3`).
 * Strings seen in the wild:
 *   ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)
 *   ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A8) Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   Apple GPU            (Safari masks everything behind this)
 *   Google SwiftShader / llvmpipe (LLVM 15.0.7, 256 bits)
 */
export const GPU_TIERS = [
  // ── 0: no GPU at all ──────────────────────────────────────────────────────────────────────
  [/swiftshader|llvmpipe|softpipe|software\s*(rasteri[sz]er|adapter)|basic\s*render|microsoft\s*basic/i, 0, 'software rasteriser'],
  // ── 3: discrete desktop / workstation / Apple Pro-Max-Ultra ───────────────────────────────
  [/apple\s*m\d+\s*(pro|max|ultra)/i, 3, 'Apple M-series Pro/Max/Ultra'],
  [/(geforce\s*)?rtx\s*[2-9]\d{3}|rtx\s*a\d|geforce\s*rtx/i, 3, 'GeForce RTX'],
  [/radeon\s*(rx|pro)\s*(vii|[6-9]\d{3})|radeon\s*rx\s*5[6-9]\d{2}/i, 3, 'Radeon RX 5600+'],
  [/arc\s*a7\d\d|arc\s*b5\d\d/i, 3, 'Intel Arc A7xx/B5xx'],
  [/quadro\s*(rtx|p[45689]\d{3})|tesla|a100|h100|l40/i, 3, 'workstation GPU'],
  // ── 2: good integrated / entry discrete ───────────────────────────────────────────────────
  [/apple\s*m\d/i, 2, 'Apple M-series (base)'],
  [/iris\(?r?\)?\s*xe|xe\s*graphics|arc\s*(a3\d\d|graphics)/i, 2, 'Intel Iris Xe / Arc'],
  [/geforce\s*(gtx\s*(9|10|16)\d\d|mx\d{3})|gtx\s*(9|10|16)\d\d/i, 2, 'GeForce GTX 9xx-16xx'],
  [/radeon\s*(rx\s*[45]\d{2,3}|vega|graphics|\d{3}m)|radeon\s*(6|7|8)\d0m|gfx10|gfx11/i, 2, 'Radeon Vega / RDNA iGPU'],
  [/adreno\s*[67]\d\d|mali-g(7[1-9]|[89]\d|\d{3})/i, 2, 'recent mobile GPU'],
  // ── 1: weak integrated / older mobile ─────────────────────────────────────────────────────
  [/intel.*\b(hd|uhd)\s*graphics|hd\s*graphics\s*\d|iris\s*(plus|pro)|intel.*gma/i, 1, 'Intel HD/UHD/Iris Plus'],
  [/adreno|mali|powervr|videocore|apple\s*a\d+\s*gpu|tegra/i, 1, 'mobile GPU'],
  [/geforce\s*(gt|gtx\s*[5-8]\d\d)|radeon\s*hd|firepro/i, 1, 'legacy discrete GPU'],
];

const clampIndex = (i) => Math.max(0, Math.min(PRESET_ORDER.length - 1, i));
const indexOf = (name) => {
  const i = PRESET_ORDER.indexOf(name);
  return i < 0 ? PRESET_ORDER.indexOf('high') : i;
};

/**
 * Renderer strings are full of vendor decoration — `Intel(R) Iris(R) Xe`, `AMD Radeon(TM) Graphics`,
 * `NVIDIA GeForce RTX 3070 Laptop GPU` — which breaks naive `radeon graphics` style patterns.
 * Strip the trademark marks and collapse whitespace before matching.
 */
function normalizeRenderer(s) {
  return String(s || '').replace(/\((?:tm|r|c)\)/gi, ' ').replace(/[\u2122\u00ae]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Classify a WebGL renderer string. → `{ tier, label, confidence }`. */
export function classifyGPU(rendererString, cores = 0) {
  const s = normalizeRenderer(rendererString);
  for (const [re, tier, label] of GPU_TIERS) {
    if (re.test(s)) return { tier, label, confidence: 'known' };
  }
  // Masked ("Apple GPU", "Mozilla", "Google Inc.") or a GPU released after this table was written.
  // Core count is the only other thing that correlates: 8+ cores is a laptop/desktop class part.
  const tier = cores >= 8 ? 2 : 1;
  return { tier, label: s ? `unrecognised (${s.slice(0, 60)})` : 'unknown', confidence: 'guessed' };
}

/**
 * Read everything we can cheaply learn about the machine.
 * `gl` is optional — pass a live WebGL context to get the real renderer string; without one a
 * throwaway context is created and immediately released.
 */
export function detectHardware(gl = null) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  let renderer = '';
  let vendor = '';
  let maxTextureSize = 0;
  let webgl2 = false;
  let temp = null;
  try {
    let ctx = gl;
    if (!ctx && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      ctx = c.getContext('webgl2') || c.getContext('webgl');
      temp = ctx;
    }
    if (ctx) {
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      renderer = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER) || '');
      vendor = String(ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR) || '');
      maxTextureSize = ctx.getParameter(ctx.MAX_TEXTURE_SIZE) || 0;
      webgl2 = typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext;
    }
  } catch (err) {
    renderer = 'unavailable: ' + (err && err.message);
  }
  // release the throwaway context immediately — browsers cap live contexts at ~16
  try { temp && temp.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }

  const cores = Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : 0;
  const memoryGB = Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null;
  const dpr = Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
  const viewport = [win.innerWidth || 1280, win.innerHeight || 720];
  const touch = !!(nav.maxTouchPoints > 0);
  const hover = !!(win.matchMedia && win.matchMedia('(hover: hover)').matches);
  const gpu = classifyGPU(renderer, cores);

  return {
    renderer, vendor, maxTextureSize, webgl2,
    cores, memoryGB, dpr, viewport,
    /** phone/tablet: a touch screen with no real pointer */
    mobile: touch && !hover,
    gpuTier: gpu.tier, gpuLabel: gpu.label, gpuConfidence: gpu.confidence,
  };
}

/**
 * Pick the preset this machine should START at.
 * → `{ name, base, reasons:[string], hardware }`. Never returns above `AUTO_MAX`.
 */
export function recommendQuality(hw, { max = AUTO_MAX } = {}) {
  const reasons = [];
  const base = ['low', 'low', 'medium', 'high'][hw.gpuTier] || 'low';
  let idx = indexOf(base);
  reasons.push(`GPU tier ${hw.gpuTier} (${hw.gpuLabel}${hw.gpuConfidence === 'guessed' ? ', guessed from ' + hw.cores + ' cores' : ''}) → ${base}`);

  const cap = (name, why) => {
    const c = indexOf(name);
    if (c < idx) { idx = c; reasons.push(`${why} → cap ${name}`); }
  };
  if (hw.cores > 0 && hw.cores <= 4) cap('low', `${hw.cores} CPU cores`);
  else if (hw.cores > 0 && hw.cores <= 6) cap('medium', `${hw.cores} CPU cores`);
  // navigator.deviceMemory is clamped at 8 by the spec, so only the low end is informative.
  if (hw.memoryGB != null && hw.memoryGB <= 2) cap('low', `${hw.memoryGB} GB device memory`);
  else if (hw.memoryGB != null && hw.memoryGB <= 4) cap('medium', `${hw.memoryGB} GB device memory`);
  // Phones and tablets: the preset that matters is not the GPU's peak but the sustained,
  // thermally-throttled, battery-saving one — and the CPU-side simulation runs on one core.
  if (hw.mobile) cap('low', 'touch device without a pointer (phone/tablet)');
  if (hw.maxTextureSize && hw.maxTextureSize < 8192) cap('medium', `MAX_TEXTURE_SIZE ${hw.maxTextureSize}`);

  // Pixel pressure: cost per frame scales with the drawing buffer, which the panel decides.
  const pr = Math.min(hw.dpr, PRESET_PIXEL_RATIO[PRESET_ORDER[idx]] || 1);
  const pixels = hw.viewport[0] * hw.viewport[1] * pr * pr;
  if (hw.gpuTier <= 2 && pixels > PIXEL_BUDGET) {
    idx = clampIndex(idx - 1);
    reasons.push(`${(pixels / 1e6).toFixed(1)} Mpx drawing buffer on a non-discrete GPU → one step down`);
  }

  const ceiling = indexOf(max);
  if (idx > ceiling) { idx = ceiling; reasons.push(`automatic selection never exceeds ${max}`); }
  idx = clampIndex(idx);
  return { name: PRESET_ORDER[idx], base, reasons, hardware: hw };
}

/** One line for a console log or a settings panel. */
export function describeHardware(hw) {
  const bits = [
    hw.gpuLabel,
    `${hw.cores || '?'} cores`,
    hw.memoryGB != null ? `${hw.memoryGB} GB` : null,
    `DPR ${(+hw.dpr).toFixed(2).replace(/\.?0+$/, '')}`,
  ].filter(Boolean);
  return bits.join(' · ');
}

/** Step `name` down by `n` presets, floored at `low`. */
export function stepDown(name, n = 1) {
  return PRESET_ORDER[clampIndex(indexOf(name) - n)];
}

/** true when `a` is a cheaper preset than `b`. */
export function isCheaper(a, b) {
  return indexOf(a) < indexOf(b);
}
