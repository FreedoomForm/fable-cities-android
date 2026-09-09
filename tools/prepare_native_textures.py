#!/usr/bin/env python3
"""
Bake the 8 terrain PBR layers into the APK's native assets.

TerrainGfx.kt decodes shared/<Layer>/{color,normal,roughness,ao}.jpg from the APK
assets and rescales everything to LAYER_SIZE = 512. The repo's source textures are
4K (public/assets/shared, ~42 MB for the 8 layers) — far too heavy to ship raw.
This script resamples each of the 32 files to 512x512 with a Lanczos filter and
writes them under android/app/src/main/assets/shared/, adding ~1.5 MB to the APK.

Run once whenever the source textures change:  python3 tools/prepare_native_textures.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow required: pip install pillow")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "public", "assets", "shared")
DST = os.path.join(REPO, "android", "app", "src", "main", "assets", "shared")
SIZE = 512
QUALITY = 88

# TerrainGfx.kt LAYERS — keep in sync.
LAYERS = ["Grass004", "Grass003", "Ground048", "Rock030",
          "Ground033", "Ground054", "Rock035", "forest_floor"]
FILES = ["color.jpg", "normal.jpg", "roughness.jpg", "ao.jpg"]


def main() -> int:
    total_in = total_out = 0
    for layer in LAYERS:
        for name in FILES:
            src = os.path.join(SRC, layer, name)
            if not os.path.isfile(src):
                if name == "ao.jpg":      # optional on the web (catch -> 255)
                    continue
                print(f"MISSING required {src}", file=sys.stderr)
                return 1
            out_dir = os.path.join(DST, layer)
            os.makedirs(out_dir, exist_ok=True)
            out = os.path.join(out_dir, name)
            img = Image.open(src).convert("RGB")
            if img.width != SIZE or img.height != SIZE:
                img = img.resize((SIZE, SIZE), Image.LANCZOS)
            img.save(out, "JPEG", quality=QUALITY, optimize=True, progressive=False)
            total_in += os.path.getsize(src)
            total_out += os.path.getsize(out)
            print(f"{layer}/{name}: {os.path.getsize(src)//1024} KB -> {os.path.getsize(out)//1024} KB")
    print(f"TOTAL {total_in // 1048576} MB -> {total_out // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
