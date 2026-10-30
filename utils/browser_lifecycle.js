const config = require('../config')
const { withTimeout, sleep } = require('./async')
const { createError } = require('./errors')
const { AsyncLocalStorage } = require('node:async_hooks')
const launchOwners = new AsyncLocalStorage()
const ownedBrowsers = new WeakSet()
let driverReady

function prepareDriver() {
  return driverReady ??= import('puppeteer-core').then(({ default: driver }) => {
    const launch = driver.launch.bind(driver)
    // CloakBrowser performs fallible initialization after Puppeteer returns.
    driver.launch = async (options) => {
      const owner = launchOwners.getStore()
      if (!owner) return launch(options)
      owner.signal.throwIfAborted()
      const browser = await launch({ ...options, signal: owner.signal })
      owner.browser = browser
      ownedBrowsers.add(browser)
      return browser
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

async function createBrowser({ proxy, platform = config.browserPlatform, timeoutMs, signal, logger, onLaunchSettled }) {
  const deadline = Date.now() + (Number(timeoutMs) || 60000)
  const remainingTime = () => Math.max(1, deadline - Date.now())
  const { launch } = await withTimeout(
    import('cloakbrowser/puppeteer'),
    remainingTime(),
    'browser module load',
    { phase: 'browser_module_load', signal }
  )
  signal?.throwIfAborted()
  await withTimeout(prepareDriver(), remainingTime(), 'browser driver load', { signal })
  signal?.throwIfAborted()
  const launchTimeoutMs = remainingTime()
  const launchControl = new AbortController()
  const owner = { signal: launchControl.signal, browser: null }
  let abandoned = false
  let launchFailed = false
  const launching = launchOwners.run(owner, () => launch({
    headless: config.cloakbrowser.headless,
    humanize: config.cloakbrowser.humanize,
    stealthArgs: config.cloakbrowser.stealthArgs,
    timezone: config.cloakbrowser.timezone,
    locale: config.cloakbrowser.locale,
    proxy: buildCloakbrowserProxy(proxy),
    args: [`--fingerprint-platform=${platform}`],
    launchOptions: {
      defaultViewport: null,
      timeout: launchTimeoutMs,
    },
  })).then(async (browser) => {
    if (abandoned || signal?.aborted) {
      const closed = await closeBrowser(browser, { logger })
      onLaunchSettled?.(closed)
      throw signal?.reason || createError('Browser launch completed after timeout', 504)
    }
    return browser
  }, async (error) => {
    const closed = await closeBrowser(owner.browser, { logger })
    error.browserCleanupFailed = !closed
    launchFailed = true
    if (abandoned) onLaunchSettled?.(closed)
    throw error
  })
  let browser
  try {
    browser = await withTimeout(launching,
      launchTimeoutMs,
      'browser connect', { signal })
  } catch (error) {
    abandoned = true
    launchControl.abort(error)
    error.browserLaunchPending = !launchFailed
    throw error
  }
  let page
  try {
    page = await withTimeout(browser.newPage(), remainingTime(), 'browser new page', {
      phase: 'browser_new_page',
      signal,
    })
  } catch (error) {
    error.browserCleanupFailed = !await closeBrowser(browser, { logger })
    throw error
  }
  page.__proxyAuthenticationHandled = Boolean(proxy?.username && proxy?.password)

  return { browser, page, provider: 'cloakbrowser' }
}

async function closeBrowser(browser, options = {}) {
  if (!browser) return true

  const { timeoutMs, logger, logMeta } = options
  const closeTimeoutMs = Number(timeoutMs) || 5000
  let disconnected = false
  const child = browser.process?.()
  // Puppeteer's pinned launcher creates a dedicated POSIX process group.
  const group = ownedBrowsers.has(browser) && process.platform !== 'win32' && child?.pid
  const groupExists = () => {
    try { process.kill(-group, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }

  let exitCheck
  try {
    const closing = browser.close()
    // The driver's protocol close promise may remain pending after process exit.
    const exited = child && new Promise((resolve, reject) => {
      const check = () => {
        try {
          if ((child.exitCode !== null || child.signalCode !== null) && (!group || !groupExists())) resolve('exited')
        } catch (error) { reject(error) }
      }
      exitCheck = setInterval(check, 25)
      check()
    })
    const completed = await withTimeout(exited ? Promise.race([closing, exited]) : closing, closeTimeoutMs, 'browser close', {
      phase: 'browser_close',
    })
    if (group && groupExists()) throw new Error('Browser process group remains after close')
    if (completed === 'exited') browser.disconnect?.()
    return true
  } catch (error) {
    // Only terminate the process owned by this Browser, never a name/PID search.
    let processExited = child && (child.exitCode !== null || child.signalCode !== null)
    if (group) {
      try {
        if (groupExists()) process.kill(-group, 'SIGKILL')
        const deadline = Date.now() + closeTimeoutMs
        while (groupExists() && Date.now() < deadline) await sleep(25)
        processExited = !groupExists()
      } catch { processExited = false }
    }
    if (!group && child && !processExited) {
      let onExit
      const exited = new Promise((resolve) => {
        onExit = () => resolve(true)
        child.once('exit', onExit)
      })
      try {
        child.kill('SIGKILL')
        processExited = await withTimeout(exited, closeTimeoutMs, 'browser process exit')
      } catch {
        processExited = false
      } finally {
        child.removeListener('exit', onExit)
      }
    }
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
      process_exited: Boolean(processExited),
      ...(error?.detail?.phase ? { failure_phase: error.detail.phase } : {}),
      ...(disconnected ? { fallback_disconnect: true } : {}),
    })
    return Boolean(processExited)
  } finally {
    clearInterval(exitCheck)
  }
}

module.exports = { createBrowser, closeBrowser }
