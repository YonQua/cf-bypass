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

module.exports = {
  port: Number(process.env.PORT) || 8080,
  authToken: process.env.authToken || null,
  browserLimit: Number(process.env.browserLimit) || 20,
  requestTimeoutMs: Number(process.env.timeOut) || 60000,
  browserCloseTimeoutMs: Math.max(1000, Number(process.env.browserCloseTimeoutMs) || 5000),
  shutdownTimeoutMs: Math.max(10000, Number(process.env.timeOut) || 60000),
  logTimeZone: process.env.LOG_TIMEZONE || 'Asia/Shanghai',
  logLevel: process.env.LOG_LEVEL || 'info',
  allowPrivateNetworkTargets: parseBooleanEnv(process.env.ALLOW_PRIVATE_NETWORK_TARGETS, true),
  cloakbrowser: {
    headless: parseBooleanEnv(process.env.CLOAKBROWSER_HEADLESS, false),
    humanize: parseBooleanEnv(process.env.CLOAKBROWSER_HUMANIZE, true),
    stealthArgs: parseBooleanEnv(process.env.CLOAKBROWSER_STEALTH_ARGS, true),
    fingerprintSeed: process.env.CLOAKBROWSER_FINGERPRINT_SEED || null,
    timezone: process.env.CLOAKBROWSER_TIMEZONE || null,
    locale: process.env.CLOAKBROWSER_LOCALE || null,
  },
  cache: {
    dir: CACHE_DIR,
    file: CACHE_FILE,
    ttlMs: 5 * 60 * 1000,
    flushIntervalMs: 30 * 1000,
    flushDebounceMs: 1000,
  },
}
