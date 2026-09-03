# Native Android Port

## Current milestone

The repository now contains a native Kotlin Android application under `android/`. It is a real Android `Activity` and custom `View`, not a WebView or browser wrapper. The first vertical slice establishes the platform shell, native rendering surface, landscape orientation policy, a 16:9 logical viewport, touch camera panning, and a playable city-builder interaction loop.

The renderer uses a logical 1920×1080 surface. It calculates a bounded viewport at runtime and preserves the 16:9 aspect ratio. A device with a wider or taller aspect ratio receives letterboxing rather than stretched geometry or controls. The app requests immersive fullscreen and handles pause/resume through the Android activity lifecycle.

## UI conversion decisions

The native HUD uses large labelled controls instead of the browser game's dense desktop toolbar. The essential tools are Select, Road, Zone, Service, and Bulldoze. Each tool is reachable from the bottom dock, reports its active state, provides a short action hint, and can be operated without a mouse, keyboard, hover state, or right-click. Dragging the playfield pans the camera. Tapping the pause panel pauses or resumes the simulation. Tool actions give immediate visible feedback through the message panel and city counters.

This is intentionally a redesign rather than a pixel-for-pixel port. A desktop layout can render on a phone while still requiring cursor precision, hover discovery, or keyboard shortcuts. Those interactions are not reliable on a touch screen, especially when the player is holding the device in landscape. The native layout therefore reserves a large bottom interaction band, keeps the city visible above it, uses explicit labels, and gives each action a pressed/selected visual state.

## Next port slices

1. Replace the procedural vertical-slice scene with the browser game's deterministic terrain, roads, zones, buildings, traffic, weather, and simulation data model.
2. Add a native persistence layer for city saves and a first-run onboarding flow.
3. Add pinch zoom, two-finger camera rotation, selection hit testing, contextual inspectors, and accessible text sizing.
4. Move rendering from the Canvas prototype to an OpenGL ES 3.0 renderer once the native world data model is in place, then add PBR materials, lighting, shadows, and quality tiers.
5. Add instrumentation for frame time, draw count, memory, battery-sensitive warnings, and automated screenshot capture.

## Verification status

The environment used for this milestone does not contain an Android SDK, Gradle executable, or ADB/emulator. The source and Gradle configuration were checked structurally, and `git diff --check` passes. Android compilation, installation, screenshot capture, and physical-device testing remain explicit follow-up gates and must not be reported as passed until an SDK and target device are available.
