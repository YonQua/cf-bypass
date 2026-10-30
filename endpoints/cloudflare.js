const { applyProxyAuthentication, readClearanceCookie } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { sleep, runUntil } = require('../utils/async')
const { clickIuamTurnstileOnce } = require('../utils/turnstile/clicker')

const POLL_INTERVAL_MS = 100
const PROBE_INTERVAL_MS = 250
const CLICK_INTERVAL_MS = 2000
const DETECTION_PATH = '^/cdn-cgi/challenge-platform/(?:h/[^/]+/)?(?:scripts/)?(precursor|jsd)/'
const CHALLENGE_TITLES = ['just a moment', 'attention required', '请稍候']
const CHALLENGE_SELECTORS = [
  '#cf-challenge-running', '#cf-please-wait', '#challenge-spinner', '#turnstile-wrapper',
]

function detectionKind(value, origin) {
  try {
    const url = new URL(value)
    return url.origin === origin ? url.pathname.match(DETECTION_PATH)?.[1] : null
  } catch {
    return null
  }
}

function issuedCookie(response) {
  if (response.status() < 200 || response.status() >= 300) return null
  const header = response.headers()['set-cookie']
  const raw = Array.isArray(header) ? header.join('\n') : String(header || '')
  return raw.match(/(?:^|[\n,]\s*)cf_clearance=([^;\s]+)/)?.[1] || null
}

function observePage(page, origin) {
  let current
  const onRequest = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      current = {
        request,
        response: null,
        domReady: false,
        detectors: new Set(),
        pending: new Set(),
        post: null,
        candidate: null,
        revision: 0,
      }
    }
    const kind = detectionKind(request.url(), origin)
    if (!current || !kind ||
      (request.method() !== 'POST' && request.resourceType() !== 'script')) return
    current.detectors.add(kind)
    current.pending.add(request)
    current.revision += 1
    current.candidate = null
    if (request.method() === 'POST') current.post = request
  }
  const onResponse = (response) => {
    const request = response.request()
    if (request === current?.request) current.response = response
    if (!current?.pending.has(request) || request !== current.post) return
    // 响应只提供候选；新检测会使它失效，请求结束不能重新恢复旧候选。
    const cookie = issuedCookie(response)
    current.candidate = cookie ? { cookie } : { reason: 'response_without_clearance' }
    current.revision += 1
  }
  const finish = (request, failed) => {
    if (!current?.pending.delete(request)) return
    current.revision += 1
    if (failed && (request === current.post || !current.candidate?.cookie)) {
      current.candidate = { reason: 'request_failed' }
    }
  }
  const onFinished = (request) => finish(request, false)
  const onFailed = (request) => finish(request, true)
  const onDomReady = () => { if (current) current.domReady = true }
  const listeners = {
    request: onRequest, response: onResponse, requestfinished: onFinished,
    requestfailed: onFailed, domcontentloaded: onDomReady,
  }
  for (const [event, handler] of Object.entries(listeners)) page.on(event, handler)
  return {
    current: () => current,
    close: () => {
      for (const [event, handler] of Object.entries(listeners)) page.off(event, handler)
    },
  }
}

