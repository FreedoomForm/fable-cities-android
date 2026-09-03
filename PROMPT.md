<div align="center">

<h1>The Prompt</h1>

**The instruction this project runs on.**

No framework, no scaffolding, no per-module briefs written by hand.
It is handed to Claude Code once, and the model does the rest — including deciding what "the rest" is.

</div>

<br>

> [!NOTE]
> Copy the raw file and swap the domain. The structure works for anything that can be screenshotted,
> measured, or otherwise checked by the machine that produced it — the game is only the example.
> This version is specifically for converting the existing browser game into a **native Android game**
> with a deliberate **16:9 landscape presentation**.

<br>

---

<br>

# Goal

Convert the existing browser game into a native Android city builder that reaches Cities: Skylines II–class visual ambition while preserving and improving the current game's core experience. Use Kotlin and the Android SDK with a native real-time rendering path such as OpenGL ES 3.0 or Vulkan. Do not ship the browser game inside a WebView, rely on a browser runtime, or treat a wrapped web export as native. The game must run as a signed, installable APK or app bundle on Android devices, support touch-first interaction, and present the designed game surface in a locked **16:9 landscape ratio** with consistent framing across supported 16:9 resolutions.

The bar is AAA: photographic PBR materials, physically plausible sun/sky/shadows, atmospheric depth, a living city at night, believable roads and traffic, responsive touch controls, readable UI, stable frame pacing, and graceful lifecycle handling. Never programmer art. First inspect the existing web game, its assets, rules, camera, simulation, UI, and reference material. Then reproduce the important gameplay and visual intent natively rather than mechanically porting browser implementation details.

The UI is a redesign, not a direct PC port. Replace PC assumptions such as hover-only affordances, right-click actions, tiny toolbar icons, keyboard shortcuts, simultaneous mouse-and-keyboard controls, dense desktop panels, and interactions that depend on pixel-precise cursor placement. Design the primary experience for a person holding or tapping an Android device in landscape at 16:9: keep the city visible, group frequent actions within comfortable thumb reach, use large clearly labelled controls, provide pressed/selected/disabled states, make destructive actions confirmable, and expose every essential action through touch. Use gestures only when their meaning is discoverable and provide an obvious alternative for precision actions. Keep text readable at the intended viewing distance, respect system cutouts and safe areas, and ensure overlays never hide the information needed to make the current decision. The reason for this change is functional: a PC layout can technically render on Android while remaining slow, error-prone, fatiguing, and unusable without a mouse and keyboard. The native version is successful only when its controls are comfortable, discoverable, and reliable on a 16:9 touch screen.

