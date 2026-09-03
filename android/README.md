# Fable Cities Native Android

This module is the native Android implementation. It is intentionally separate from the legacy browser client while the simulation systems are ported incrementally.

## Rendering architecture

The world is rendered by `GlCityRenderer` on a real **OpenGL ES 3.0** pipeline (`GLSurfaceView` with an EGL 3.0 context and a 24-bit depth buffer). There is no WebView, browser runtime, or wrapped web export anywhere in the app.

- **Terrain** — deterministic 96×96 heightfield over an 800 m map (seeded value-noise FBM), flattened under the prebuilt road network, with per-vertex grass/sand/verge coloring and a coastal dip below the water plane.
- **City ground** — prebuilt avenue plus three cross streets as asphalt quads with painted centre dashes and sidewalks.
- **Buildings** — seeded per-block generation (residential / commercial / office / service kinds), drawn as shaded boxes with a fragment-shader window grid whose windows emit warm light at night (lit fraction ramps with sun elevation) and a cyan selection highlight for the Select tool.
- **Vehicles** — 26 deterministic three-part cars (body, cabin glass, chassis) driving the avenue and cross streets in both lanes.
- **Sky** — full-screen ray-marched gradient (zenith→horizon palette by sun elevation) with sun disc glow, plus a separate horizon tone below the horizon line.
- **Water** — translucent animated plane with Fresnel sky mixing and a sun glint.
- **Lighting** — directional sun (warm at low elevation, off at night), hemisphere ambient (cool blue at night), exponential distance fog matched to the horizon color.
- **Camera** — damped orbit camera (target/yaw/pitch/distance) with a 50° perspective inside the letterboxed 16:9 viewport.

## Touch interaction map

Everything essential is reachable with one thumb; no hover, right-click, cursor, or keyboard.

| Gesture | Action |
|---|---|
| One-finger drag on the map | Pan the camera target |
| Two-finger pinch | Zoom in/out (60–620 m) |
| Two-finger twist | Rotate camera yaw |
| Two-finger vertical drag | Pitch |
| Single tap with Select tool | Inspect the tapped building |
| Single tap with Road tool | Place / remove a road cell |
| Single tap with Zone tool | Cycle residential → commercial → industrial → clear on a cell |
| Single tap with Service tool | Build a service building on an empty lot |
| Single tap with Bulldoze tool | Demolish the tapped building |
| Tap dock buttons | Switch tools (large labelled buttons, active state) |
| Tap pause panel | Pause / resume the simulation |

## Files

- `MainActivity.kt` — fullscreen immersive landscape activity; hosts the GL view + HUD overlay in a FrameLayout; forwards lifecycle to both.
- `FableCitiesView.kt` — `GLSurfaceView` subclass; gesture recognition and tool taps, persistence bridging.
- `GlCityRenderer.kt` — the OpenGL ES 3.0 renderer described above (world generation, shaders, picking, edits).
- `HudOverlayView.kt` — Canvas-drawn HUD (top bar, tool dock, message toast, pause panel) drawn over the GL surface inside the letterboxed 1920×1080 logical surface.
- `CityState.kt` — SharedPreferences persistence: money, population, day/hour, selected tool, road/zone edits, camera state.

## Persistence

City edits (road/zone cells) and the camera are serialized into `CityState` and restored on the next launch, including after process death. Saves are written on lifecycle pause and debounced after edits.

## Build

Open this `android/` directory in Android Studio, allow Gradle to sync, and run the `app` configuration on an Android emulator or physical device. The project targets SDK 35, supports Android API 26+, and locks the activity to landscape. The app uses a 1920×1080 logical surface and preserves that 16:9 ratio with bounded letterboxing; the sky may fill the full surface while gameplay stays inside the letterbox.

From a machine with the Android SDK and Gradle available, the equivalent commands are:

```bash
gradle :app:assembleDebug
gradle :app:installDebug
```

Every push to `main` builds the APK and publishes it as a commit-linked prerelease through GitHub Actions (see `.github/workflows/android-release.yml`).

## Honest status / known limits

- Verified only by CI compilation and code review so far — no emulator or device run has exercised this renderer yet; instrumented screenshot capture on-device is still an open gate.
- No shadow mapping; buildings use cheap shading without cast shadows.
- Procedural geometry and vertex colors only — no PBR texture pipeline yet.
- Traffic is decorative (no lane network or simulation coupling yet).
- Simulation is the slice-level economy (zone paint grows population; actions cost money), not the browser game's full weekly simulation.
