const express = require('express')
const config = require('./config')
const { createLogger, normalizeError, createError } = require('./utils/errors')
const { normalizeProxy, buildProxyCacheKeyValue } = require('./utils/proxy')
const { createBrowser, closeBrowser } = require('./utils/browser')
const { createCacheStore } = require('./utils/cacheStore')
const { createSemaphore } = require('./utils/semaphore')
const { normalizeUrl, validateDomain } = require('./utils/domain')

const app = express()
const port = config.port
const authToken = config.authToken
const SUPPORTED_MODES = new Set(['turnstile', 'funcaptcha', 'iuam'])
let requestCounter = 0

function createRequestId() {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${Date.now()}-${requestCounter}`
}

function buildIuamCacheKey(data) {
  const domain = normalizeUrl(data?.domain, { keepSearch: true, emptyValue: '' })
  const proxy = buildProxyCacheKeyValue(data?.proxy)
  return JSON.stringify({ mode: 'iuam', domain, proxy })
}

function buildLogTarget(domain) {
  return normalizeUrl(domain, { emptyValue: undefined })
}

function splitInternalResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { publicResult: result, internalMeta: null }
  }

  const { _meta, ...publicResult } = result
  return { publicResult, internalMeta: _meta || null }
}

function buildRequestMeta({
  requestId,
  mode,
  target,
  code,
  requestElapsedMs,
  failurePhase,
  browserStartupMs,
  browserProvider,
  cacheHit,
  enteredClickMode,
  clearanceSource,
  proxyEnabled,
}) {
  return {
    request_id: requestId,
    ...(mode ? { mode } : {}),
    ...(target ? { target } : {}),
    ...(code != null ? { code } : {}),
    request_elapsed_ms: requestElapsedMs,
    ...(failurePhase ? { failure_phase: failurePhase } : {}),
    ...(typeof cacheHit === 'boolean' ? { cache_hit: cacheHit } : {}),
    ...(browserStartupMs != null ? { browser_startup_ms: browserStartupMs } : {}),
    ...(browserProvider ? { browser_provider: browserProvider } : {}),
    ...(enteredClickMode ? { entered_click_mode: true } : {}),
    ...(clearanceSource ? { clearance_source: clearanceSource } : {}),
    ...(typeof proxyEnabled === 'boolean' ? { proxy_enabled: proxyEnabled } : {}),
  }
}

function rejectRequest(res, options) {
  const {
    logger,
    requestId,
    mode,
    target,
    requestStartedAt,
    failurePhase,
    error,
  } = options
  const normalized = normalizeError(error)
  logger.warn('event=handler_reject', {
    ...buildRequestMeta({
      requestId,
      mode,
      target,
      requestElapsedMs: Date.now() - requestStartedAt,
      failurePhase,
      code: normalized.code,
    }),
    message: normalized.message,
  })
  return res.status(normalized.code).json(normalized)
}

function logHandlerFailure(options) {
  const {
    logger,
    requestId,
    mode,
    target,
    requestElapsedMs,
    failurePhase,
    browserStartupMs,
    browserProvider,
    enteredClickMode,
    proxyEnabled,
    normalized,
    error,
  } = options
  const meta = buildRequestMeta({
    requestId,
    mode,
    target,
    requestElapsedMs,
    failurePhase,
    browserStartupMs,
    browserProvider,
    enteredClickMode,
    proxyEnabled,
  })

  if (normalized.code >= 500) {
    logger.error('event=handler_error', {
      ...meta,
      error: error?.message || normalized.message,
    })
    return
  }

  logger.warn('event=handler_reject', {
    ...meta,
    code: normalized.code,
    message: normalized.message,
  })
}

const logger = createLogger({ timeZone: config.logTimeZone, level: config.logLevel })

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

    logger.debug('event=request_start', {
      request_id: requestId,
      ip: clientIp,
      mode: req.body?.mode || 'unknown',
      target: buildLogTarget(req.body?.domain) || 'unknown',
      cache_enabled:
        req.body?.mode === 'iuam'
          ? req.body?.cache !== false && req.body?.cache !== 'false'
          : undefined,
    })
  }
  next()
})

const turnstile = require('./endpoints/turnstile')
const funcaptcha = require('./endpoints/funcaptcha')
const cloudflare = require('./endpoints/cloudflare')

app.post('/cloudflare', async (req, res) => {
  const data = req.body
  const requestId = req.requestId || createRequestId()
  const requestStartedAt = req.requestStartedAt || Date.now()
  const target = buildLogTarget(data?.domain)
  let stage = 'request_validation'
  let browserStartupMs = null
  let failurePhase = null
  let enteredClickMode = false
  let clearanceSource = null

  if (!data || typeof data.mode !== 'string') {
    const error = createError('Bad Request: missing or invalid mode', 400)
    return rejectRequest(res, {
      logger,
      requestId,
      target,
      requestStartedAt,
      failurePhase: stage,
      error,
    })
  }
  if (!SUPPORTED_MODES.has(data.mode)) {
    const error = createError(`Bad Request: unsupported mode "${data.mode}"`, 400)
    return rejectRequest(res, {
      logger,
      requestId,
      mode: data.mode,
      target,
      requestStartedAt,
      failurePhase: stage,
      error,
    })
  }
  if (authToken && data.authToken !== authToken) {
    const error = createError('Unauthorized', 401)
    return rejectRequest(res, {
      logger,
      requestId,
      mode: data.mode,
      target,
      requestStartedAt,
      failurePhase: stage,
      error,
    })
  }
  try {
    validateDomain(data.domain, { allowPrivateNetworkTargets: config.allowPrivateNetworkTargets })
    data.proxy = normalizeProxy(data.proxy)
  } catch (err) {
    return rejectRequest(res, {
      logger,
      requestId,
      mode: data.mode,
      target,
      requestStartedAt,
      failurePhase: stage,
      error: err,
    })
  }

  const useCache = data?.cache !== false && data?.cache !== 'false'
  let cacheKey
  if (data.mode === 'iuam' && useCache) {
    stage = 'cache_lookup'
    cacheKey = buildIuamCacheKey(data)
    const cached = cacheStore.get(cacheKey)
    if (cached) {
      logger.info(
        'event=request_complete',
        buildRequestMeta({
          requestId,
          mode: data.mode,
          target,
          code: 200,
          requestElapsedMs: Date.now() - requestStartedAt,
          cacheHit: true,
          proxyEnabled: Boolean(data.proxy),
        })
      )
      return res.status(200).json({ ...cached, cached: true })
    }
  }

  const release = semaphore.tryAcquire()
  if (!release) {
    stage = 'semaphore_acquire'
    const error = createError('Too Many Requests', 429)
    return rejectRequest(res, {
      logger,
      requestId,
      mode: data.mode,
      target,
      requestStartedAt,
      failurePhase: stage,
      error,
    })
  }

  const requestTimeout = Number(data?.timeoutMs) || config.requestTimeoutMs
  let result
  let browser, page
  let browserProvider = null

  try {
    stage = 'browser_connect'
    const browserStartedAt = Date.now()
    const ctx = await createBrowser({
      proxy: data.proxy,
      timeoutMs: requestTimeout,
      mode: data.mode,
    })
    browserStartupMs = Date.now() - browserStartedAt
    browser = ctx.browser
    page = ctx.page
    browserProvider = ctx.provider || 'unknown'
    logger.debug('event=browser_ready', {
      request_id: requestId,
      mode: data.mode,
      browser_provider: browserProvider,
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

      case 'funcaptcha':
        stage = 'funcaptcha_execute'
        result = await funcaptcha(
          {
            ...data,
            timeoutMs: requestTimeout,
            defaultTimeoutMs: config.requestTimeoutMs,
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
    logHandlerFailure({
      logger,
      requestId,
      mode: data.mode,
      target,
      requestElapsedMs: Date.now() - requestStartedAt,
      failurePhase,
      browserStartupMs,
      browserProvider,
      enteredClickMode,
      proxyEnabled: Boolean(data.proxy),
      normalized,
      error: err,
    })
    result = normalized
  } finally {
    await closeBrowser(browser, {
      timeoutMs: config.browserCloseTimeoutMs,
      logger,
      logMeta: {
        request_id: requestId,
        mode: data.mode,
        ...(target ? { target } : {}),
      },
    })
    release()
  }

  const { publicResult, internalMeta } = splitInternalResult(result)
  if (internalMeta) {
    enteredClickMode = internalMeta.enteredClickMode || false
    clearanceSource = internalMeta.clearanceSource || null
  }
  logger.info(
    'event=request_complete',
    buildRequestMeta({
      requestId,
      mode: data.mode,
      target,
      code: publicResult.code ?? 200,
      cacheHit: data.mode === 'iuam' ? false : undefined,
      requestElapsedMs: Date.now() - requestStartedAt,
      browserStartupMs,
      browserProvider,
      failurePhase: publicResult.code ? failurePhase || stage : null,
      enteredClickMode,
      clearanceSource,
      proxyEnabled: Boolean(data.proxy),
    })
  )

  res.status(publicResult.code ?? 200).json({ ...publicResult, cached: false })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' })
})

const server = app.listen(port)

server.on('listening', () => {
  const address = server.address()
  logger.info('event=server_listening', {
    port: typeof address === 'object' && address ? address.port : port,
    host: typeof address === 'object' && address ? address.address : undefined,
    browser_provider: 'mixed',
    pid: process.pid,
  })
})

server.on('error', (err) => {
  logger.error(server.listening ? 'event=server_error' : 'event=server_listen_failed', {
    error: err.message,
    code: err.code,
    port,
    pid: process.pid,
  })
})

let shuttingDown = false

async function gracefulShutdown(signal) {
  if (shuttingDown) {
    logger.warn('event=server_shutdown_duplicate', { signal })
    return
  }
  shuttingDown = true
  logger.info('event=server_shutdown', { signal })
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
    logger.info('event=server_stopped')
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