# How to work
1. Architecture first. Before any feature code, write ARCHITECTURE.md: one folder or package per subsystem (terrain, environment, roads, zoning, buildings, props, traffic, effects, simulation, tools, ui, audio, demo city, platform), a shared world data model, the public API each module must expose, the events it emits, units (metres, +Y up), determinism (seeded RNG only), a performance budget (stable 60 fps target at 1920×1080-equivalent rendering, with a documented fallback budget for lower-end devices), memory and battery budgets, and an asset policy (CC0 only: Poly Haven, ambientCG, or procedural). Define the native rendering, input, persistence, orientation, lifecycle, and asset-loading boundaries. The UI architecture must document the Android information hierarchy, safe-area layout, touch target sizes, gesture map, thumb zones, modal behavior, feedback states, and the mapping from each existing PC action to its redesigned touch interaction. Isolate module failures so one broken module never takes the game down.
2. Build the verification loop before the game. Create an emulator/device test tool that installs or launches the native app, waits until it is ready, sets a camera preset and time of day, captures screenshots at the canonical 16:9 viewport, and writes PNG + a JSON log (Android logcat errors, crashes, frame time/fps, render resolution, draw calls, memory, and battery-relevant warnings). Add automated checks for cold start, background/resume, rotation policy, touch hit targets, save/load, and low-memory recovery. Add a UI usability checklist and interaction test for every essential action: reachable by touch, readable, visible in the correct context, visually confirms its state, and usable without a mouse, keyboard, hover, or right-click. Every module also ships a "showcase" mode that stages a representative scene of just that module. No agent may claim anything it hasn't installed, exercised, screenshotted, and looked at.
3. Fan out. Use multi-agent orchestration ("ultracode"). One builder agent per module, each owning only its folder or package. Run in waves ordered by dependency: (1) native shell/rendering, terrain, sky/weather, roads, simulation, UI, audio, effects; (2) zoning, buildings, props, traffic, build tools, touch input; (3) persistence, lifecycle hardening, performance tuning, accessibility, demo city and release packaging. Between waves, one integrator agent (the only one allowed to touch shared core and Gradle configuration) applies builders' core-change requests and fixes the seams.
4. Gauntlet every module. After each builder round, a separate critic agent (a brutal AAA art director and Android QA lead who writes no code) installs the build and takes its own screenshots at several times of day, camera distances, and supported 16:9 resolutions. It checks the API contract, Android logcat, crashes, touch behavior, lifecycle recovery, memory, frame pacing, and perf. It also performs the main flows with touch only and rejects any screen that is merely a shrunken desktop UI: controls must be discoverable, thumb-reachable, large enough to tap accurately, readable over the game, and clear about mode and feedback. It then scores 0–10 against real Cities: Skylines II reference screenshots and a real-device usability bar: 10 = indistinguishable and production-ready, 8.5 = AAA with nits, 7 = good indie, 5 = programmer art or fragile mobile behavior. Pass = ≥8.5 with zero errors, no reproducible lifecycle defects, no 16:9 layout violations, and no essential PC-only interaction. Below that, the builder gets the ranked issue list and goes again, up to 4 rounds.
5. Final gate. A whole-game critic installs a release-like build, scores the demo city, and verifies the complete new-player experience from first launch through save/load and resume. The critic must complete the core loop using touch only and explain how a first-time Android player discovers camera movement, selection, construction, cancellation, menus, pause, and save. Then blind judges get pairs of screenshots labelled only A and B (ours vs. Cities: Skylines II, order shuffled) captured at the same 16:9 composition and say which looks better and why. A separate Android QA pass verifies installation, cold start, touch controls, audio focus, pause/resume, persistence, performance, safe-area behavior, and behavior on at least one emulator and one representative physical device when available.
6. /loop until every critic passes. Persist scores, device profiles, benchmark results, screenshots, and open issues to docs/STATUS.json so each iteration resumes from the weakest module, device, or viewport rather than from scratch.
7. Checkpoint continuously. After every verified milestone or coherent slice, commit the changes with a focused message and push the commit to the connected GitHub remote. Push before changing phases, before a long verification run, and before the context or usage budget becomes a risk. Keep the working tree clean after each checkpoint, and record the commit hash and verification result in the handoff or status notes so another agent can resume without losing work.
8. Use GitHub Actions for long-running work. Do not keep the agent session occupied with long APK builds, instrumentation tests, emulator tests, benchmark runs, or release packaging when the work can run in CI. Create or maintain a GitHub Actions workflow that starts on every push to the active branch, builds the Android APK, runs all available automated checks, stores logs and test reports, and publishes the resulting APK as a GitHub Release attached to that commit. Use a unique, traceable release tag such as `android-build-<short-sha>` (or another collision-free tag), mark the release as prerelease when it is not a production build, and never publish an APK when the build or required tests fail. The workflow must report its status back to the commit so failures are visible instead of being hidden in the agent session.

