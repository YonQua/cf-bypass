const { connect } = require('puppeteer-real-browser')
const { withTimeout } = require('./async')

async function applyProxyAuthentication(page, proxy) {
  if (!proxy?.username || !proxy?.password) return
  await page.authenticate({
    username: proxy.username,
    password: proxy.password,
  })
}

async function applyRequestInterception(page, handler, options = {}) {
  const { logger, logMeta } = options
  await page.setRequestInterception(true)
  page.removeAllListeners('request')
  page.on('request', async (request) => {
    try {
      await handler(request)
    } catch (error) {
      if (logger?.warn) {
        logger.warn('event=request_interception_handler_failed', {
          ...logMeta,
          url: request.url(),
          resource_type: request.resourceType(),
          error: error.message,
        })
      }
      try {
        await request.continue()
      } catch {}
    }
  })
}

async function createBrowser({ proxyServer, timeoutMs }) {
  const requestTimeoutMs = Number(timeoutMs) || 60000
  const connectOptions = {
    headless: false,
    turnstile: true,
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  }

  if (proxyServer) {
    connectOptions.args = [`--proxy-server=${proxyServer}`]
  }

  const { browser, page } = await withTimeout(
    connect(connectOptions),
    requestTimeoutMs,
    'browser connect'
  )

  return { browser, page }
}

async function closeBrowser(browser, options = {}) {
  if (!browser) return

  const { timeoutMs, logger, logMeta } = options
  const closeTimeoutMs = Number(timeoutMs) || 5000
  let disconnected = false

  try {
    await withTimeout(browser.close(), closeTimeoutMs, 'browser close', {
      phase: 'browser_close',
    })
  } catch (error) {
    if (typeof browser.disconnect === 'function') {
      try {
        browser.disconnect()
        disconnected = true
      } catch {}
    }

    logger?.warn?.('event=browser_close_failed', {
      ...logMeta,
      timeout_ms: closeTimeoutMs,
      error: error.message,
      ...(error?.detail?.phase ? { failure_phase: error.detail.phase } : {}),
      ...(disconnected ? { fallback_disconnect: true } : {}),
    })
  }
}

module.exports = {
  applyProxyAuthentication,
  applyRequestInterception,
  closeBrowser,
  createBrowser,
}
