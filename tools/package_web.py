#!/usr/bin/env python3
"""Package the built web game into the Android APK assets.

Pipeline position:  npm ci -> vite build -> THIS SCRIPT -> gradle assembleRelease.

What it does:
  1. copies dist/ -> android/app/src/main/assets/web (clean copy);
  2. injects tools/perf_shim.js as the FIRST script in the built index.html
     (idempotent: skipped if the marker is already there);
  3. prints the bundle inventory so the CI log shows exactly what shipped.

The web code itself is NOT modified on disk — the injection happens on the copy,
so the repo's web sources stay byte-identical to the original game.
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
ASSETS = os.path.join(ROOT, "android", "app", "src", "main", "assets", "web")
SHIM = os.path.join(ROOT, "tools", "perf_shim.js")
MARKER = "window.__fc"


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if not os.path.isdir(DIST):
        fail(f"{DIST} missing — run `npx vite build` first")
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        fail("dist/index.html missing — the web build did not produce an entry point")

    if os.path.exists(ASSETS):
        shutil.rmtree(ASSETS)
    shutil.copytree(DIST, ASSETS)

    shim = open(SHIM, encoding="utf-8").read()
    idx = os.path.join(ASSETS, "index.html")
    html = open(idx, encoding="utf-8").read()
    if MARKER not in html:
        if "<head>" not in html:
            fail("dist/index.html has no <head> tag — cannot inject the perf shim")
        html = html.replace("<head>", "<head>\n    <script>\n" + shim + "\n    </script>", 1)
        open(idx, "w", encoding="utf-8").write(html)
        print("perf shim injected into index.html")
    else:
        print("perf shim already present — skipped")

    files = 0
    total = 0
    for r, _dirs, fs in os.walk(ASSETS):
        for f in fs:
            files += 1
            total += os.path.getsize(os.path.join(r, f))
    print(f"web bundle packaged: {files} files, {total / 1048576:.1f} MB -> android/app/src/main/assets/web")
    if total < 5 * 1048576:
        fail("web bundle is suspiciously small (<5 MB) — the build likely produced an empty shell")
    if files < 50:
        fail("web bundle has suspiciously few files (<50) — game assets missing?")


if __name__ == "__main__":
    main()
