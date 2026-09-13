#!/usr/bin/env python3
"""Generate SHIT/stSHIT/wstSHIT token icons from the circuit-poop base image.

Reads the base image from frontend/public/pictures/shit/5h1t-poop.png
(the AI-generated circuit poop emoji) and writes hue-shifted variants:

  - 5h1t-poop.png        → SHIT    (original colors: purple body, orange smile)
  - 5h1t-poop-green.png  → stSHIT  (hue +60: green-shifted)
  - 5h1t-poop-blue.png   → wstSHIT (hue +180: blue-shifted)

Outputs:
  frontend/icons/token-SHIT.png
  frontend/icons/token-stSHIT.png
  frontend/icons/token-wstSHIT.png
  frontend/public/pictures/shit/5h1t-poop{,-green,-blue}.png

Usage:
  python3 scripts/make-token-icons.py [path/to/base.png]
"""
import sys
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
PUBLIC_DIR = FRONTEND / "public" / "pictures" / "shit"
ICONS_DIR = FRONTEND / "icons"

# Hue rotation per variant (degrees on the color wheel)
VARIANTS = {
    "": 0,          # SHIT — original
    "-green": 60,   # stSHIT — staked variant
    "-blue": 200,   # wstSHIT — wrapped variant
}

ICON_SIZES = {"": 256, "-green": 256, "-blue": 256}


def hue_shift(img: Image.Image, degrees: float) -> Image.Image:
    """Rotate hue by `degrees` while preserving alpha."""
    img = img.convert("RGBA")
    alpha = img.getchannel("A")
    hsv = img.convert("HSV")
    h, s, v = hsv.split()
    shift = int(degrees / 360 * 255)
    h = h.point(lambda p: (p + shift) % 256)
    out = Image.merge("HSV", (h, s, v)).convert("RGBA")
    out.putalpha(alpha)
    return out


def crop_to_content(img: Image.Image, pad_frac: float = 0.04) -> Image.Image:
    """Trim transparent/black border and crop to the subject."""
    rgba = img.convert("RGBA")
    # Use luminance to find the subject (the dark bg reads as ~black)
    gray = rgba.convert("L")
    bbox = gray.point(lambda p: 255 if p > 12 else 0).getbbox()
    if not bbox:
        return rgba
    w, h = rgba.size
    pad = int(min(w, h) * pad_frac)
    l, t, r, b = bbox
    return rgba.crop((max(0, l - pad), max(0, t - pad), min(w, r + pad), min(h, b + pad)))


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else PUBLIC_DIR / "5h1t-poop.png"
    if not src_path.exists():
        sys.exit(f"Base image not found: {src_path}\n"
                 f"Save the circuit-poop image to {PUBLIC_DIR}/5h1t-poop.png first.")

    base = Image.open(src_path)
    cropped = crop_to_content(base)
    # Square canvas, centered
    side = max(cropped.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))

    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    for suffix, deg in VARIANTS.items():
        variant = square if deg == 0 else hue_shift(square, deg)
        # Public copy (used by SHITLogo + pages)
        pub = PUBLIC_DIR / f"5h1t-poop{suffix}.png"
        variant.save(pub)
        # Icon copy (used by <Icon name="...TokenIcon">)
        icon_size = ICON_SIZES[suffix]
        icon = variant.resize((icon_size, icon_size), Image.LANCZOS)
        icon_name = {"": "token-SHIT.png", "-green": "token-stSHIT.png", "-blue": "token-wstSHIT.png"}[suffix]
        icon.save(ICONS_DIR / icon_name)
        print(f"wrote {pub.name} + icons/{icon_name} ({icon_size}px)")


if __name__ == "__main__":
    main()
