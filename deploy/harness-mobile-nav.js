/*
 * Mobile navigation companion for harness-mobile.css.
 *
 * Harness keeps its desktop three-column grid on phones, so the sidebar
 * stays open after picking a session and squeezes the transcript into a
 * narrow strip. The stylesheet turns the open sidebar into a fixed overlay
 * panel; this script supplies the matching mobile behaviors:
 *
 *   - picking a session (or starting a new one) closes the panel;
 *   - tapping the dimmed scrim closes the panel;
 *   - Escape closes it too, for keyboards and desktop emulation.
 *
 * Closing always goes through the app's own "Collapse sidebar" button so
 * React state stays authoritative; no internal state is duplicated here.
 */
(() => {
  const FRAME_SEL = '[class*="pI_x6G_frame"]'
  const SESSION_ROW_SEL = '[class*="YDXeBa_sessionRow"]'
  const NEW_SESSION_SEL = '[class*="hHd-Xa_newSession"]'
  const mobileQuery = window.matchMedia(
    '(max-width: 640px), (max-height: 500px) and (pointer: coarse)',
  )

  function frame() {
    return document.querySelector(FRAME_SEL)
  }

  function sidebarOpen() {
    const el = frame()
    return Boolean(el && !el.hasAttribute('data-sidebar-collapsed'))
  }

  function closeSidebar() {
    if (!sidebarOpen()) return
    const button = document.querySelector('button[aria-label="Collapse sidebar"]')
    if (button) button.click()
  }

  // Let the app's own click handler run first, then close the panel. The
  // delay keeps the row mounted until the selection has been processed.
  function closeSoon() {
    window.setTimeout(closeSidebar, 120)
  }

  document.addEventListener(
    'click',
    event => {
      if (!mobileQuery.matches || !sidebarOpen()) return
      const target = event.target
      if (!(target instanceof Element)) return

      // Scrim taps hit the frame element directly (the scrim is its
      // ::after pseudo-element, which covers the center column).
      if (target === frame()) {
        closeSidebar()
        return
      }

      // Buttons inside a row (session actions, workspace actions) open
      // menus; they must not close the panel.
      if (target.closest('button')) {
        if (target.closest(NEW_SESSION_SEL)) closeSoon()
        return
      }
      if (target.closest(SESSION_ROW_SEL)) closeSoon()
    },
    true,
  )

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobileQuery.matches && sidebarOpen()) {
      closeSidebar()
    }
  })
})()
