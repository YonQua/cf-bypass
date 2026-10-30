const { createError } = require('./errors')
const { createBrowser, closeBrowser } = require('./browser_lifecycle')

async function readClearanceCookie(page, targetUrl) {
  const target = new URL(targetUrl)
  const cookies = await page.browserContext().cookies()
  const now = Date.now() / 1000
  const matches = cookies.filter((cookie) => {
    if (cookie.name !== 'cf_clearance' || !cookie.value || cookie.partitionKeyOpaque) return false
    const domain = cookie.domain.replace(/^\./, '')
    if (target.hostname !== domain &&
      !(cookie.domain.startsWith('.') && target.hostname.endsWith(`.${domain}`))) return false
    const path = cookie.path || '/'
    if (target.pathname !== path &&
      !(target.pathname.startsWith(path) &&
        (path.endsWith('/') || target.pathname[path.length] === '/'))) return false
    if (cookie.secure && target.protocol !== 'https:') return false
    if (cookie.expires > 0 && cookie.expires <= now) return false
    if (cookie.partitionKey) {
      const partitionOrigin = typeof cookie.partitionKey === 'string'
        ? cookie.partitionKey
        : cookie.partitionKey.sourceOrigin
      const site = new URL(partitionOrigin)
      if (site.protocol !== target.protocol ||
        (target.hostname !== site.hostname && !target.hostname.endsWith(`.${site.hostname}`)) ||
        cookie.partitionKey.hasCrossSiteAncestor) return false
    }
    return true
  })
  if (matches.length > 1) {
    throw createError('Multiple cf_clearance cookies match the target domain and path', 409)
  }
  return matches[0]?.value || null
}

async function applyProxyAuthentication(page, proxy) {
  if (page?.__proxyAuthenticationHandled) return
  if (!proxy?.username || !proxy?.password) return
  await page.authenticate({
    username: proxy.username,
    password: proxy.password,
  })
}

async function applyRequestInterception(page, handler, options = {}) {
  const { logger, logMeta } = options
  await page.setRequestInterception(true)
  page.removeAllListeners('request')
  page.on('request', async (request) => {
    try {
      await handler(request)
    } catch (error) {
      if (logger?.warn) {
        logger.warn('event=request_interception_handler_failed', {
          ...logMeta,
          url: request.url(),
          resource_type: request.resourceType(),
          error: error.message,
        })
      }
      try {
        await request.continue()
      } catch {}
    }
  })
}

module.exports = {
  applyProxyAuthentication,
  applyRequestInterception,
  closeBrowser,
  createBrowser,
  readClearanceCookie,
}
