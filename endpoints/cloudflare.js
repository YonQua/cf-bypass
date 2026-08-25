const { applyProxyAuthentication } = require('../utils/browser')
const { createError } = require('../utils/errors')
const { waitForTurnstile } = require('../utils/turnstile/solver')

async function cloudflare(data, page) {
  if (!data.domain) throw createError('Missing domain parameter', 400)

  const startedAtMs = Date.now()
  const timeoutMs = Number(data.timeoutMs) || data.defaultTimeoutMs || 60000
  const deadline = startedAtMs + timeoutMs

  await applyProxyAuthentication(page, data.proxy)
  await page.goto(data.domain, {
    waitUntil: 'domcontentloaded',
    timeout: Math.max(1, deadline - Date.now()),
  })

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null)
  const { value: clearance, interaction } = await waitForTurnstile(page, {
    timeoutMs: Math.max(1, deadline - Date.now()),
    readValue: async () => {
      // 每个请求使用全新浏览器；若以后复用会话，必须先清除目标域的旧 clearance。
      const cookies = await page.cookies()
      return cookies.find((cookie) => cookie.name === 'cf_clearance' && cookie.value)?.value || null
    },
  })

  if (!clearance) {
    throw createError(`IUAM timeout after ${timeoutMs}ms`, 504, {
      timeoutMs,
      label: 'IUAM',
      phase: 'iuam_wait_clearance',
      interaction,
    })
  }

  return {
    cf_clearance: clearance,
    user_agent: userAgent,
    elapsed_time: (Date.now() - startedAtMs) / 1000,
    _meta: { interaction },
  }
}

module.exports = cloudflare
