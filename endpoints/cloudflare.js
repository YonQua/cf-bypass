const { applyProxyAuthentication } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { sleep } = require('../utils/async')
const { clickIuamTurnstileOnce } = require('../utils/turnstile/clicker')

const POLL_INTERVAL_MS = 100
const CLICK_INTERVAL_MS = 2000
const CHALLENGE_CLEAR_DEBOUNCE_MS = 250
const CHALLENGE_TITLES = ['just a moment', 'attention required', '请稍候']
const CHALLENGE_SELECTORS = [
  '#cf-challenge-running',
  '#cf-please-wait',
  '#challenge-spinner',
  '#turnstile-wrapper',
  '[name="cf-turnstile-response"]',
]

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

function extractClearanceCandidate(response) {
  // 严格候选必须来自 challenge POST 的 JSON 响应和 Set-Cookie；
  // 普通 cookie 或非 JSON 响应只能作为待验证候选，不能直接返回。
  if (!isChallengePlatformUrl(response.url())) return null

  const request = response.request()
  if (request?.method?.() !== 'POST') return null

  const value = extractClearanceFromSetCookieHeader(response.headers?.()['set-cookie'])
  if (!value) return null

  return {
    value,
    strict: isJsonContentType(request.headers?.() || {}),
  }
}

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
        return (
          location.origin === origin &&
          document.readyState !== 'loading' &&
          !(
            titles.some((value) => title.includes(value)) ||
            selectors.some((selector) => document.querySelector(selector))
          )
        )
      },
      { origin: expectedOrigin, titles: CHALLENGE_TITLES, selectors: CHALLENGE_SELECTORS }
    )
  } catch {
    return false
  }
}

async function readClearanceCookie(page) {
  const cookies = await page.cookies().catch(() => [])
  return cookies.find((cookie) => cookie.name === 'cf_clearance' && cookie.value)?.value || null
}

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)

  const startedAtMs = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000
  const deadline = startedAtMs + timeoutMs
  const expectedOrigin = new URL(data.domain).origin
  let generation = 0
  let strictCandidate = null
  let fallbackCandidate = null
  let mainDocument = null
  let nextClickAtMs = 0
  let interactionAttempted = false

  const onResponse = (response) => {
    try {
      const documentResponse = extractMainDocument(response, page)
      if (documentResponse) mainDocument = documentResponse

      const candidate = extractClearanceCandidate(response)
      if (!candidate) return

      generation += 1
      const observedCandidate = { ...candidate, generation }
      if (candidate.strict) strictCandidate = observedCandidate
      else fallbackCandidate = observedCandidate

      data.logger?.debug?.('event=iuam_candidate_observed', {
        request_id: data.requestId,
        mode: 'iuam',
        source: candidate.strict ? 'json' : 'non_json',
        generation,
        clearance_length: candidate.value.length,
      })
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

    function buildResult(candidate, source) {
      data.logger?.info?.('event=iuam_clearance_selected', {
        request_id: data.requestId,
        mode: 'iuam',
        source,
        generation: candidate.generation,
        clearance_length: candidate.value.length,
        elapsed_ms: Date.now() - startedAtMs,
      })
      return {
        cf_clearance: candidate.value,
        user_agent: userAgent,
        elapsed_time: (Date.now() - startedAtMs) / 1000,
        _meta: {
          enteredClickMode: interactionAttempted,
          clearanceSource: source,
          candidateGeneration: candidate.generation,
        },
      }
    }

    async function verifyFallbackCandidate(candidate) {
      if (candidate !== fallbackCandidate || strictCandidate) return false
      if (!(await challengeCleared(page, expectedOrigin, mainDocument))) return false

      await sleep(Math.min(CHALLENGE_CLEAR_DEBOUNCE_MS, Math.max(1, deadline - Date.now())))
      if (candidate !== fallbackCandidate || strictCandidate) return false
      if (!(await challengeCleared(page, expectedOrigin, mainDocument))) return false

      const currentClearance = await readClearanceCookie(page)
      return candidate === fallbackCandidate && !strictCandidate && currentClearance === candidate.value
    }

    while (Date.now() < deadline) {
      const nowMs = Date.now()
      const clearanceCookie = await readClearanceCookie(page)

      // 严格结果还必须与 cookie jar 当前值一致，避免返回挑战过程中的随机 cookie。
      if (strictCandidate && clearanceCookie === strictCandidate.value) {
        return buildResult(
          strictCandidate,
          interactionAttempted ? 'interaction_strict_cookie_match' : 'strict_cookie_match'
        )
      }

      if (
        !strictCandidate &&
        fallbackCandidate &&
        clearanceCookie === fallbackCandidate.value &&
        (await verifyFallbackCandidate(fallbackCandidate))
      ) {
        return buildResult(fallbackCandidate, 'verified_non_json_cookie_match')
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
      candidateGeneration: generation,
    })
  } finally {
    page.off('response', onResponse)
  }
}

module.exports = cloudflare
