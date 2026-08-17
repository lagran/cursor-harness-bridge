#!/usr/bin/env python3.11
"""Generate the Harness home-screen icons from the app's favicon whale glyph.

Renders PNG assets with headless Chromium into deploy/harness-icons/:

- apple-touch-icon.png  180x180, opaque full-bleed square (iOS rounds it and
  composites transparency onto black, so this variant must stay opaque);
- icon-192.png          manifest "any" icon, rounded corners, transparent;
- icon-512.png          manifest "any" icon, rounded corners, transparent;
- icon-maskable-512.png Android adaptive icon, full-bleed with the glyph
  inside the 80% safe zone.

Re-run after changing the artwork, then bump the asset version query in the
nginx sub_filter so clients pick up the new files.
"""
import os
import re
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = BRIDGE_ROOT / "deploy" / "harness-icons"
FAVICON_URL = os.environ.get(
    "HARNESS_FAVICON_URL",
    "http://127.0.0.1:3080/favicon.svg",
)

# DeepSeek brand blue, slightly brightened for small-size legibility.
GRADIENT_FROM = "#6C8CFF"
GRADIENT_TO = "#4664F0"


def whale_path_d() -> str:
    svg = urllib.request.urlopen(FAVICON_URL, timeout=10).read().decode()
    match = re.search(r'<path[^>]*\sd="([^"]+)"', svg)
    if not match:
        raise SystemExit("could not extract whale path from favicon.svg")
    return match.group(1)


def icon_svg(size: int, *, rounded: bool, glyph_ratio: float) -> str:
    glyph = size * glyph_ratio
    # The whale artwork is designed on a 50x50 grid.
    scale = glyph / 50
    offset = (size - glyph) / 2
    radius = size * 0.22 if rounded else 0
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{GRADIENT_FROM}"/>
      <stop offset="1" stop-color="{GRADIENT_TO}"/>
    </linearGradient>
  </defs>
  <rect width="{size}" height="{size}" rx="{radius}" fill="url(#bg)"/>
  <g transform="translate({offset:.3f} {offset:.3f}) scale({scale:.5f})">
    <path d="{WHALE_D}" fill="#ffffff"/>
  </g>
</svg>"""


def render(page, svg: str, size: int, out: Path, *, transparent: bool) -> None:
    page.set_viewport_size({"width": size, "height": size})
    page.set_content(
        f'<html><body style="margin:0">{svg}</body></html>',
        wait_until="load",
    )
    page.screenshot(
        path=str(out),
        omit_background=transparent,
        clip={"x": 0, "y": 0, "width": size, "height": size},
    )
    print(f"wrote {out.name} ({size}x{size}, transparent={transparent})")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "harness-icon.svg").write_text(
        icon_svg(512, rounded=True, glyph_ratio=0.58), encoding="utf-8"
    )

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(device_scale_factor=1)
        render(page, icon_svg(180, rounded=False, glyph_ratio=0.58),
               180, OUT_DIR / "apple-touch-icon.png", transparent=False)
        render(page, icon_svg(192, rounded=True, glyph_ratio=0.58),
               192, OUT_DIR / "icon-192.png", transparent=True)
        render(page, icon_svg(512, rounded=True, glyph_ratio=0.58),
               512, OUT_DIR / "icon-512.png", transparent=True)
        # Maskable: Android crops to a circle/squircle; keep the glyph
        # inside the central 80% safe zone with a full-bleed background.
        render(page, icon_svg(512, rounded=False, glyph_ratio=0.44),
               512, OUT_DIR / "icon-maskable-512.png", transparent=False)
        browser.close()


if __name__ == "__main__":
    WHALE_D = whale_path_d()
    main()
