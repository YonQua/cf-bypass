const express = require('express')
const net = require('net')
const config = require('./config')
const { createLogger, normalizeError, createError } = require('./utils/errors')
const { createBrowser } = require('./utils/browser')
const { createCacheStore } = require('./utils/cacheStore')
const { createSemaphore } = require('./utils/semaphore')

const app = express()
const port = config.port
const authToken = config.authToken
let requestCounter = 0

function createRequestId() {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${Date.now()}-${requestCounter}`
}

function buildIuamCacheKey(data) {
  const domain = normalizeDomainForCacheKey(data?.domain)
  const proxy = data?.proxy
    ? {
        hostname: data.proxy.hostname || null,
        port: data.proxy.port || null,
        username: data.proxy.username || null,
      }
    : null

  return JSON.stringify({ mode: 'iuam', domain, proxy })
}

function normalizeDomainForCacheKey(input) {
  const domain = typeof input === 'string' ? input.trim() : ''
  if (!domain) return ''

  try {
    const url = new URL(domain)
    const protocol = url.protocol.toLowerCase()
    const hostname = url.hostname.toLowerCase()

    let port = url.port
    if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) {
      port = ''
    }

    const pathname = url.pathname === '/' ? '' : url.pathname
    return `${protocol}//${hostname}${port ? `:${port}` : ''}${pathname}${url.search}`
  } catch {
    return domain
  }
}

function validateProxy(proxy) {
  if (proxy == null) return
  if (typeof proxy !== 'object' || Array.isArray(proxy)) {
    throw createError('Bad Request: invalid proxy parameter', 400)
  }

  if (typeof proxy.hostname !== 'string' || proxy.hostname.trim() === '') {
    throw createError('Bad Request: proxy.hostname must be a non-empty string', 400)
  }

  if (!Number.isInteger(proxy.port) || proxy.port <= 0) {
    throw createError('Bad Request: proxy.port must be a positive integer', 400)
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

function normalizeIpv6Host(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isIpv6PrivateAddress(hostname) {
  const normalized = normalizeIpv6Host(hostname)
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

  const ipVersion = net.isIP(normalized)
  if (ipVersion === 4) return isIpv4PrivateAddress(normalized)
  if (ipVersion === 6) return isIpv6PrivateAddress(normalized)
  return false
}

function validateDomain(domain) {
  if (typeof domain !== 'string' || domain.trim() === '') {
    throw createError('Bad Request: domain must be a non-empty string', 400)
  }

  const normalized = domain.trim()
  let parsed
  try {
    parsed = new URL(normalized)
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

  if (!config.allowPrivateNetworkTargets && isPrivateNetworkTarget(parsed.hostname)) {
    throw createError('Bad Request: private network targets are not allowed', 400)
  }
}

function splitInternalResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { publicResult: result, internalMeta: null }
  }

  const { _meta, ...publicResult } = result
  return { publicResult, internalMeta: _meta || null }
}

const logger = createLogger({ timeZone: config.logTimeZone })

const cacheStore = createCacheStore({
  filePath: config.cache.file,
  dirPath: config.cache.dir,
  ttlMs: config.cache.ttlMs,
  flushIntervalMs: config.cache.flushIntervalMs,
  flushDebounceMs: config.cache.flushDebounceMs,
  logger,
})

cacheStore.start().catch((err) => {
  logger.warn('event=cache_start_failed', { error: err.message })
})

const semaphore = createSemaphore(config.browserLimit)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
  if (req.path === '/cloudflare') {
    const requestId = createRequestId()
    req.requestId = requestId
    req.requestStartedAt = Date.now()
    let clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.ip ||
      req.socket.remoteAddress

    if (clientIp?.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7)
    }

    logger.log('event=request', {
      request_id: requestId,
      ip: clientIp,
      mode: req.body?.mode || 'unknown',
      domain: req.body?.domain || 'unknown',
      cache_enabled:
        req.body?.mode === 'iuam' && req.body?.cache !== false && req.body?.cache !== 'false',
    })
  }
  next()
})

const turnstile = require('./endpoints/turnstile')
const cloudflare = require('./endpoints/cloudflare')

