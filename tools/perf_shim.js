/* Fable Cities Android perf shim — injected by tools/package_web.py as the FIRST script
 * in the built index.html. Zero gameplay/visual changes:
 *   1. devicePixelRatio governor hooks (the native side starts it capped at 2.0 and
 *      auto-tunes between 1.0 and the panel DPR to hold 60 fps — quality returns to
 *      100% automatically whenever the GPU can afford it);
 *   2. WebGL contexts get powerPreference=high-performance;
 *   3. a tiny FPS meter + boot bridge (AndroidApp.frameReady lifts the native splash
 *      after the page's own loading screen is up; AndroidApp.log mirrors boot messages).
 */
(function () {
  if (window.__fc) return;
  var fc = { real: 1, cap: 0, fps: 0 };
  window.__fc = fc;
  try {
    var real = window.devicePixelRatio || 1;
    fc.real = real;
    // Cap BEFORE the game scripts run, so the renderer is born at the governed
    // resolution (2.0 is visually indistinguishable from a 2.6+ phone panel but
    // shades ~1.7x fewer pixels). The native governor later raises/lowers it live.
    fc.cap = Math.min(real, 2.0);
    try {
      Object.defineProperty(window, 'devicePixelRatio', {
        get: function () { return Math.min(fc.real, fc.cap); },
        configurable: true
      });
    } catch (e) { /* very old engine: governor degrades to a no-op */ }
    window.__fcSetCap = function (c) {
      var v = Number(c);
      if (!isFinite(v)) return;
      fc.cap = Math.max(1.0, Math.min(fc.real, v));
    };
    window.__fcGetFps = function () { return fc.fps | 0; };

    var frames = 0, last = performance.now();
    function tick(t) {
      frames++;
      if (t - last >= 1000) { fc.fps = frames; frames = 0; last = t; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    var origGet = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      try {
        if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
          attrs = Object.assign({}, attrs || {}, { powerPreference: 'high-performance' });
        }
      } catch (e) { /* fall through untouched */ }
      return origGet.call(this, type, attrs);
    };
  } catch (e) {
    try { window.AndroidApp && AndroidApp.log('shim-error: ' + e); } catch (_) {}
  }

  // Boot bridge: after the page finished loading and painted 2 real frames, let the
  // native splash step aside — the game's own loading screen (progress bar) takes over.
  window.addEventListener('load', function () {
    try { window.AndroidApp && AndroidApp.log('page-load'); } catch (_) {}
    var n = 0;
    function frame() {
      n++;
      if (n >= 2) {
        try { window.AndroidApp && AndroidApp.frameReady(); } catch (_) {}
      } else {
        try { requestAnimationFrame(frame); } catch (_) {
          try { window.AndroidApp && AndroidApp.frameReady(); } catch (_2) {}
        }
      }
    }
    try { requestAnimationFrame(frame); } catch (_) {
      try { window.AndroidApp && AndroidApp.frameReady(); } catch (_3) {}
    }
  });
})();
