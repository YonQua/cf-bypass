const net = require('net')
const { createError } = require('./errors')

function normalizeUrl(input, options = {}) {
  const { keepSearch = false, emptyValue = null } = options
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return emptyValue

  try {
    const url = new URL(raw)
    const protocol = url.protocol.toLowerCase()
    const hostname = url.hostname.toLowerCase()

    let port = url.port
    if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) {
      port = ''
    }

    const pathname = url.pathname === '/' ? '' : url.pathname
    const search = keepSearch ? url.search : ''
    return `${protocol}//${hostname}${port ? `:${port}` : ''}${pathname}${search}`
  } catch {
    return raw
  }
}

function isIpv4PrivateAddress(hostname) {
  const segments = hostname.split('.').map(Number)
  if (segments.length !== 4 || segments.some((value) => Number.isNaN(value))) return false
  const [a, b] = segments
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function stripIpBrackets(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
}

function isIpv6PrivateAddress(hostname) {
  const normalized = stripIpBrackets(hostname)
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

function isPrivateNetworkTarget(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  if (!normalized) return false
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true

  const ipHost = stripIpBrackets(normalized)
  const ipVersion = net.isIP(ipHost)
  if (ipVersion === 4) return isIpv4PrivateAddress(ipHost)
  if (ipVersion === 6) return isIpv6PrivateAddress(ipHost)
  return false
}

function validateDomain(domain, options = {}) {
  const { allowPrivateNetworkTargets = false } = options
  if (typeof domain !== 'string' || domain.trim() === '') {
    throw createError('Bad Request: domain must be a non-empty string', 400)
  }

  let parsed
  try {
    parsed = new URL(domain.trim())
  } catch {
    throw createError('Bad Request: domain must be a valid URL', 400)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createError('Bad Request: domain protocol must be http or https', 400)
  }

  if (!parsed.hostname) {
    throw createError('Bad Request: domain hostname is required', 400)
  }

  if (parsed.username || parsed.password) {
    throw createError('Bad Request: domain must not include username or password', 400)
  }

  if (!allowPrivateNetworkTargets && isPrivateNetworkTarget(parsed.hostname)) {
    throw createError('Bad Request: private network targets are not allowed', 400)
  }
}

module.exports = {
  normalizeUrl,
  validateDomain,
}