app.post('/cloudflare', async (req, res) => {
  const data = req.body
  const requestId = req.requestId || createRequestId()
  const requestStartedAt = req.requestStartedAt || Date.now()
  let stage = 'request_validation'
  let browserStartupMs = null
  let failurePhase = null
  let enteredClickMode = false
  let clearanceSource = null

  if (!data || typeof data.mode !== 'string') {
    const error = createError('Bad Request: missing or invalid mode', 400)
    logger.warn('event=handler_reject', {
      request_id: requestId,
      failure_phase: stage,
      code: error.code,
      message: error.message,
    })
    return res.status(error.code).json(normalizeError(error))
  }
  if (authToken && data.authToken !== authToken) {
    const error = createError('Unauthorized', 401)
    logger.warn('event=handler_reject', {
      request_id: requestId,
      failure_phase: stage,
      code: error.code,
      message: error.message,
    })
    return res.status(error.code).json(normalizeError(error))
  }
  try {
    validateDomain(data.domain)
    validateProxy(data.proxy)
  } catch (err) {
    const normalized = normalizeError(err)
    logger.warn('event=handler_reject', {
      request_id: requestId,
      failure_phase: stage,
      code: normalized.code,
      message: normalized.message,
    })
    return res.status(normalized.code).json(normalized)
  }

  const useCache = data?.cache !== false && data?.cache !== 'false'
  let cacheKey
  if (data.mode === 'iuam' && useCache) {
    stage = 'cache_lookup'
    cacheKey = buildIuamCacheKey(data)
    const cached = cacheStore.get(cacheKey)
    if (cached) {
      logger.log('event=request_complete', {
        request_id: requestId,
        mode: data.mode,
        cache_hit: true,
        request_elapsed_ms: Date.now() - requestStartedAt,
        browser_startup_ms: null,
        failure_phase: null,
        entered_click_mode: false,
      })
      return res.status(200).json({ ...cached, cached: true })
    }
  }

  const release = semaphore.tryAcquire()
  if (!release) {
    stage = 'semaphore_acquire'
    const error = createError('Too Many Requests', 429)
    logger.warn('event=handler_reject', {
      request_id: requestId,
      mode: data.mode,
      failure_phase: stage,
      code: error.code,
      message: error.message,
    })
    return res.status(error.code).json(normalizeError(error))
  }

  const requestTimeout = Number(data?.timeoutMs) || config.requestTimeoutMs
  let result
  let browser, page

  try {
    stage = 'browser_connect'
    const proxyServer = data.proxy ? `${data.proxy.hostname}:${data.proxy.port}` : null
    const browserStartedAt = Date.now()
    const ctx = await createBrowser({
      proxyServer,
      timeoutMs: requestTimeout,
    })
    browserStartupMs = Date.now() - browserStartedAt
    browser = ctx.browser
    page = ctx.page
    logger.log('event=browser_ready', {
      request_id: requestId,
      mode: data.mode,
      browser_startup_ms: browserStartupMs,
      proxy_enabled: Boolean(data.proxy),
    })

    switch (data.mode) {
      case 'turnstile':
        stage = 'turnstile_execute'
        result = await turnstile(
          {
            ...data,
            timeoutMs: requestTimeout,
            defaultTimeoutMs: config.requestTimeoutMs,
            logger,
            requestId,
          },
          page
        )
        break

      case 'iuam':
        stage = 'iuam_execute'
        result = await cloudflare(
          {
            ...data,
            timeoutMs: requestTimeout,
            defaultTimeoutMs: config.requestTimeoutMs,
            logger,
            requestId,
          },
          page
        )
        if (useCache && (!result.code || result.code === 200)) {
          const { publicResult } = splitInternalResult(result)
          cacheStore.set(cacheKey, publicResult)
        }
        break

      default:
        throw createError('Invalid mode', 400)
    }
  } catch (err) {
    const normalized = normalizeError(err)
    failurePhase = normalized.detail?.phase || stage
    enteredClickMode = normalized.detail?.enteredClickMode || false
    if (normalized.code >= 500) {
      logger.error('event=handler_error', {
        request_id: requestId,
        mode: data.mode,
        request_elapsed_ms: Date.now() - requestStartedAt,
        failure_phase: failurePhase,
        browser_startup_ms: browserStartupMs,
        entered_click_mode: enteredClickMode,
        error: err.message,
      })
    } else {
      logger.warn('event=handler_reject', {
        request_id: requestId,
        mode: data.mode,
        request_elapsed_ms: Date.now() - requestStartedAt,
        failure_phase: failurePhase,
        browser_startup_ms: browserStartupMs,
        entered_click_mode: enteredClickMode,
        code: normalized.code,
        message: normalized.message,
      })
    }
    result = normalized
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {}
    }
    release()
  }

  const { publicResult, internalMeta } = splitInternalResult(result)
  if (internalMeta) {
    enteredClickMode = internalMeta.enteredClickMode || false
    clearanceSource = internalMeta.clearanceSource || null
  }
  logger.log('event=request_complete', {
    request_id: requestId,
    mode: data.mode,
    code: publicResult.code ?? 200,
    cache_hit: false,
    request_elapsed_ms: Date.now() - requestStartedAt,
    browser_startup_ms: browserStartupMs,
    failure_phase: publicResult.code ? failurePhase || stage : null,
    entered_click_mode: enteredClickMode,
    clearance_source: clearanceSource,
  })

  res.status(publicResult.code ?? 200).json({ ...publicResult, cached: false })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' })
})

const server = app.listen(port, () => {
  logger.log('event=server_start', { port })
})

server.on('error', (err) => {
  logger.error('event=server_error', { error: err.message, code: err.code })
})

let shuttingDown = false

async function gracefulShutdown(signal) {
  if (shuttingDown) {
    logger.warn('event=server_shutdown_duplicate', { signal })
    return
  }
  shuttingDown = true
  logger.log('event=server_shutdown', { signal })
  const shutdownTimer = setTimeout(() => {
    logger.error('event=shutdown_timeout', { timeoutMs: config.shutdownTimeoutMs })
    process.exit(1)
  }, config.shutdownTimeoutMs)
  shutdownTimer.unref()

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })

    await cacheStore.stop().catch((err) => {
      logger.warn('event=cache_stop_failed', { error: err.message })
    })

    clearTimeout(shutdownTimer)
    logger.log('event=server_stopped')
    process.exit(0)
  } catch (err) {
    clearTimeout(shutdownTimer)
    logger.error('event=server_shutdown_failed', { error: err.message })
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

process.on('uncaughtException', (err) => {
  logger.error('event=uncaught_exception', { error: err.message })
})

process.on('unhandledRejection', (reason) => {
  logger.error('event=unhandled_rejection', { reason: reason?.message || reason })
})

module.exports = app
