const { applyProxyAuthentication } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { sleep, withTimeout } = require('../utils/async')
const { clickIuamTurnstileOnce } = require('../utils/turnstile/clicker')

const IUAM_EXECUTE_GRACE_MS = 5000

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
  const match = raw.match(/cf_clearance=([^;]+)/)
  return match?.[1] || null
}

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)

  const startedAtMs = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000

  let latestStrictClearance = null
  let latestClickClearance = null

  let lastClickAtMs = 0
  let clickModeEnabled = false
  let clickModeEnteredAtMs = null

  const workPromise = (async () => {
    await applyProxyAuthentication(page, data.proxy)

    const onResponse = async (res) => {
      try {
        const url = res.url()
        if (!isChallengePlatformUrl(url)) return

        const req = res.request()
        if (req?.method?.() !== 'POST') return

        const requestHeaders = req.headers?.() || {}
        const isStrict = isJsonContentType(requestHeaders)

        // 参考 cf-bypass-fast：只从 challenge-platform 响应头 Set-Cookie 提取 cf_clearance
        const responseHeaders = res.headers?.() || {}
        const clearance = extractClearanceFromSetCookieHeader(responseHeaders['set-cookie'])
        if (!clearance) return

        if (isStrict) {
          latestStrictClearance = clearance
          return
        }

        // 点击分支：只在判定进入点击模式后才允许取值，避免自动流程中的随机值污染返回
        if (clickModeEnabled) latestClickClearance = clearance
      } catch {}
    }

    page.on('response', onResponse)

    try {
      await page.goto(data.domain, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null)

      const pollIntervalMs = 100
      const clickCooldownMs = 2000
      // 观察窗口：优先等待严格链路；超过窗口仍未拿到 strict clearance，则进入点击模式
      const observeStrictMs = 12000

      async function clickTurnstile() {
        const nowMs = Date.now()
        if (nowMs - lastClickAtMs < clickCooldownMs) return
        lastClickAtMs = nowMs
        if (page.__iuamBackgroundClickAttempted) return

        try {
          await clickIuamTurnstileOnce(page)
        } catch {}
      }

      while (true) {
        const nowMs = Date.now()
        if (nowMs - startedAtMs >= timeoutMs) {
          throw createError(`IUAM timeout after ${timeoutMs}ms`, 504, { label: 'IUAM' })
        }

        // 严格分支：只认严格请求头的 cf_clearance，并要求与浏览器 Cookie 一致才返回
        if (latestStrictClearance) {
          const cookies = await page.cookies().catch(() => [])
          const cfCookie = cookies.find((c) => c.name === 'cf_clearance')
          if (cfCookie?.value && cfCookie.value === latestStrictClearance) {
            const backgroundClickAttempted = Boolean(page.__iuamBackgroundClickAttempted)
            return {
              cf_clearance: latestStrictClearance,
              user_agent: userAgent,
              elapsed_time: (nowMs - startedAtMs) / 1000,
              _meta: {
                enteredClickMode: backgroundClickAttempted,
                clearanceSource: backgroundClickAttempted
                  ? 'background_click_strict_cookie_match'
                  : 'strict_cookie_match',
              },
            }
          }
        }

        // 点击分支：观察窗口结束且仍未拿到 strict clearance，则进入点击模式并开始尝试点击
        if (!clickModeEnabled && nowMs - startedAtMs >= observeStrictMs && !latestStrictClearance) {
          clickModeEnabled = true
          clickModeEnteredAtMs = nowMs
          data.logger?.debug?.('event=iuam_click_mode_enabled', {
            request_id: data.requestId,
            mode: 'iuam',
            observe_strict_ms: observeStrictMs,
            elapsed_ms: nowMs - startedAtMs,
          })
        }

        if (clickModeEnabled) {
          await clickTurnstile()

          // 点击模式：轮询浏览器 Cookie 获取 cf_clearance（最稳，且符合 new8 这类站点“挑战完成后才会下发 cookie”）。
          const cookies = await page.cookies().catch(() => [])
          const cfCookie = cookies.find((c) => c.name === 'cf_clearance')
          if (cfCookie?.value) {
            return {
              cf_clearance: cfCookie.value,
              user_agent: userAgent,
              elapsed_time: (nowMs - startedAtMs) / 1000,
              _meta: {
                enteredClickMode: true,
                clickModeDelayMs: clickModeEnteredAtMs ? nowMs - clickModeEnteredAtMs : 0,
                clearanceSource: 'click_cookie',
              },
            }
          }

          // 兜底：部分情况下 cookie 写入与可读存在延迟，响应头 set-cookie 可能更早可见。
          if (latestClickClearance) {
            return {
              cf_clearance: latestClickClearance,
              user_agent: userAgent,
              elapsed_time: (nowMs - startedAtMs) / 1000,
              _meta: {
                enteredClickMode: true,
                clickModeDelayMs: clickModeEnteredAtMs ? nowMs - clickModeEnteredAtMs : 0,
                clearanceSource: 'click_set_cookie_fallback',
              },
            }
          }
        }

        await sleep(pollIntervalMs)
      }
    } catch (error) {
      if (clickModeEnabled && error?.detail && typeof error.detail === 'object') {
        error.detail = {
          ...error.detail,
          enteredClickMode: true,
          clickModeElapsedMs: clickModeEnteredAtMs ? Date.now() - clickModeEnteredAtMs : 0,
        }
      }
      throw error
    } finally {
      try {
        page.off('response', onResponse)
      } catch {}
    }
  })()

  return withTimeout(workPromise, timeoutMs + IUAM_EXECUTE_GRACE_MS, 'IUAM', {
    phase: 'iuam_execute',
  })
}

module.exports = cloudflare
