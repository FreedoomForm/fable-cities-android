#!/usr/bin/env python3
"""
Downscale bundled web-game textures for the Android APK (parity track).

The browser build ships CC0 4K texture sets + GLTF model textures (~208 MB).
On a phone the WebView never shows more than ~1024 px of any of them, and the
APK pays the full cost. This script re-encodes every image under the bundle:

  - max dimension > 1024 -> resized to 1024 (LANCZOS)
  - JPEG -> quality 82, progressive, stripped
  - PNG  -> optimize + compress_level 9 (formats/URLs untouched, so GLTF
            texture references keep resolving)

Run AFTER `vite build` on dist/assets (or any assets dir), in place.
Usage: python3 tools/downscale_assets.py <dir> [maxDim]
"""
import sys
import os

from PIL import Image

Image.MAX_IMAGE_PIXELS = 512 * 1024 * 1024  # CC0 sets can be large but are safe


def main():
    root = sys.argv[1]
    max_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    if not os.path.isdir(root):
        print(f"not a directory: {root}")
        sys.exit(1)

    total_before = 0
    total_after = 0
    touched = 0
    scanned = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in (".png", ".jpg", ".jpeg", ".webp"):
                continue
            path = os.path.join(dirpath, name)
            before = os.path.getsize(path)
            total_before += before
            scanned += 1
            try:
                with Image.open(path) as im:
                    im.load()
                    w, h = im.size
                    scale = max(w, h)
                    if scale > max_dim:
                        nw = round(w * max_dim / scale)
                        nh = round(h * max_dim / scale)
                        im = im.resize((nw, nh), Image.LANCZOS)
                    if ext in (".jpg", ".jpeg"):
                        if im.mode not in ("RGB", "L"):
                            im = im.convert("RGB")
                        im.save(path, "JPEG", quality=82, progressive=True, optimize=True)
                    elif ext == ".webp":
                        im.save(path, "WEBP", quality=82, method=4)
                    else:
                        if im.mode == "P":
                            im.save(path, "PNG", optimize=True, compress_level=9)
                        else:
                            im.save(path, "PNG", optimize=True, compress_level=9)
                after = os.path.getsize(path)
                total_after += after
                if after != before:
                    touched += 1
            except Exception as e:  # noqa: BLE001 - report and continue
                print(f"WARN {path}: {e}")
                total_after += before

    mb_b = total_before / (1024 * 1024)
    mb_a = total_after / (1024 * 1024)
    print(f"scanned={scanned} touched={touched} before={mb_b:.1f} MB after={mb_a:.1f} MB ({100 * mb_a / max(mb_b, 1e-9):.1f}%)")


if __name__ == "__main__":
    main()
