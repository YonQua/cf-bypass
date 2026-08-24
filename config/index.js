const path = require('path')

const CACHE_DIR = path.join(__dirname, '..', 'cache')
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json')

function parseBooleanEnv(value, defaultValue) {
  if (value == null) return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function readEnv(name) {
  const value = process.env[name]
  return value != null && String(value).trim() !== '' ? value : null
}

function parseNumberEnv(name, defaultValue) {
  const raw = readEnv(name)
  if (raw == null) return defaultValue
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : defaultValue
}

module.exports = {
  port: parseNumberEnv('PORT', 8080),
  authToken: readEnv('AUTH_TOKEN'),
  browserLimit: parseNumberEnv('BROWSER_LIMIT', 20),
  requestTimeoutMs: parseNumberEnv('REQUEST_TIMEOUT_MS', 60000),
  browserCloseTimeoutMs: Math.max(
    1000,
    parseNumberEnv('BROWSER_CLOSE_TIMEOUT_MS', 5000)
  ),
  shutdownTimeoutMs: Math.max(10000, parseNumberEnv('SHUTDOWN_TIMEOUT_MS', 60000)),
  logTimeZone: readEnv('LOG_TIMEZONE') || 'Asia/Shanghai',
  logLevel: readEnv('LOG_LEVEL') || 'info',
  allowPrivateNetworkTargets: parseBooleanEnv(readEnv('ALLOW_PRIVATE_NETWORK_TARGETS'), true),
  cloakbrowser: {
    headless: parseBooleanEnv(readEnv('CLOAKBROWSER_HEADLESS'), false),
    humanize: parseBooleanEnv(readEnv('CLOAKBROWSER_HUMANIZE'), true),
    stealthArgs: parseBooleanEnv(readEnv('CLOAKBROWSER_STEALTH_ARGS'), true),
    timezone: readEnv('CLOAKBROWSER_TIMEZONE'),
    locale: readEnv('CLOAKBROWSER_LOCALE'),
  },
  cache: {
    dir: CACHE_DIR,
    file: CACHE_FILE,
    ttlMs: 5 * 60 * 1000,
    flushIntervalMs: 30 * 1000,
    flushDebounceMs: 1000,
  },
}
