"""Mobile sidebar overlay smoke test.

Verifies the deployment-owned mobile navigation behavior:
  - on phones the open sidebar becomes a fixed overlay panel instead of
    squeezing the transcript column;
  - the sidebar content fills the sheet without an uncovered edge band;
  - picking a session auto-closes the panel;
  - tapping the work area or scrim closes it;
  - the internal-testing notice is hidden and completed automatically;
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
            return {
              x: Math.round(r.x),
              right: Math.round(r.right),
              width: Math.round(r.width),
              background: getComputedStyle(el).backgroundColor,
            }
          }
          const frame = document.querySelector('[class*="pI_x6G_frame"]')
          return {
            sidebar: g('[class*="sidebarCol"]'),
            sidebarRoot: g('[class*="sidebarCol"] [class*="hHd-Xa_root"]'),
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
    assert opened["center"]["width"] >= center_width, opened
    assert opened["sidebar"]["width"] >= 300, opened
    assert opened["sidebarRoot"]["width"] >= 280, opened
    assert opened["sidebar"]["background"] == opened["sidebarRoot"]["background"], opened
    assert opened["scrollW"] == 430, opened

    # Picking a session auto-closes the panel.
    page.locator('[class*="YDXeBa_sessionRow"]').first.click()
    page.wait_for_timeout(1_500)
    picked = geometry(page)
    assert picked["collapsed"] is True, picked
    assert picked["center"]["width"] == center_width, picked

    # A click whose target is a work-area descendant also closes the panel.
    open_sidebar(page)
    page.locator('[class*="centerCol"]').dispatch_event("click")
    page.wait_for_timeout(900)
    assert geometry(page)["collapsed"] is True

    # A real pointer tap on the scrim closes the reopened panel too.
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


def collapse_button_locale_regression(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 430, "height": 932}))
    page = context.new_page()
    page.set_content(
        """<!DOCTYPE html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body>
            <div class="pI_x6G_frame">
              <div class="pI_x6G_sidebarCol">
                <button class="hHd-Xa_toggle" aria-label="收起侧边栏">toggle</button>
              </div>
              <div class="pI_x6G_centerCol">workspace</div>
            </div>
          </body>
        </html>"""
    )
    page.add_script_tag(path=BRIDGE_ROOT / "deploy/harness-mobile-nav.js")
    clicked = page.evaluate(
        """() => new Promise(resolve => {
          const button = document.querySelector('button[aria-label="收起侧边栏"]')
          button.addEventListener('click', () => resolve(true))
          document.querySelector('.pI_x6G_centerCol').click()
          setTimeout(() => resolve(false), 500)
        })"""
    )
    assert clicked is True
    context.close()


def welcome_notice_regression(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 430, "height": 932}))
    page = context.new_page()
    page.set_content(
        """<!DOCTYPE html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body>
            <main id="root">Harness</main>
          </body>
        </html>"""
    )
    page.add_style_tag(path=BRIDGE_ROOT / "deploy/harness-mobile.css")
    page.add_script_tag(path=BRIDGE_ROOT / "deploy/harness-mobile-nav.js")

    result = page.evaluate(
        """() => new Promise(resolve => {
          const appRoot = document.getElementById('root')
          appRoot.inert = true

          const overlay = document.createElement('div')
          overlay.setAttribute('role', 'presentation')
          const dialog = document.createElement('div')
          dialog.setAttribute('role', 'dialog')
          dialog.setAttribute('aria-modal', 'true')
          dialog.setAttribute('aria-label', '内测声明')
          const button = document.createElement('button')
          button.textContent = '继续'
          button.addEventListener('click', () => {
            const display = getComputedStyle(overlay).display
            overlay.remove()
            appRoot.inert = false
            resolve({clicked: true, display, inert: appRoot.inert})
          })
          dialog.append(button)
          overlay.append(dialog)
          document.body.append(overlay)

          setTimeout(() => resolve({
            clicked: false,
            display: getComputedStyle(overlay).display,
            inert: appRoot.inert,
          }), 1_000)
        })"""
    )
    assert result == {"clicked": True, "display": "none", "inert": False}, result
    context.close()


def standalone_session_download_regression(browser: Browser) -> None:
    context = browser.new_context(**context_options({"width": 430, "height": 932}))
    page = context.new_page()

    def serve(route) -> None:
        if "/api/session.export" in route.request.url:
            route.fulfill(
                status=200,
                body=b"PK\x05\x06" + b"\x00" * 18,
                headers={
                    "Content-Type": "application/zip",
                    "Content-Disposition": 'attachment; filename="session.zip"',
                },
            )
            return
        route.fulfill(
            status=200,
            content_type="text/html",
            body=(
                "<!doctype html><html lang='zh-CN'><head>"
                "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                "</head><body><main>Harness</main></body></html>"
            ),
        )

    context.route("https://harness.test/**", serve)
    page.goto("https://harness.test/fixture")
    page.evaluate(
        """() => Object.defineProperty(navigator, 'standalone', {
          value: true,
          configurable: true,
        })"""
    )
    page.evaluate(
        """() => {
          window.__openedHarnessDownload = null
          HTMLAnchorElement.prototype.click = function () {
            window.__openedHarnessDownload = {
              href: this.href,
              target: this.target,
              rel: this.rel,
            }
          }
        }"""
    )
    page.add_script_tag(path=BRIDGE_ROOT / "deploy/harness-mobile-nav.js")

    page.evaluate(
        """() => {
          const anchor = document.createElement('a')
          anchor.href = '/api/session.export?sessionId=session-test'
          anchor.download = 'dsh-session-test.zip'
          anchor.click()
        }"""
    )
    dialog = page.get_by_role("dialog", name="下载 Session 日志")
    dialog.wait_for()
    assert "无法从 ZIP 预览返回" in dialog.inner_text()
    open_button = page.get_by_role("button", name="在 Safari 中下载")
    cancel_button = page.get_by_role("button", name="取消")
    assert open_button.bounding_box()["height"] >= 44
    assert cancel_button.bounding_box()["height"] >= 44
    original_url = page.url

    open_button.click()
    opened = page.evaluate("window.__openedHarnessDownload")
    assert "/api/session.export" in opened["href"]
    assert opened["target"] == "_blank"
    assert "noopener" in opened["rel"]
    assert page.url == original_url
    dialog.wait_for(state="hidden")
    context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        welcome_notice_regression(browser)
        collapse_button_locale_regression(browser)
        standalone_session_download_regression(browser)
        portrait(browser)
        desktop_regression(browser)
        browser.close()
    print("MOBILE_SIDEBAR_SMOKE_OK")


if __name__ == "__main__":
    main()
