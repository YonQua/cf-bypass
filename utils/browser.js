const config = require('../config')
const { withTimeout } = require('./async')
const { createIuamBrowser: launchIuamBrowser } = require('./iuamBrowser')

let cloakbrowserBinaryPathPromise

async function applyProxyAuthentication(page, proxy) {
  if (page?.__proxyAuthenticationHandled) return
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

function buildCloakbrowserProxy(proxy) {
  if (!proxy?.url) return undefined

  const parsed = new URL(proxy.url)
  if (parsed.protocol === 'socks5:') {
    if (!proxy.username && !proxy.password) return proxy.url

    parsed.username = proxy.username
    parsed.password = proxy.password
    return parsed.href.replace(/\/$/, '')
  }

  const result = { server: proxy.url }
  if (proxy.username) result.username = proxy.username
  if (proxy.password) result.password = proxy.password
  return result
}

function buildCloakbrowserArgs() {
  const args = []
  if (config.cloakbrowser.fingerprintSeed) {
    args.push(`--fingerprint=${config.cloakbrowser.fingerprintSeed}`)
  }
  return args
}

async function getCloakbrowserBinaryPath() {
  if (process.env.CLOAKBROWSER_BINARY_PATH) return process.env.CLOAKBROWSER_BINARY_PATH
  if (!cloakbrowserBinaryPathPromise) {
    cloakbrowserBinaryPathPromise = import('cloakbrowser').then(({ ensureBinary }) => ensureBinary())
  }
  return cloakbrowserBinaryPathPromise
}

async function createCloakBrowser({ proxy, timeoutMs }) {
  const requestTimeoutMs = Number(timeoutMs) || 60000
  const { launch } = await import('cloakbrowser/puppeteer')

  const browser = await withTimeout(
    launch({
      headless: config.cloakbrowser.headless,
      humanize: config.cloakbrowser.humanize,
      stealthArgs: config.cloakbrowser.stealthArgs,
      timezone: config.cloakbrowser.timezone,
      locale: config.cloakbrowser.locale,
      proxy: buildCloakbrowserProxy(proxy),
      args: buildCloakbrowserArgs(),
      launchOptions: {
        defaultViewport: null,
      },
    }),
    requestTimeoutMs,
    'browser connect'
  )
  const page = await withTimeout(browser.newPage(), requestTimeoutMs, 'browser new page', {
    phase: 'browser_new_page',
  })
  page.__proxyAuthenticationHandled = Boolean(proxy?.username && proxy?.password)

  return { browser, page, provider: 'cloakbrowser' }
}

async function createIuamBrowser({ proxy, timeoutMs }) {
  const requestTimeoutMs = Number(timeoutMs) || 60000
  const chromePath = await getCloakbrowserBinaryPath()

  return withTimeout(
    launchIuamBrowser({ proxy, chromePath }),
    requestTimeoutMs,
    'browser connect'
  )
}

async function createBrowser({ proxy, timeoutMs, mode }) {
  if (mode === 'iuam') {
    return createIuamBrowser({ proxy, timeoutMs })
  }

  return createCloakBrowser({ proxy, timeoutMs })
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
