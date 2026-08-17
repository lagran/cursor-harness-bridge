(() => {
  const marker = 'data-harness-image-upload'

  function clipboardData(files) {
    if (typeof DataTransfer === 'function') {
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(file)
      return transfer
    }
    return {
      files,
      items: files.map(file => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      })),
      types: ['Files'],
      getData: () => '',
      setData: () => false,
      clearData: () => {},
    }
  }

  function deliver(textarea, files) {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      configurable: false,
      enumerable: true,
      value: clipboardData(files),
    })
    textarea.focus()
    textarea.dispatchEvent(event)
  }

  function imageIcon() {
    const namespace = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(namespace, 'svg')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('viewBox', '0 0 18 18')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('aria-hidden', 'true')
    const frame = document.createElementNS(namespace, 'path')
    frame.setAttribute(
      'd',
      'M3.25 2.75h11.5c.83 0 1.5.67 1.5 1.5v9.5c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-9.5c0-.83.67-1.5 1.5-1.5Z',
    )
    frame.setAttribute('stroke', 'currentColor')
    frame.setAttribute('stroke-width', '1.4')
    const image = document.createElementNS(namespace, 'path')
    image.setAttribute(
      'd',
      'm2.5 13 3.25-3.25 2.4 2.4 2.85-3.4 4.5 4.75M12.9 6.4a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z',
    )
    image.setAttribute('stroke', 'currentColor')
    image.setAttribute('stroke-width', '1.4')
    image.setAttribute('stroke-linecap', 'round')
    image.setAttribute('stroke-linejoin', 'round')
    svg.append(frame, image)
    return svg
  }

  function mount(card) {
    if (card.querySelector(`[${marker}]`)) return
    const textarea = card.querySelector('textarea')
    const commandButton = card.querySelector('button[aria-label="Commands"]')
    const tools = commandButton?.parentElement
    if (!textarea || !tools) return

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.multiple = true
    input.hidden = true
    input.setAttribute(marker, 'input')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'harness-image-upload-button'
    button.setAttribute(marker, 'button')
    button.setAttribute('aria-label', 'Add images')
    button.title = 'Add images'
    button.append(imageIcon())

    button.addEventListener('click', () => {
      if (!button.disabled) input.click()
    })
    input.addEventListener('change', () => {
      const files = Array.from(input.files || [])
      if (files.length > 0) deliver(textarea, files)
      input.value = ''
    })

    const syncDisabled = () => {
      button.disabled = textarea.disabled || textarea.readOnly
    }
    new MutationObserver(syncDisabled).observe(textarea, {
      attributes: true,
      attributeFilter: ['disabled', 'readonly'],
    })
    syncDisabled()
    tools.insertBefore(input, commandButton.nextSibling)
    tools.insertBefore(button, input.nextSibling)
  }

  function scan() {
    document.querySelectorAll('[data-composer-card="true"]').forEach(mount)
  }

  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  scan()
})()
