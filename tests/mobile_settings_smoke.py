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
    options = {
        "viewport": viewport,
    }
    if CERT_PATH and KEY_PATH:
        options["client_certificates"] = [
            {
                "origin": ORIGIN,
                "certPath": CERT_PATH,
                "keyPath": KEY_PATH,
            }
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


def open_settings(page: Page) -> None:
    response = page.goto(ORIGIN, wait_until="domcontentloaded")
    assert response is not None and response.status == 200
    page.wait_for_timeout(2_500)
    if page.locator('link[href*="harness-mobile.css"]').count() == 0:
        page.add_style_tag(path=BRIDGE_ROOT / "deploy/harness-mobile.css")

    continue_button = page.get_by_text("Continue", exact=True)
    try:
        continue_button.wait_for(state="visible", timeout=5_000)
        continue_button.click()
        page.get_by_role("dialog").wait_for(state="hidden", timeout=10_000)
        page.wait_for_timeout(800)
    except TimeoutError:
        pass

    settings = page.get_by_text("Settings", exact=True)
    if not settings.is_visible():
        page.get_by_role("button", name="Open sidebar").click()
    page.get_by_text("Settings", exact=True).click()
    page.get_by_role("dialog").wait_for(state="visible")


def panel_overflow(page: Page) -> list[dict]:
    return page.evaluate(
        """() => [...document.querySelectorAll('.VOzbGW_panel *')]
          .map(element => {
            const rect = element.getBoundingClientRect()
            return {
              tag: element.tagName,
              className: typeof element.className === 'string'
                ? element.className
                : '',
              left: rect.left,
              right: rect.right,
            }
          })
          .filter(item => item.left < -1 || item.right > innerWidth + 1)"""
    )


def assert_touch_targets(page: Page) -> None:
    too_small = page.evaluate(
        """() => [...document.querySelectorAll('.VOzbGW_panel button')]
          .filter(element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect.width > 0
              && rect.height > 0
              && rect.height < 43.5
          })
          .map(element => ({
            label: (element.innerText || element.getAttribute('aria-label') || '').trim(),
            height: element.getBoundingClientRect().height,
          }))"""
    )
    assert too_small == [], too_small


def portrait(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 430, "height": 932}))
    page = context.new_page()
    open_settings(page)

    dialog = page.get_by_role("dialog")
    description = page.get_by_text(
        "Applies to sessions you start from now on. "
        "Running sessions keep the preset they began with.",
        exact=True,
    )
    assert dialog.bounding_box()["width"] == 430
    assert description.bounding_box()["width"] > 300
    assert page.evaluate("document.documentElement.scrollWidth") == 430
    assert panel_overflow(page) == []
    assert_touch_targets(page)

    page.get_by_text("Models", exact=True).click()
    page.get_by_text("Cursor Agent", exact=True).wait_for()
    assert panel_overflow(page) == []
    assert_touch_targets(page)
    context.close()


def landscape(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 932, "height": 430}))
    page = context.new_page()
    open_settings(page)

    dialog = page.get_by_role("dialog")
    nav = dialog.locator(":scope > nav")
    content = dialog.locator(":scope > div").first
    assert dialog.bounding_box()["width"] == 932
    assert dialog.bounding_box()["height"] == 430
    assert nav.bounding_box()["width"] == 932
    assert content.bounding_box()["width"] == 932
    assert panel_overflow(page) == []
    context.close()


def desktop_regression(browser: Browser) -> None:
    context = browser.new_context(
        **context_options({"width": 1440, "height": 1000}, mobile=False)
    )
    page = context.new_page()
    open_settings(page)

    dialog = page.get_by_role("dialog")
    nav = dialog.locator(":scope > nav")
    content = dialog.locator(":scope > div").first
    assert dialog.bounding_box()["width"] == 800
    assert nav.bounding_box()["width"] == 188
    assert content.bounding_box()["width"] == 612
    context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        portrait(browser)
        landscape(browser)
        desktop_regression(browser)
        browser.close()
    print("MOBILE_SETTINGS_SMOKE_OK")


if __name__ == "__main__":
    main()
