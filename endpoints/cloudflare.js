const { applyProxyAuthentication } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { sleep } = require('../utils/async')
const { clickIuamTurnstileOnce } = require('../utils/turnstile/clicker')

const POLL_INTERVAL_MS = 100
const CLICK_INTERVAL_MS = 2000

function isChallengePlatformUrl(url) {
  return typeof url === 'string' && url.includes('/cdn-cgi/challenge-platform/')
}

function isJsonContentType(headers) {
  const raw = headers?.['content-type'] || headers?.['Content-Type'] || ''
  return String(raw).toLowerCase().includes('application/json')
}

function extractClearanceFromSetCookieHeader(setCookieHeader) {
  if (!setCookieHeader) return null
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader.join('\n') : String(setCookieHeader)
  return raw.match(/cf_clearance=([^;]+)/)?.[1] || null
}

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)

  const startedAtMs = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000
  const deadline = startedAtMs + timeoutMs
  let responseClearance = null
  let nextClickAtMs = 0
  let interactionAttempted = false

  const onResponse = (response) => {
    try {
      if (!isChallengePlatformUrl(response.url())) return

      const request = response.request()
      if (request?.method?.() !== 'POST') return

      const clearance = extractClearanceFromSetCookieHeader(response.headers?.()['set-cookie'])
      if (!clearance) return

      if (isJsonContentType(request.headers?.() || {})) {
        responseClearance = clearance
      }
    } catch {}
  }

  page.on('response', onResponse)

  try {
    await applyProxyAuthentication(page, data.proxy)
    await page.goto(data.domain, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    })

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null)

    while (Date.now() < deadline) {
      const nowMs = Date.now()
      const cookies = await page.cookies().catch(() => [])
      const clearanceCookie = cookies.find(
        (cookie) => cookie.name === 'cf_clearance' && cookie.value
      )

      // 响应提供候选值，cookie jar 只确认它已成为浏览器当前使用的最终值。
      if (responseClearance && clearanceCookie?.value === responseClearance) {
        return {
          cf_clearance: responseClearance,
          user_agent: userAgent,
          elapsed_time: (nowMs - startedAtMs) / 1000,
          _meta: {
            enteredClickMode: interactionAttempted,
            clearanceSource: interactionAttempted
              ? 'interaction_strict_cookie_match'
              : 'strict_cookie_match',
          },
        }
      }

      // 交互只推进挑战，不参与 clearance 判定。
      if (nowMs >= nextClickAtMs) {
        const clicked = await clickIuamTurnstileOnce(page).catch(() => false)
        interactionAttempted = interactionAttempted || clicked
        nextClickAtMs = nowMs + CLICK_INTERVAL_MS
      }

      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    }

    throw createError(`IUAM timeout after ${timeoutMs}ms`, 504, {
      timeoutMs,
      label: 'IUAM',
      phase: 'iuam_wait_clearance',
      enteredClickMode: interactionAttempted,
    })
  } finally {
    page.off('response', onResponse)
  }
}

module.exports = cloudflare
