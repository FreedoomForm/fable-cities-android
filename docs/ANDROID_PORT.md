# Native Android Port

## Current milestone

The repository ships a **dual-track APK**:

- **Track A — web-parity launcher (`ParityActivity`, the launcher icon).** The user's acceptance criterion is a 1:1 visual match with the browser game ("сохранив визуал один в один"). The browser game's look is produced by a three.js PBR + CSM + bloom + SMAA stack that a hand-written GLES renderer can not reproduce quickly, so the full production web build (`vite build` output, ~208 MB incl. CC0 texture sets and models) is bundled into the APK at CI build time (`android/app/src/main/assets/web/`, generated — never committed) and served offline through `WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/web/`). ES modules, fetch and localStorage need a real http(s) origin, which `file://` cannot provide. Touch mapping: one finger = the page's native pointer behaviour (tools, UI); an injected shim maps pinch → wheel (zoom) and two-finger drag → middle-button drag (pan, the desktop camera binding); the Android Back button dispatches Escape (menus). This track is not a substitute for the native renderer — it is the user-facing visual-parity deliverable and is explicitly allowed by the user's clarified priority, superseding the original "no WebView at all" reading for this track only.
- **Track B — native GLES renderer (`MainActivity`, adb-launchable, CI-gated).** A real Android `Activity`, an OpenGL ES 3.0 renderer, and a Canvas HUD overlay. `GlCityRenderer` renders through a GLES 3.0 pipeline on a `GLSurfaceView`: a deterministic seeded 96×96 terrain heightfield, a coastal water plane with animated Fresnel shading, a ray-marched sky gradient, distance fog, ~a hundred seeded buildings whose windows glow warm at night, and 26 deterministic vehicles. It computes a bounded 16:9 viewport at runtime and letterboxes rather than stretching. A Canvas-drawn HUD overlay provides large labelled touch controls above the GL surface. Porting the full three.js visual stack natively (PBR, cascaded shadow maps, GTAO, bloom, SMAA) remains the long-term goal of this track and is worked in parity slices.

## UI conversion decisions

The native HUD uses large labelled controls instead of the browser game's dense desktop toolbar. The essential tools are Select, Road, Zone, Service, and Bulldoze. Each tool is reachable from the bottom dock, reports its active state, provides a short action hint, and can be operated without a mouse, keyboard, hover state, or right-click. One-finger drag pans, pinch zooms, two-finger twist rotates, two-finger vertical drag pitches, and single taps apply the active tool through ray picking. Tool actions give immediate visible feedback through the message panel and city counters.

This is intentionally a redesign rather than a pixel-for-pixel port. A desktop layout can render on a phone while still requiring cursor precision, hover discovery, or keyboard shortcuts. Those interactions are not reliable on a touch screen, especially when the player is holding the device in landscape. The native layout therefore reserves a large bottom interaction band, keeps the city visible above it, uses explicit labels, and gives each action a pressed/selected visual state.

## Next port slices

1. Exercise both tracks on an emulator/device: CI runs an `emulator-smoke` job on every push (API 34 x86_64, KVM, swiftshader GPU): it installs the APK, boots the web-parity launcher first (90 s soak — three.js first boot is slow on swiftshader; gates: process alive, zero page console errors, screenshot), then force-stops and boots the native activity (20 s soak; gates: process alive, zero fatal/native-signal lines, zero `GlCityRenderer` shader/link/GL-error lines, screenshot). An APK that fails either gate is never published. Still open: rotation policy, background/resume stress, real-device frame pacing, twist→rotate on the parity track.
2. Replace the procedural vertical-slice scene with the browser game's deterministic simulation data model (weekly economy, milestones, service coverage).
3. Add PBR material tiers and shadow mapping to the native renderer, then quality fallbacks for low-end devices.
4. Couple traffic to a lane network with routing instead of decorative lane driving.
5. Instrument frame time, draw count, memory, battery-sensitive warnings, and on-device capture, persisted to `docs/STATUS.json`.

## Verification status

This environment has no Android SDK, Gradle executable, or ADB/emulator. The GLES 3.0 renderer, GLSurfaceView conversion, HUD overlay, gesture handling, and persistence were reviewed line-by-line for API and Kotlin consistency, and the browser modules continue to pass `npx vite build`. Android compilation is verified by the GitHub Actions workflow on every push, which also publishes the APK as a commit-linked prerelease. Installation, on-device screenshots, frame-count verification, and crash monitoring now run in CI on every push via the emulator gate; rotation/background-resume stress and real-device frame pacing remain explicit follow-up gates and must not be reported as passed until exercised.