# Rules
- Never inflate scores. Report real numbers, failed rounds, device conditions, and what is still missing.
- Never edit another module's folder or package. Core and Gradle changes go through the integrator.
- Keep the native build installable and launchable at all times; other agents are installing, exercising, and screenshotting it.
- Never substitute a WebView, browser wrapper, or unverified mock for a native implementation.
- Commit and push periodically. Do not accumulate an unpushed pile of unrelated changes; each verified milestone must be recoverable from GitHub.
- Delegate long computations to GitHub Actions. APK assembly, instrumentation tests, emulator tests, benchmarks, and release packaging belong in CI whenever possible; the agent should monitor the result, inspect artifacts and logs, fix failures, and push a follow-up commit.
- After every successful commit and push, the Android CI workflow must build and test the APK and publish that exact artifact as a GitHub Release attached to the same commit. A failed build or failed required test must block release publication.
- Treat 16:9 landscape as the canonical design surface. Keep important gameplay and UI inside the safe area, preserve aspect ratio, and use intentional letterboxing or bounded scaling instead of stretching when the device differs from 16:9.
- Redesign the PC UI for Android instead of shrinking or wrapping it. Use touch-first controls with forgiving hit targets, clear pressed states, readable labels, discoverable gestures, thumb-friendly placement, contextual toolbars, and no feature that depends on hover, right-click, a cursor, or a physical keyboard. Support back, pause, and system lifecycle events safely.
- Do not ask me questions. Make routine decisions yourself, state assumptions, keep going.

Start now.

<br>

---

<br>

## Why it is shaped this way

Each numbered step exists because leaving it out breaks something specific.

| Step | What it prevents |
|:--|:--|
| **Architecture first** | A dozen agents editing the same files, plus a port that accidentally preserves browser assumptions. The contract is what makes parallelism safe — it is ordinary interface-first design, and it works better for agents than it does for people. |
| **Tooling before features** | Hallucinated success. Without an install-and-capture loop, a model will cheerfully report that a broken renderer "looks beautiful" and miss crashes, lifecycle bugs, or stretched 16:9 layouts. |
| **A native UI redesign** | A browser game can be technically ported while retaining tiny desktop controls, hover states, keyboard dependencies, and dense panels that are frustrating on a touch screen. The game must be redesigned around Android reachability, readability, discoverability, and feedback. |
| **Fan out in dependency waves** | Agents blocking on each other, or building against an API, renderer, or input layer that does not exist yet. |
| **A separate critic** | Grade inflation. A model reviewing its own work is far too generous. The critic writes no code, so it has nothing to defend. |
| **An anchored 0–10 scale** | "Looks good" as an acceptance criterion. Written anchors — *8.5 = AAA with nits, 5 = programmer art or fragile mobile behavior* — make the score mean the same thing in every round. |
| **A blind final gate** | Judging your own child. Labelled *A* and *B* with the order shuffled, the judge cannot flatter the home team. |
| **Persisted state** | Starting over. Every iteration picks up at the weakest module, device, or viewport instead of re-deriving what is already done. |
| **Periodic commits and pushes** | Losing a long native port to a failed session or context limit. Small, focused remote checkpoints make the work recoverable and make the current implementation state explicit. |
| **GitHub Actions and per-commit APK releases** | Spending the agent session waiting for long builds or tests, and losing the exact APK associated with a change. CI provides repeatable execution, visible failure status, retained logs, and a downloadable artifact tied to the source commit. |

If you only take two things from this: **make a separate critic**, and **make the agent install and look at its native output before it is allowed to say "done"**. Those two alone carry most of the weight.

## How it actually went

Honest, because the prompt itself says never to inflate anything:

- The first implementation established the terrain, sky, roads, simulation, HUD and audio, then hit a usage limit.
- Six runs later the game was playable. About 20 million output tokens were spent across the agents.
- **No module ever cleared the 8.5 bar**, and three rounds of blind judging were lost 0–4 each time.
  The gap narrowed from 3.4 points to 2.5. One judge said our frame "wins atmosphere and composition
  outright" before killing it on material physics.
- A first-session critic scored the new-player experience 5.5 out of 10 and did not pass it.

This history is retained as a warning: the native Android conversion must not call itself complete because the app builds or because one attractive screenshot works. Preserve the original critique evidence where it remains relevant, and add native Android findings under [`docs/critique/`](docs/critique/), including failed rounds, device conditions, and 16:9 layout issues.

Everything the critics wrote is in [`docs/critique/`](docs/critique/), unedited, including the rounds
where scores went down.

<br>

<div align="center">

[← Back to the project](README.md)

</div>
