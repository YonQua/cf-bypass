const { applyProxyAuthentication, readClearanceCookie } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { sleep } = require('../utils/async')
const { clickIuamTurnstileOnce } = require('../utils/turnstile/clicker')

const POLL_INTERVAL_MS = 100
const CLICK_INTERVAL_MS = 2000
const CHALLENGE_TITLES = ['just a moment', 'attention required', '请稍候']
const CHALLENGE_SELECTORS = [
  '#cf-challenge-running',
  '#cf-please-wait',
  '#challenge-spinner',
  '#turnstile-wrapper',
  '[name="cf-turnstile-response"]',
]

function extractMainDocument(response, page) {
  try {
    const request = response.request()
    if (!request?.isNavigationRequest?.()) return null
    if (request.frame?.() !== page.mainFrame?.()) return null

    const headers = response.headers?.() || {}
    return {
      url: response.url(),
      status: response.status?.() || 0,
      cfMitigated: headers['cf-mitigated'] || null,
    }
  } catch {
    return null
  }
}

async function challengeCleared(page, expectedOrigin, mainDocument) {
  if (!mainDocument) return false
  if (
    mainDocument.cfMitigated === 'challenge' ||
    mainDocument.status < 200 ||
    mainDocument.status >= 400
  ) {
    return false
  }
  try {
    if (new URL(mainDocument.url).origin !== expectedOrigin) return false
  } catch {
    return false
  }

  try {
    return await page.evaluate(
      ({ origin, titles, selectors }) => {
        const title = document.title.trim().toLowerCase()
        const hasActiveChallengeSelector = selectors.some((selector) => {
          if (selector === '[name="cf-turnstile-response"]') {
            // Cloudflare keeps populated response inputs after success; only
            // an empty response input still represents an active challenge.
            return [...document.querySelectorAll(selector)].some(
              (element) => !element.value?.trim()
            )
          }
          return Boolean(document.querySelector(selector))
        })
        return (
          location.origin === origin &&
          document.readyState !== 'loading' &&
          !(
            titles.some((value) => title.includes(value)) ||
            hasActiveChallengeSelector
          )
        )
      },
      { origin: expectedOrigin, titles: CHALLENGE_TITLES, selectors: CHALLENGE_SELECTORS }
    )
  } catch {
    return false
  }
}

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)

  const startedAtMs = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000
  const deadline = startedAtMs + timeoutMs
  const expectedOrigin = new URL(data.domain).origin
  let initialClearance = null
  let mainDocument = null
  let nextClickAtMs = 0
  let interactionAttempted = false

  const onRequest = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainDocument = null
    }
  }
  const onResponse = (response) => {
    const document = extractMainDocument(response, page)
    if (document) mainDocument = document
  }

  async function captureClearance() {
    const document = mainDocument
    if (!(await challengeCleared(page, expectedOrigin, document))) return null

    const clearance = await readClearanceCookie(page, data.domain)
    if (!clearance || (initialClearance && clearance === initialClearance)) return null
    const userAgent = await page.evaluate(() => navigator.userAgent)
    if (!(await challengeCleared(page, expectedOrigin, document))) return null
    const current = await readClearanceCookie(page, data.domain)
    if (Date.now() >= deadline || document !== mainDocument || current !== clearance) {
      return null
    }
    return { cf_clearance: current, user_agent: userAgent }
  }

  page.on('request', onRequest)
  page.on('response', onResponse)

  try {
    await applyProxyAuthentication(page, data.proxy)
    await page.goto(data.domain, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    })

    while (Date.now() < deadline) {
      const snapshot = await captureClearance()
      if (snapshot) {
        if (!initialClearance) {
          // 页面通过后的首个 Cookie 可能仍是过渡值，当前完成条件要求再次更新。
          initialClearance = snapshot.cf_clearance
          data.logger?.debug?.('event=iuam_clearance_update_waiting', {
            request_id: data.requestId,
            mode: 'iuam',
          })
        } else {
          data.logger?.info?.('event=iuam_clearance_selected', {
            request_id: data.requestId,
            mode: 'iuam',
            source: 'updated_browser_cookie',
            clearance_length: snapshot.cf_clearance.length,
            elapsed_ms: Date.now() - startedAtMs,
          })
          return {
            ...snapshot,
            elapsed_time: (Date.now() - startedAtMs) / 1000,
            _meta: {
              enteredClickMode: interactionAttempted,
              clearanceSource: 'updated_browser_cookie',
            },
          }
        }
      }

      const nowMs = Date.now()
      // 交互只推进挑战，不参与 clearance 判定。
      if (!initialClearance && nowMs >= nextClickAtMs) {
        const clicked = await clickIuamTurnstileOnce(page).catch(() => false)
        interactionAttempted = interactionAttempted || clicked
        nextClickAtMs = nowMs + CLICK_INTERVAL_MS
      }

      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    }

    throw createError(`IUAM timeout after ${timeoutMs}ms`, 504, {
      timeoutMs,
      label: 'IUAM',
      phase: initialClearance ? 'iuam_wait_clearance_update' : 'iuam_wait_clearance',
      enteredClickMode: interactionAttempted,
    })
  } finally {
    page.off('request', onRequest)
    page.off('response', onResponse)
  }
}

module.exports = cloudflare
