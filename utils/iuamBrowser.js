const puppeteer = require('rebrowser-puppeteer-core')
const { createCursor } = require('ghost-cursor')
const { launch, Launcher } = require('chrome-launcher')
const Xvfb = require('xvfb')
const { sleep } = require('./async')
const { clickIuamTurnstileOnce } = require('./turnstile/clicker')

function buildProxyArg(proxy) {
  if (!proxy?.url) return null
  return `--proxy-server=${proxy.url}`
}

function buildChromeFlags({ proxy, headless = false }) {
  const flags = Launcher.defaultFlags()
  const disableFeaturesIndex = flags.findIndex((flag) => flag.startsWith('--disable-features'))
  if (disableFeaturesIndex >= 0) {
    flags[disableFeaturesIndex] = `${flags[disableFeaturesIndex]},AutomationControlled`
  }

  const componentUpdateIndex = flags.findIndex((flag) => flag.startsWith('--disable-component-update'))
  if (componentUpdateIndex >= 0) {
    flags.splice(componentUpdateIndex, 1)
  }

  const proxyArg = buildProxyArg(proxy)
  return [
    ...flags,
    ...(proxyArg ? [proxyArg] : []),
    ...(headless !== false ? [`--headless=${headless}`] : []),
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ]
}

function createXvfbSession() {
  if (process.platform !== 'linux') return null

  const session = new Xvfb({
    silent: true,
    xvfb_args: ['-screen', '0', '1920x1080x24', '-ac'],
  })
  session.startSync()
  return session
}

async function attachIuamPageController({ page, proxy, turnstile, onPageClosed }) {
  let solveStatus = Boolean(turnstile)
  const handleClose = () => {
    solveStatus = false
    onPageClosed?.()
  }
  page.on('close', handleClose)

  async function turnstileSolver() {
    while (solveStatus) {
      try {
        const clicked = await clickIuamTurnstileOnce(page)
        if (clicked) page.__iuamBackgroundClickAttempted = true
      } catch {}
      await sleep(1000)
    }
  }

  if (solveStatus) {
    turnstileSolver().catch(() => {})
  }

  if (proxy?.username && proxy?.password) {
    await page.authenticate({ username: proxy.username, password: proxy.password })
    page.__proxyAuthenticationHandled = true
  }

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(MouseEvent.prototype, 'screenX', {
      get() {
        return this.clientX + window.screenX
      },
    })

    Object.defineProperty(MouseEvent.prototype, 'screenY', {
      get() {
        return this.clientY + window.screenY
      },
    })
  })

  const cursor = createCursor(page)
  page.realCursor = cursor
  page.realClick = cursor.click

  return () => {
    solveStatus = false
    page.off('close', handleClose)
  }
}

async function createIuamBrowser({ proxy, chromePath }) {
  let xvfbSession = null
  let chrome = null
  let browser = null
  const stopControllers = new Set()
  let cleanedUp = false

  async function cleanup() {
    if (cleanedUp) return
    cleanedUp = true

    for (const stopController of stopControllers) {
      try {
        stopController()
      } catch {}
    }
    stopControllers.clear()

    if (chrome) {
      try {
        chrome.kill()
      } catch {}
    }

    if (xvfbSession) {
      try {
        xvfbSession.stopSync()
      } catch {}
    }
  }

  try {
    xvfbSession = createXvfbSession()
    chrome = await launch({
      chromePath,
      ignoreDefaultFlags: true,
      chromeFlags: buildChromeFlags({ proxy }),
    })

    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${chrome.port}`,
      defaultViewport: null,
    })

    const originalClose = browser.close.bind(browser)
    browser.close = async () => {
      try {
        return await originalClose()
      } finally {
        await cleanup()
      }
    }

    browser.on('disconnected', () => {
      cleanup().catch(() => {})
    })

    let [page] = await browser.pages()
    const stopInitialController = await attachIuamPageController({
      page,
      proxy,
      turnstile: true,
      onPageClosed: () => stopControllers.delete(stopInitialController),
    })
    stopControllers.add(stopInitialController)

    browser.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return
      try {
        const newPage = await target.page()
        const stopController = await attachIuamPageController({
          page: newPage,
          proxy,
          turnstile: true,
          onPageClosed: () => stopControllers.delete(stopController),
        })
        stopControllers.add(stopController)
      } catch {}
    })

    return { browser, page, provider: 'iuam-rebrowser' }
  } catch (error) {
    await cleanup()
    throw error
  }
}

module.exports = { createIuamBrowser }
