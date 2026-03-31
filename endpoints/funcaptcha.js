const { applyProxyAuthentication } = require('../utils/browser')
const { withTimeout } = require('../utils/async')
const { createError } = require('../utils/errors')

const ARKOSE_TOKEN_SELECTOR = 'input[name="arkose_labs_token"]'

async function funcaptcha(
  { domain, proxy, timeoutMs, defaultTimeoutMs },
  page
) {
  if (!domain) throw createError('Missing domain parameter', 400)

  const timeout = Number(timeoutMs) || defaultTimeoutMs || 60000
  const startedAtMs = Date.now()

  const workPromise = (async () => {
    await applyProxyAuthentication(page, proxy)

    await page.goto(domain, { waitUntil: 'domcontentloaded', timeout })

    await page.waitForFunction(
      (selector) => {
        const input = document.querySelector(selector)
        return Boolean(input && typeof input.value === 'string' && input.value.trim().length > 0)
      },
      { timeout },
      ARKOSE_TOKEN_SELECTOR
    )

    const result = await page.evaluate((selector) => {
      const input = document.querySelector(selector)
      return {
        token: input?.value || null,
        currentUrl: window.location.href,
        pageTitle: document.title || null,
        userAgent: navigator.userAgent,
      }
    }, ARKOSE_TOKEN_SELECTOR)

    if (!result.token || result.token.length < 10) {
      throw new Error('Failed to get arkose_labs_token')
    }

    return {
      token: result.token,
      page_url: result.currentUrl,
      page_title: result.pageTitle,
      user_agent: result.userAgent,
      elapsed_time: (Date.now() - startedAtMs) / 1000,
    }
  })()

  return withTimeout(workPromise, timeout, 'FunCaptcha')
}

module.exports = funcaptcha
