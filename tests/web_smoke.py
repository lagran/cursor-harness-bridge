import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        response = page.goto("http://127.0.0.1:3080", wait_until="networkidle")
        assert response is not None and response.ok, "Harness page did not load"
        page.locator("body").wait_for(state="visible")

        continue_button = page.get_by_role("button", name="Continue")
        if continue_button.is_visible():
            continue_button.click()

        workspace = Path(
            os.environ.get(
                "CURSOR_WORKSPACE",
                str(Path(__file__).resolve().parents[2]),
            )
        ).resolve()
        choose_workspace = page.get_by_text("Choose workspace", exact=True)
        if choose_workspace.is_visible():
            choose_workspace.click()
            page.get_by_text(workspace.name, exact=True).click()
            page.get_by_role("button", name="Open").click()

        page.get_by_text("Cursor Auto", exact=True).wait_for(timeout=10_000)
        body = page.locator("body").inner_text()
        assert body.strip(), "Harness rendered an empty page"
        assert workspace.name in body, body[:1000]
        assert "Cursor Auto" in body, body[:1000]
        page.screenshot(path="/tmp/cursor-harness-smoke.png", full_page=True)

        fatal = [
            message
            for message in console_errors
            if "favicon" not in message.lower() and "failed to load resource" not in message.lower()
        ]
        assert not page_errors, f"page errors: {page_errors}"
        assert not fatal, f"console errors: {fatal}"
        print("WEB_SMOKE_OK")

        browser.close()


if __name__ == "__main__":
    main()
