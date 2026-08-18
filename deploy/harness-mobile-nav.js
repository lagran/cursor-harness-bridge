/*
 * Mobile navigation companion for harness-mobile.css.
 *
 * Harness keeps its desktop three-column grid on phones, so the sidebar
 * stays open after picking a session and squeezes the transcript into a
 * narrow strip. The stylesheet turns the open sidebar into a fixed overlay
 * panel; this script supplies the matching mobile behaviors:
 *
 *   - picking a session (or starting a new one) closes the panel;
 *   - tapping anywhere outside the panel closes it;
 *   - Escape closes it too, for keyboards and desktop emulation.
 *   - the deployment's internal-testing notice is completed automatically.
 *   - iOS Home Screen ZIP exports open in Safari instead of trapping the PWA.
 *
 * Closing always goes through the app's own "Collapse sidebar" button so
 * React state stays authoritative; no internal state is duplicated here.
 */
(() => {
  const FRAME_SEL = '[class*="pI_x6G_frame"]'
  const SIDEBAR_COL_SEL = '[class*="pI_x6G_sidebarCol"]'
  const SESSION_ROW_SEL = '[class*="YDXeBa_sessionRow"]'
  const NEW_SESSION_SEL = '[class*="hHd-Xa_newSession"]'
  const WELCOME_DIALOG_SEL = [
    '[role="dialog"][aria-label="内测声明"][aria-modal="true"]',
    '[role="dialog"][aria-label="Internal Testing Notice"][aria-modal="true"]',
  ].join(',')
  const WELCOME_CONTINUE_LABELS = new Set(['继续', 'Continue'])
  const COLLAPSE_LABELS = new Set(['Collapse sidebar', '收起侧边栏'])
  const TOGGLE_SEL = 'button[class*="hHd-Xa_toggle"]'
  const mobileQuery = window.matchMedia(
    '(max-width: 640px), (max-height: 500px) and (pointer: coarse)',
  )
  const DOWNLOAD_PATCH_MARKER = 'data-harness-session-download-patched'
  const DOWNLOAD_SHEET_SEL = '[data-harness-session-download-sheet]'
  const SESSION_EXPORT_PATH = '/api/session.export'
  let welcomeObserver
  let welcomeObserverTimer

  function frame() {
    return document.querySelector(FRAME_SEL)
  }

  function sidebarOpen() {
    const el = frame()
    return Boolean(el && !el.hasAttribute('data-sidebar-collapsed'))
  }

  function collapseButton() {
    const labeled = [...document.querySelectorAll('button[aria-label]')].find(button =>
      COLLAPSE_LABELS.has(button.getAttribute('aria-label') ?? ''),
    )
    if (labeled instanceof HTMLButtonElement) return labeled
    const toggle = document.querySelector(TOGGLE_SEL)
    return toggle instanceof HTMLButtonElement ? toggle : null
  }

  function closeSidebar() {
    if (!sidebarOpen()) return
    collapseButton()?.click()
  }

  // Let the app's own click handler run first, then close the panel. The
  // delay keeps the row mounted until the selection has been processed.
  function closeSoon() {
    window.setTimeout(closeSidebar, 120)
  }

  function clickCameFromSidebar(event) {
    return event
      .composedPath()
      .some(node => node instanceof Element && node.matches(SIDEBAR_COL_SEL))
  }

  // Remote Harness clients deliberately keep this acknowledgement in memory,
  // so complete the step on every page load instead of mutating Host settings.
  function dismissWelcomeNotice() {
    const dialog = document.querySelector(WELCOME_DIALOG_SEL)
    if (!(dialog instanceof HTMLElement)) return
    const button = [...dialog.querySelectorAll('button')].find(candidate =>
      WELCOME_CONTINUE_LABELS.has(candidate.textContent?.trim() ?? ''),
    )
    if (!(button instanceof HTMLButtonElement) || button.disabled) return

    welcomeObserver?.disconnect()
    window.clearTimeout(welcomeObserverTimer)
    button.click()

    // If acknowledgement fails, the CSS-hidden modal must not leave the app
    // inert and unusable.
    window.setTimeout(() => {
      if (!dialog.isConnected) return
      const appRoot = document.getElementById('root')
      if (appRoot instanceof HTMLElement) appRoot.inert = false
    }, 500)
  }

  welcomeObserver = new MutationObserver(dismissWelcomeNotice)
  welcomeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  welcomeObserverTimer = window.setTimeout(
    () => welcomeObserver?.disconnect(),
    15_000,
  )
  dismissWelcomeNotice()

  function isMobileShell() {
    return mobileQuery.matches
  }

  function isStandaloneIOS() {
    const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    return ios && (
      navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches
    )
  }

  function isSessionExportDownload(anchor) {
    if (!anchor.hasAttribute('download')) return false
    try {
      const url = new URL(anchor.href, window.location.href)
      return url.origin === window.location.origin && url.pathname === SESSION_EXPORT_PATH
    } catch {
      return false
    }
  }

  function downloadCopy() {
    const chinese = document.documentElement.lang.toLowerCase().startsWith('zh')
      || navigator.languages?.some(language => language.toLowerCase().startsWith('zh'))
    return chinese
      ? {
          title: '下载 Session 日志',
          description: 'iPhone 主屏幕应用无法从 ZIP 预览返回。请在 Safari 中下载或保存到“文件”；Harness 会留在当前页面。',
          open: '在 Safari 中下载',
          cancel: '取消',
        }
      : {
          title: 'Download Session log',
          description: 'The iPhone Home Screen app cannot return from ZIP Preview. Download or save the archive in Safari; Harness will remain on this page.',
          open: 'Download in Safari',
          cancel: 'Cancel',
        }
  }

  function installDownloadSheetStyles() {
    if (document.querySelector('style[data-harness-session-download]')) return
    const style = document.createElement('style')
    style.dataset.harnessSessionDownload = 'true'
    style.textContent = `
      ${DOWNLOAD_SHEET_SEL} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        align-items: end;
        padding: 16px;
        padding-bottom: max(16px, env(safe-area-inset-bottom));
        background: rgb(0 0 0 / 52%);
      }
      ${DOWNLOAD_SHEET_SEL} [data-harness-download-dialog] {
        width: min(100%, 440px);
        margin: 0 auto;
        padding: 20px;
        border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));
        border-radius: 18px;
        background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-label-primary, #111);
        box-shadow: 0 18px 48px rgb(0 0 0 / 28%);
      }
      ${DOWNLOAD_SHEET_SEL} h2 {
        margin: 0;
        font-size: 18px;
        line-height: 1.4;
      }
      ${DOWNLOAD_SHEET_SEL} p {
        margin: 10px 0 18px;
        color: var(--dsw-alias-label-secondary, #555);
        font-size: 15px;
        line-height: 1.55;
      }
      ${DOWNLOAD_SHEET_SEL} [data-harness-download-actions] {
        display: grid;
        gap: 10px;
      }
      ${DOWNLOAD_SHEET_SEL} button {
        min-height: 48px;
        border: 0;
        border-radius: 12px;
        font: inherit;
        font-weight: 600;
        touch-action: manipulation;
      }
      ${DOWNLOAD_SHEET_SEL} [data-harness-download-open] {
        background: var(--dsw-alias-interactive-bg-primary, #1677ff);
        color: var(--dsw-alias-interactive-label-primary, #fff);
      }
      ${DOWNLOAD_SHEET_SEL} [data-harness-download-cancel] {
        background: var(--dsw-alias-bg-module-platform, #f1f1f1);
        color: inherit;
      }
      @media (min-width: 641px) {
        ${DOWNLOAD_SHEET_SEL} {
          align-items: center;
        }
      }
    `
    document.head.append(style)
  }

  function showStandaloneDownloadSheet(url, nativeAnchorClick) {
    document.querySelector(DOWNLOAD_SHEET_SEL)?.remove()
    installDownloadSheetStyles()
    const copy = downloadCopy()
    const overlay = document.createElement('div')
    overlay.dataset.harnessSessionDownloadSheet = 'true'
    overlay.setAttribute('role', 'presentation')

    const dialog = document.createElement('section')
    dialog.dataset.harnessDownloadDialog = 'true'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'harness-download-title')
    dialog.setAttribute('aria-describedby', 'harness-download-description')

    const title = document.createElement('h2')
    title.id = 'harness-download-title'
    title.textContent = copy.title
    const description = document.createElement('p')
    description.id = 'harness-download-description'
    description.textContent = copy.description
    const actions = document.createElement('div')
    actions.dataset.harnessDownloadActions = 'true'
    const open = document.createElement('button')
    open.type = 'button'
    open.dataset.harnessDownloadOpen = 'true'
    open.textContent = copy.open
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.dataset.harnessDownloadCancel = 'true'
    cancel.textContent = copy.cancel

    const close = () => overlay.remove()
    open.addEventListener('click', () => {
      const external = document.createElement('a')
      external.href = url
      external.target = '_blank'
      external.rel = 'noopener noreferrer'
      external.style.display = 'none'
      document.body.append(external)
      nativeAnchorClick.call(external)
      external.remove()
      close()
    })
    cancel.addEventListener('click', close)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close()
    })
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') close()
    })

    actions.append(open, cancel)
    dialog.append(title, description, actions)
    overlay.append(dialog)
    document.body.append(overlay)
    try {
      open.focus({ preventScroll: true })
    } catch {
      open.focus()
    }
  }

  function patchStandaloneSessionDownloads() {
    const prototype = HTMLAnchorElement.prototype
    if (Object.prototype.hasOwnProperty.call(prototype, DOWNLOAD_PATCH_MARKER)) return
    const nativeAnchorClick = prototype.click
    Object.defineProperty(prototype, DOWNLOAD_PATCH_MARKER, {
      value: true,
      configurable: false,
      enumerable: false,
    })
    Object.defineProperty(prototype, 'click', {
      configurable: true,
      writable: true,
      value() {
        if (
          this instanceof HTMLAnchorElement
          && isStandaloneIOS()
          && isSessionExportDownload(this)
        ) {
          showStandaloneDownloadSheet(this.href, nativeAnchorClick)
          return
        }
        nativeAnchorClick.call(this)
      },
    })
  }

  patchStandaloneSessionDownloads()

  function closeIfOutside(event) {
    if (!isMobileShell() || !sidebarOpen()) return false
    if (!(event.target instanceof Element)) return false
    if (clickCameFromSidebar(event)) return false
    closeSidebar()
    return true
  }

  // pointerdown is the reliable close signal on iOS; click still covers
  // desktop emulation and session-row auto-close below.
  document.addEventListener(
    'pointerdown',
    event => {
      if (closeIfOutside(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )

  document.addEventListener(
    'click',
    event => {
      if (closeIfOutside(event)) return
      if (!isMobileShell() || !sidebarOpen()) return
      const target = event.target
      if (!(target instanceof Element)) return

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
