const net = require('net')
const { createError } = require('./errors')

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:'])

function formatProxyHostname(hostname) {
  return net.isIP(hostname) === 6 ? `[${hostname}]` : hostname
}

function normalizeProxyUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw createError('Bad Request: proxy.url must be a non-empty string', 400)
  }

  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw createError('Bad Request: proxy.url must be a valid URL', 400)
  }

  const protocol = parsed.protocol.toLowerCase()
  if (!SUPPORTED_PROXY_PROTOCOLS.has(protocol)) {
    throw createError('Bad Request: proxy.url protocol must be http, https, socks4, or socks5', 400)
  }

  if (!parsed.hostname) {
    throw createError('Bad Request: proxy.url hostname is required', 400)
  }

  if (!parsed.port) {
    throw createError('Bad Request: proxy.url port is required', 400)
  }

  if (parsed.username || parsed.password) {
    throw createError('Bad Request: proxy.url must not include username or password', 400)
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    throw createError('Bad Request: proxy.url must not include a path', 400)
  }

  if (parsed.search) {
    throw createError('Bad Request: proxy.url must not include a query string', 400)
  }

  if (parsed.hash) {
    throw createError('Bad Request: proxy.url must not include a fragment', 400)
  }

  const hostname = formatProxyHostname(parsed.hostname.toLowerCase())
  return `${protocol}//${hostname}:${parsed.port}`
}

function normalizeProxy(proxy) {
  if (proxy == null) return null

  if (typeof proxy !== 'object' || Array.isArray(proxy)) {
    throw createError('Bad Request: invalid proxy parameter', 400)
  }

  if ('hostname' in proxy || 'port' in proxy) {
    throw createError(
      'Bad Request: legacy proxy.hostname/proxy.port is no longer supported; use proxy.url',
      400
    )
  }

  const hasUsername = proxy.username !== undefined && proxy.username !== null
  const hasPassword = proxy.password !== undefined && proxy.password !== null
  if (hasUsername !== hasPassword) {
    throw createError(
      'Bad Request: proxy.username and proxy.password must be provided together',
      400
    )
  }

  if (hasUsername && (typeof proxy.username !== 'string' || proxy.username.trim() === '')) {
    throw createError('Bad Request: proxy.username must be a non-empty string', 400)
  }

  if (hasPassword && (typeof proxy.password !== 'string' || proxy.password.trim() === '')) {
    throw createError('Bad Request: proxy.password must be a non-empty string', 400)
  }

  const normalized = {
    url: normalizeProxyUrl(proxy.url),
  }

  if (hasUsername) normalized.username = proxy.username
  if (hasPassword) normalized.password = proxy.password
  return normalized
}

function buildProxyCacheKeyValue(proxy) {
  if (!proxy) return null
  return {
    url: proxy.url,
    username: proxy.username || null,
  }
}

module.exports = {
  buildProxyCacheKeyValue,
  normalizeProxy,
  normalizeProxyUrl,
}
