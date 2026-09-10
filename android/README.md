# Fable Cities for Android (v2 — «web is the game»)

The app is a hardened, hardware-accelerated **WebView** hosting the ORIGINAL
Fable Cities web build from the repo root — 1:1, no gameplay or visual changes.
(The native GLES experiment lives on the `legacy-native` branch.)

## Build order (CI does this; do the same locally)

```bash
npm ci                 # web toolchain (vite 8, three 0.185)
npx vite build         # -> dist/  (base './' — relative URLs, works from any origin)
python3 tools/package_web.py     # dist/ -> android/app/src/main/assets/web + perf shim injected
cd android && gradle :app:assembleRelease   # signed with the committed android/debug.keystore
```

`tools/package_web.py` copies `dist/` into the APK assets and injects
`tools/perf_shim.js` as the FIRST script of the built `index.html` (the repo's
web sources are never modified on disk).

## What the app adds on top of the untouched game

| Concern | Mechanism |
|---|---|
| No white frame on boot | Dark `windowBackground` + Android-12 `windowSplashScreenBackground` (styles.xml, values-v31) + a NATIVE dark loading overlay installed in the first `onCreate` frame; the WebView stays `INVISIBLE` until the page reports `AndroidApp.frameReady()` (perf shim, window load + 2 rAF), then the overlay fades out and the game's own loading screen takes over |
| Performance (target 60 fps at full quality) | `tools/perf_shim.js` caps `devicePixelRatio` at 2.0 before the game scripts run (≈1.7x fewer shaded pixels, visually indistinguishable on 1080p panels) and creates WebGL contexts with `powerPreference=high-performance`; `MainActivity` runs a governor that raises the cap toward the panel DPR while fps ≥ 57 and lowers it while fps ≤ 38 — quality returns to 100 % automatically whenever the GPU can afford it |
| Rotation / background | `configChanges` in the manifest — the page is never reloaded; renderer priority stays `IMPORTANT` |
| Crash capture | Default uncaught handler appends to `/sdcard/Android/data/com.fablecities.android/files/crash.txt`; page console output mirrors to logcat under `FableWeb` |
| Local content | All game assets ship inside the APK (~215 MB) via `WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/…`) so `fetch()`/audio/WebGL all work on a first-class https origin |

## Debug parameters

`adb shell am start -n com.fablecities.android/.MainActivity --es params "demo=1&quality=low&map=1024"`
forwards the query to the game's own `Config` (quality presets, map size) —
this is also what the CI emulator gate boots with.
