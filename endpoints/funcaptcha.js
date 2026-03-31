const { applyProxyAuthentication } = require('../utils/browser')
const { withTimeout } = require('../utils/async')
const { createError, isTimeoutError } = require('../utils/errors')

const ARKOSE_TOKEN_SELECTOR = 'input[name="arkose_labs_token"]'
const FUNCAPTCHA_EXECUTE_GRACE_MS = 2000
const FUNCAPTCHA_STATE_TIMEOUT_MS = 1000

async function funcaptcha({ domain, proxy, timeoutMs, defaultTimeoutMs }, page) {
  if (!domain) throw createError('Missing domain parameter', 400)

  const timeout = Number(timeoutMs) || defaultTimeoutMs || 60000
  const startedAtMs = Date.now()

  async function capturePageState() {
    try {
      return await withTimeout(
        page.evaluate((selector) => {
          const tokenInput = document.querySelector(selector)
          const tokenValue = typeof tokenInput?.value === 'string' ? tokenInput.value.trim() : ''
          return {
            currentUrl: window.location.href,
            pageTitle: document.title || null,
            hasArkoseForm: Boolean(document.querySelector('.js-arkose-labs-form')),
            recaptchaPresent: Boolean(
              document.querySelector('.g-recaptcha, textarea[name=\"g-recaptcha-response\"]')
            ),
            tokenInputPresent: Boolean(tokenInput),
            tokenValueLength: tokenValue.length,
            arkoseIframeCount: document.querySelectorAll(
              'iframe[src*="arkose"], iframe[src*="arkoselabs"], iframe[title*="Arkose" i]'
            ).length,
          }
        }, ARKOSE_TOKEN_SELECTOR),
        FUNCAPTCHA_STATE_TIMEOUT_MS,
        'FunCaptcha page state',
        { phase: 'funcaptcha_state_capture' }
      )
    } catch {
      return null
    }
  }

  async function failIfUnsupportedChallenge() {
    const pageState = await capturePageState()
    if (pageState?.recaptchaPresent && !pageState.tokenInputPresent) {
      throw createError('FunCaptcha unsupported challenge: reCAPTCHA detected', 422, {
        label: 'FunCaptcha',
        phase: 'funcaptcha_recaptcha_present',
        challengeType: 'recaptcha',
        ...pageState,
      })
    }
  }

  async function gotoTarget() {
    try {
      await page.goto(domain, { waitUntil: 'domcontentloaded', timeout })
    } catch (error) {
      if (isTimeoutError(error)) {
        throw createError(`FunCaptcha page load timeout after ${timeout}ms`, 504, {
          timeoutMs: timeout,
          label: 'FunCaptcha',
          phase: 'funcaptcha_page_load',
        })
      }
      throw error
    }
  }

  async function waitForTokenValue() {
    try {
      await page.waitForFunction(
        (selector) => {
          const input = document.querySelector(selector)
          return Boolean(input && typeof input.value === 'string' && input.value.trim().length > 0)
        },
        { timeout },
        ARKOSE_TOKEN_SELECTOR
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        const pageState = await capturePageState()
        throw createError(`FunCaptcha token wait timeout after ${timeout}ms`, 504, {
          timeoutMs: timeout,
          label: 'FunCaptcha',
          phase: 'funcaptcha_wait_token',
          ...(pageState || {}),
        })
      }
      throw error
    }
  }

  const workPromise = (async () => {
    await applyProxyAuthentication(page, proxy)

    await gotoTarget()
    await failIfUnsupportedChallenge()
    await waitForTokenValue()

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

  return withTimeout(workPromise, timeout + FUNCAPTCHA_EXECUTE_GRACE_MS, 'FunCaptcha', {
    phase: 'funcaptcha_execute',
  })
}

module.exports = funcaptcha
