const express = require('express')
const config = require('./config')
const { createLogger, normalizeError, createError } = require('./utils/errors')
const { normalizeProxy, buildProxyCacheKeyValue } = require('./utils/proxy')
const { createBrowser, closeBrowser } = require('./utils/browser')
const { createCacheStore } = require('./utils/cacheStore')
const { createSemaphore } = require('./utils/semaphore')
const { normalizeUrl, validateDomain } = require('./utils/domain')
const { withTimeout } = require('./utils/async')
const { openApiDocument, docsHtml } = require('./openapi')
const turnstile = require('./endpoints/turnstile')
const funcaptcha = require('./endpoints/funcaptcha')
const iuam = require('./endpoints/cloudflare')

const app = express()
const port = config.port
const authToken = config.authToken
const SOLVERS = { turnstile, funcaptcha, iuam }
const BROWSER_PLATFORMS = new Set(['windows', 'macos', 'linux'])
let requestCounter = 0
const MIN_REQUEST_TIMEOUT_MS = 1000
const MAX_REQUEST_TIMEOUT_MS = 300000

function parseRequestTimeout(value) {
  if (value == null || value === '') return config.requestTimeoutMs
  const timeoutMs = Number(value)
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_REQUEST_TIMEOUT_MS ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw createError(
      `Bad Request: timeoutMs must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
      400
    )
  }
  return timeoutMs
}

function parseBrowserPlatform(value) {
  const platform = value == null || value === '' ? config.browserPlatform : value
  if (typeof platform !== 'string' || !BROWSER_PLATFORMS.has(platform)) {
    throw createError(
      'Bad Request: browserPlatform must be one of windows, macos, linux',
      400
    )
  }
  return platform
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now())
}

function createRequestId() {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${Date.now()}-${requestCounter}`
}

function buildIuamCacheKey(data) {
  const domain = normalizeUrl(data?.domain, { keepSearch: true, emptyValue: '' })
  const proxy = buildProxyCacheKeyValue(data?.proxy)
  return JSON.stringify({ mode: 'iuam', domain, proxy, browserPlatform: data.browserPlatform })
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
  interaction,
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
    ...(interaction?.clickCount > 0
      ? { entered_click_mode: true, click_attempt_count: interaction.clickCount }
      : {}),
    ...(interaction?.lastState ? { turnstile_state: interaction.lastState } : {}),
    ...(interaction?.lastError ? { turnstile_error: interaction.lastError } : {}),
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
    interaction,
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
    interaction,
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

app.post('/cloudflare', async (req, res) => {
  const data = req.body
  const requestId = req.requestId || createRequestId()
  const requestStartedAt = req.requestStartedAt || Date.now()
  const target = buildLogTarget(data?.domain)
  let stage = 'request_validation'
  let browserStartupMs = null
  let failurePhase = null
  let interaction = null
  let requestTimeout
  let requestDeadline

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
  if (!Object.hasOwn(SOLVERS, data.mode)) {
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
    data.browserPlatform = parseBrowserPlatform(data.browserPlatform)
    requestTimeout = parseRequestTimeout(data.timeoutMs)
    requestDeadline = requestStartedAt + requestTimeout
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

  let result
  let browser, page
  let browserProvider = null

  try {
    stage = 'browser_connect'
    const browserStartedAt = Date.now()
    const ctx = await createBrowser({
      proxy: data.proxy,
      platform: data.browserPlatform,
      timeoutMs: remainingTime(requestDeadline),
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

    stage = `${data.mode}_execute`
    const solverTimeout = remainingTime(requestDeadline)
    result = await withTimeout(
      SOLVERS[data.mode](
        {
          ...data,
          timeoutMs: solverTimeout,
          logger,
          requestId,
        },
        page
      ),
      solverTimeout,
      'request',
      {
        phase: stage,
        message: `Request timeout after ${requestTimeout}ms`,
      }
    )

    if (data.mode === 'iuam' && useCache) {
      const { publicResult } = splitInternalResult(result)
      cacheStore.set(cacheKey, publicResult)
    }
  } catch (err) {
    const normalized = normalizeError(err)
    failurePhase = normalized.detail?.phase || stage
    interaction = normalized.detail?.interaction || null
    logHandlerFailure({
      logger,
      requestId,
      mode: data.mode,
      target,
      requestElapsedMs: Date.now() - requestStartedAt,
      failurePhase,
      browserStartupMs,
      browserProvider,
      interaction,
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
    interaction = internalMeta.interaction || null
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
      interaction,
      proxyEnabled: Boolean(data.proxy),
    })
  )

  res.status(publicResult.code ?? 200).json({ ...publicResult, cached: false })
})

app.get('/health', (req, res) => {
  const status = shuttingDown ? 'shutting_down' : 'ok'
  res.status(shuttingDown ? 503 : 200).json({
    status,
    uptime: process.uptime(),
    concurrency: semaphore.getState(),
  })
})

app.get('/ready', (req, res) => {
  const cache = cacheStore.getState()
  const ready = !shuttingDown && cache.loaded && !cache.lastError
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    cache,
    concurrency: semaphore.getState(),
  })
})

app.get('/openapi.json', (req, res) => res.json(openApiDocument))
app.get('/docs', (req, res) => res.type('html').send(docsHtml))

app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' })
})

const server = app.listen(port)

server.on('listening', () => {
  const address = server.address()
  logger.info('event=server_listening', {
    port: typeof address === 'object' && address ? address.port : port,
    host: typeof address === 'object' && address ? address.address : undefined,
    browser_provider: 'cloakbrowser',
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
