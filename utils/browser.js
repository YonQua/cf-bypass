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

module.exports = {
  applyProxyAuthentication,
  applyRequestInterception,
  createBrowser,
}
