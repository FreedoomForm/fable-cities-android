# tools/README — local probe harness notes

- The Node probes (probe_*.mjs) import the site's real web modules with a minimal CPU shim at
  `node_modules/three/index.js` (gitignored). If it is missing, recreate it: it must export
  Vector2, Vector3, Color, DataTexture, Data3DTexture (see scripts/fable/tools/probe_water.mjs usage).
- Local JVM loop: `tools/localcheck.sh` (kotlinc at /tmp/kotlinc) type-checks app+tests against
  tools/kotlinc-stubs; scripts/run_all_tests.kt runs every parity suite (39 tests as of the
  cloud slice) without Gradle.
