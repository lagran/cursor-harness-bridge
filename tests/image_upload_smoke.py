import binascii
import os
from pathlib import Path
import struct
import tempfile
import zlib

from playwright.sync_api import TimeoutError, sync_playwright


ORIGIN = os.environ.get("HARNESS_ORIGIN", "http://127.0.0.1:3080")
CERT_PATH = os.environ.get("HARNESS_CLIENT_CERT")
KEY_PATH = os.environ.get("HARNESS_CLIENT_KEY")
BRIDGE_ROOT = Path(__file__).resolve().parents[1]


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
    )


def red_png(width: int = 16, height: int = 16) -> bytes:
    rows = b"".join(
        b"\x00" + bytes([255, 0, 0, 255]) * width
        for _ in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(
            b"IHDR",
            struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0),
        )
        + png_chunk(b"IDAT", zlib.compress(rows))
        + png_chunk(b"IEND", b"")
    )


def main() -> None:
    with tempfile.NamedTemporaryFile(suffix=".png") as image:
        image.write(red_png())
        image.flush()

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context_options = {
                "viewport": {"width": 430, "height": 932},
                "device_scale_factor": 3,
                "is_mobile": True,
                "has_touch": True,
            }
            if CERT_PATH and KEY_PATH:
                context_options["client_certificates"] = [
                    {
                        "origin": ORIGIN,
                        "certPath": CERT_PATH,
                        "keyPath": KEY_PATH,
                    }
                ]
            context = browser.new_context(**context_options)
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            response = page.goto(ORIGIN, wait_until="domcontentloaded")
            assert response is not None and response.status == 200
            page.wait_for_timeout(2_500)
            if page.locator('link[href*="harness-mobile.css"]').count() == 0:
                page.add_style_tag(path=BRIDGE_ROOT / "deploy/harness-mobile.css")
            if page.locator(
                'script[src*="harness-image-upload.js"]'
            ).count() == 0:
                page.add_script_tag(
                    path=BRIDGE_ROOT / "deploy/harness-image-upload.js"
                )
                page.wait_for_timeout(200)

            continue_button = page.get_by_text("Continue", exact=True)
            try:
                continue_button.wait_for(state="visible", timeout=5_000)
                continue_button.click()
                page.get_by_role("dialog").wait_for(
                    state="hidden",
                    timeout=10_000,
                )
                page.wait_for_timeout(800)
            except TimeoutError:
                pass

            add_images = page.get_by_role("button", name="Add images")
            file_input = page.locator(
                'input[data-harness-image-upload="input"]'
            )
            assert add_images.is_visible()
            assert add_images.bounding_box()["height"] >= 44
            assert file_input.get_attribute("accept") == (
                "image/png,image/jpeg,image/webp,image/gif"
            )

            file_input.set_input_files(image.name)
            preview = page.locator('[data-composer-card="true"] img')
            preview.wait_for()
            assert preview.get_attribute("alt").endswith(".png")
            assert errors == [], errors

            browser.close()
    print("IMAGE_UPLOAD_SMOKE_OK")


if __name__ == "__main__":
    main()
