"""Mobile sidebar overlay smoke test.

Verifies the deployment-owned mobile navigation behavior:
  - on phones the open sidebar becomes a fixed overlay panel instead of
    squeezing the transcript column;
  - picking a session auto-closes the panel;
  - tapping the scrim closes it;
  - desktop layout is untouched (sidebar stays a real grid column).

Run against loopback with the web UI up:
    CURSOR_WORKSPACE=/path/to/project npm run web
    python3.11 tests/mobile_sidebar_smoke.py
"""
import os
from pathlib import Path

from playwright.sync_api import Browser, Page, TimeoutError, sync_playwright

ORIGIN = os.environ.get("HARNESS_ORIGIN", "http://127.0.0.1:3080")
CERT_PATH = os.environ.get("HARNESS_CLIENT_CERT")
KEY_PATH = os.environ.get("HARNESS_CLIENT_KEY")
IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
    "Mobile/15E148 Safari/604.1"
)
BRIDGE_ROOT = Path(__file__).resolve().parents[1]


def context_options(viewport: dict[str, int], mobile: bool = True) -> dict:
    options: dict = {"viewport": viewport}
    if CERT_PATH and KEY_PATH:
        options["client_certificates"] = [
            {"origin": ORIGIN, "certPath": CERT_PATH, "keyPath": KEY_PATH}
        ]
    if mobile:
        options.update(
            {
                "device_scale_factor": 3,
                "is_mobile": True,
                "has_touch": True,
                "user_agent": IPHONE_UA,
            }
        )
    return options


def inject_assets(page: Page) -> None:
    if page.locator('link[href*="harness-mobile.css"]').count() == 0:
        page.add_style_tag(path=BRIDGE_ROOT / "deploy/harness-mobile.css")
    if page.locator('script[src*="harness-image-upload.js"]').count() == 0:
        page.add_script_tag(path=BRIDGE_ROOT / "deploy/harness-image-upload.js")
    if page.locator('script[src*="harness-mobile-nav.js"]').count() == 0:
        page.add_script_tag(path=BRIDGE_ROOT / "deploy/harness-mobile-nav.js")


def dismiss_onboarding(page: Page) -> None:
    continue_button = page.get_by_text("Continue", exact=True)
    try:
        continue_button.wait_for(state="visible", timeout=5_000)
        continue_button.click()
        page.get_by_role("dialog").wait_for(state="hidden", timeout=10_000)
        page.wait_for_timeout(800)
    except TimeoutError:
        pass


def geometry(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const g = sel => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return {x: Math.round(r.x), width: Math.round(r.width)}
          }
          const frame = document.querySelector('[class*="pI_x6G_frame"]')
          return {
            sidebar: g('[class*="sidebarCol"]'),
            center: g('[class*="centerCol"]'),
            collapsed: frame ? frame.hasAttribute('data-sidebar-collapsed') : null,
            scrollW: document.documentElement.scrollWidth,
          }
        }"""
    )


def open_sidebar(page: Page) -> None:
    if geometry(page)["collapsed"] is not True:
        page.wait_for_timeout(400)
        return
    page.get_by_role("button", name="Open sidebar").click(timeout=6_000)
    page.wait_for_timeout(1_000)


def portrait(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 430, "height": 932}))
    page = context.new_page()
    page.goto(ORIGIN, wait_until="domcontentloaded")
    page.wait_for_timeout(3_000)
    dismiss_onboarding(page)
    inject_assets(page)

    closed = geometry(page)
    assert closed["collapsed"] is True
    center_width = closed["center"]["width"]

    open_sidebar(page)
    opened = geometry(page)
    # Overlay: the center column must keep its full width while open.
    assert opened["collapsed"] is False
    assert opened["center"]["width"] == center_width, opened
    assert opened["sidebar"]["width"] >= 300, opened
    assert opened["scrollW"] == 430, opened

    # Picking a session auto-closes the panel.
    page.locator('[class*="YDXeBa_sessionRow"]').first.click()
    page.wait_for_timeout(1_500)
    picked = geometry(page)
    assert picked["collapsed"] is True, picked
    assert picked["center"]["width"] == center_width, picked

    # Scrim tap closes the reopened panel.
    open_sidebar(page)
    page.mouse.click(400, 500)
    page.wait_for_timeout(900)
    assert geometry(page)["collapsed"] is True
    context.close()


def desktop_regression(browser: Browser) -> None:
    context = browser.new_context(
        **context_options({"width": 1440, "height": 1000}, mobile=False)
    )
    page = context.new_page()
    page.goto(ORIGIN, wait_until="domcontentloaded")
    page.wait_for_timeout(3_000)
    dismiss_onboarding(page)
    inject_assets(page)

    open_sidebar(page)
    opened = geometry(page)
    assert opened["collapsed"] is False
    # Desktop keeps the real grid column: 280px sidebar + wide center.
    assert opened["sidebar"]["width"] == 280, opened
    assert opened["center"]["width"] > 900, opened

    # No auto-close on desktop: picking a session keeps the sidebar open.
    page.locator('[class*="YDXeBa_sessionRow"]').first.click()
    page.wait_for_timeout(1_500)
    assert geometry(page)["collapsed"] is False
    context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        portrait(browser)
        desktop_regression(browser)
        browser.close()
    print("MOBILE_SIDEBAR_SMOKE_OK")


if __name__ == "__main__":
    main()