async function readPageState(page, origin) {
  return page.evaluate(({ origin, titles, selectors, detectionPath }) => {
    const title = document.title.trim().toLowerCase()
    const challengeTitle = titles.find((value) => title.includes(value))
    const challengeElement = selectors.find((selector) => {
      const element = document.querySelector(selector)
      if (!element || !element.getClientRects().length) return false
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    })
    // 业务页也可包含尚未填写的 Turnstile，空 token 不能证明整页仍被挑战拦截。
    const challenged = Boolean(challengeTitle || challengeElement)
    const pattern = new RegExp(detectionPath)
    const detectors = [...document.scripts].flatMap((script) => {
      if (!script.src) return []
      const url = new URL(script.src, location.href)
      const kind = url.origin === origin && url.pathname.match(pattern)?.[1]
      return kind ? [kind] : []
    })
    return {
      sameOrigin: location.origin === origin,
      ready: document.readyState !== 'loading', challenged, detectors,
      currentUrl: location.href,
      pageTitle: document.title,
      challengeEvidence: challengeTitle || challengeElement || null,
      userAgent: navigator.userAgent,
    }
  }, { origin, titles: CHALLENGE_TITLES, selectors: CHALLENGE_SELECTORS, detectionPath: DETECTION_PATH })
}

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)
  const startedAt = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000
  const deadline = data.requestDeadline || startedAt + timeoutMs
  const origin = new URL(data.domain).origin
  const observer = observePage(page, origin)
  let progress
  let nextClickAt = 0
  let navigationPending = true
  let navigationError
  const interaction = { clickCount: 0, lastState: null, lastError: null }
  const timeline = []

  function publishProgress() {
    data.onProgress?.({ ...progress, interaction: { ...interaction } })
  }

  function waiting(phase, reason, extra = {}) {
    if (progress?.phase !== phase || progress?.reason !== reason) {
      if (timeline.length === 64) timeline.shift()
      timeline.push({ elapsedMs: Date.now() - startedAt, phase, reason })
    }
    progress = { phase, reason, ...extra }
    publishProgress()
    return null
  }

  async function readState(phase) {
    try {
      return await runUntil(deadline, phase, () => readPageState(page, origin))
    } catch (error) {
      if (error.code === 504) throw error
      if (/Execution context was destroyed|Cannot find context with specified id/.test(error.message || '')) return null
      throw error
    }
  }

  async function captureClearance() {
    const navigation = observer.current()
    const response = navigation?.response
    if (!response) return waiting('iuam_wait_page', 'navigation_pending')
    const documentStatus = response.status()
    if (response.headers()['cf-mitigated'] === 'challenge') {
      return waiting('iuam_wait_challenge', 'challenge_response', { documentStatus })
    }
    if (documentStatus >= 400) {
      return waiting('iuam_target_blocked', 'target_http_error', { documentStatus })
    }
    if (documentStatus < 200 || !navigation.domReady) {
      return waiting('iuam_wait_page', 'document_loading', { documentStatus })
    }
    const state = await readState('iuam_read_page')
    if (!state || navigation !== observer.current() || !state.ready) {
      return waiting('iuam_wait_page', 'document_changed')
    }
    if (!state.sameOrigin) return waiting('iuam_wait_page', 'unexpected_origin', { documentStatus })
    if (state.challenged) return waiting('iuam_wait_challenge', 'challenge_page', {
      documentStatus,
      currentUrl: state.currentUrl,
      pageTitle: state.pageTitle,
      challengeEvidence: state.challengeEvidence,
    })
    for (const kind of state.detectors) navigation.detectors.add(kind)
    if (navigation.detectors.size &&
      (navigation.pending.size || !navigation.candidate?.cookie)) {
      return waiting('iuam_wait_detection', navigation.candidate?.reason ||
        (navigation.pending.size ? 'request_pending' : 'result_pending'), {
        documentStatus, detection: [...navigation.detectors].join(','),
      })
    }
    const revision = navigation.revision
    const clearance = await runUntil(deadline, 'iuam_read_cookie', () => readClearanceCookie(page, data.domain))
    if (!clearance) return waiting('iuam_wait_clearance', 'cookie_not_issued', { documentStatus })
    if (navigation.detectors.size && clearance !== navigation.candidate?.cookie) {
      return waiting('iuam_wait_detection', 'cookie_not_applied', { documentStatus })
    }
    const verified = await readState('iuam_verify_clearance')
    const current = await runUntil(deadline, 'iuam_verify_clearance', () => readClearanceCookie(page, data.domain))
    if (!verified || !verified.sameOrigin || !verified.ready || verified.challenged ||
      verified.detectors.some((kind) => !navigation.detectors.has(kind)) ||
      navigation !== observer.current() || navigation.revision !== revision ||
      clearance !== current || Date.now() >= deadline) {
      return waiting('iuam_verify_clearance', 'snapshot_changed')
    }
    return {
      cf_clearance: current,
      user_agent: verified.userAgent,
      detectionCompleted: navigation.detectors.size > 0,
    }
  }

  try {
    waiting('iuam_wait_page', 'navigation_pending')
    await applyProxyAuthentication(page, data.proxy)
    // 收到挑战响应即可开始处理；成功返回仍须通过文档和检测完成检查。
    runUntil(deadline, 'iuam_navigation', () => page.goto(data.domain, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    })).then(() => {
      navigationPending = false
    }, (error) => {
      navigationPending = false
      navigationError = error
    })
    while (Date.now() < deadline) {
      data.signal?.throwIfAborted()
      if (navigationError) throw navigationError
      const navigation = observer.current()
      const snapshot = await captureClearance()
      if (navigationError) throw navigationError
      if (snapshot && !navigationPending && navigation === observer.current()) {
        const { detectionCompleted, ...result } = snapshot
        data.logger?.info?.('event=iuam_clearance_selected', {
          request_id: data.requestId,
          mode: 'iuam',
          source: 'browser_cookie',
          detection_completed: detectionCompleted,
          clearance_length: result.cf_clearance.length,
          elapsed_ms: Date.now() - startedAt,
        })
        return {
          ...result,
          elapsed_time: (Date.now() - startedAt) / 1000,
          _meta: {
            interaction: { ...interaction },
            clearanceSource: 'browser_cookie',
            detectionCompleted,
          },
        }
      }
      if (progress.phase === 'iuam_wait_challenge' && Date.now() >= nextClickAt) {
        const attempt = await clickIuamTurnstileOnce(page, { deadline })
        interaction.clickCount += attempt.clickCount
        interaction.lastState = attempt.state
        interaction.lastError = attempt.error || null
        publishProgress()
        data.logger?.debug?.('event=iuam_click_attempt', {
          request_id: data.requestId,
          ...attempt,
        })
        nextClickAt = Date.now() + (attempt.clickCount > 0 ? CLICK_INTERVAL_MS : PROBE_INTERVAL_MS)
      }
      if (navigation !== observer.current()) continue
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    }
    throw createError(`IUAM timeout after ${timeoutMs}ms`, 504, {
      timeoutMs,
      label: 'IUAM',
      ...progress,
    })
  } catch (error) {
    if (error.code === 504) {
      error.detail = {
        ...progress,
        ...error.detail,
        interaction: { ...interaction },
      }
    }
    throw error
  } finally {
    observer.close()
    data.logger?.debug?.('event=iuam_timeline', { request_id: data.requestId, timeline })
  }
}

module.exports = cloudflare
