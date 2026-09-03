# Native Android Port

## Current milestone

The repository now contains a native Kotlin Android application under `android/`. It is a real Android `Activity`, an OpenGL ES 3.0 renderer, and a Canvas HUD overlay — not a WebView or browser wrapper.

`GlCityRenderer` renders the world through a real GLES 3.0 pipeline on a `GLSurfaceView` (EGL 3.0 context, 24-bit depth): a deterministic seeded 96×96 terrain heightfield flattened under a prebuilt road network, a coastal water plane with animated Fresnel shading and sun glint, a ray-marched sky gradient with sun glow that shifts through dawn/day/dusk/night, distance fog matched to the horizon, ~a hundred seeded buildings whose windows glow warm at night, and 26 deterministic vehicles driving the avenue and cross streets. The renderer computes a bounded 16:9 viewport at runtime and letterboxes rather than stretching. A Canvas-drawn HUD overlay (`HudOverlayView`) provides large labelled touch controls above the GL surface.

## UI conversion decisions

The native HUD uses large labelled controls instead of the browser game's dense desktop toolbar. The essential tools are Select, Road, Zone, Service, and Bulldoze. Each tool is reachable from the bottom dock, reports its active state, provides a short action hint, and can be operated without a mouse, keyboard, hover state, or right-click. One-finger drag pans, pinch zooms, two-finger twist rotates, two-finger vertical drag pitches, and single taps apply the active tool through ray picking. Tool actions give immediate visible feedback through the message panel and city counters.

This is intentionally a redesign rather than a pixel-for-pixel port. A desktop layout can render on a phone while still requiring cursor precision, hover discovery, or keyboard shortcuts. Those interactions are not reliable on a touch screen, especially when the player is holding the device in landscape. The native layout therefore reserves a large bottom interaction band, keeps the city visible above it, uses explicit labels, and gives each action a pressed/selected visual state.

## Next port slices

1. Exercise the renderer on an emulator/device: cold start, rotation policy, background/resume, frame pacing, and automated on-device screenshot capture (the machine used for this milestone has no Android SDK, so these gates remain open).
2. Replace the procedural vertical-slice scene with the browser game's deterministic simulation data model (weekly economy, milestones, service coverage).
3. Add PBR material tiers and shadow mapping to the native renderer, then quality fallbacks for low-end devices.
4. Couple traffic to a lane network with routing instead of decorative lane driving.
5. Instrument frame time, draw count, memory, battery-sensitive warnings, and on-device capture, persisted to `docs/STATUS.json`.

## Verification status

This environment has no Android SDK, Gradle executable, or ADB/emulator. The GLES 3.0 renderer, GLSurfaceView conversion, HUD overlay, gesture handling, and persistence were reviewed line-by-line for API and Kotlin consistency, and the browser modules continue to pass `npx vite build`. Android compilation is verified by the GitHub Actions workflow on every push, which also publishes the APK as a commit-linked prerelease. Installation, on-device screenshots, lifecycle exercise, and frame-time measurement remain explicit follow-up gates and must not be reported as passed until an SDK and target device are available.
