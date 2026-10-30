function createError(message, code = 500, detail) {
  const error = new Error(message)
  error.code = code
  if (detail !== undefined) {
    error.detail = detail
  }
  return error
}

function isTimeoutError(error) {
  const name = error?.name || ''
  const message = error?.message || ''
  return name === 'TimeoutError' || message.toLowerCase().includes('timeout')
}

function normalizeError(error, fallbackCode = 500) {
  let code = Number(error?.code) || fallbackCode
  if (!error?.code && isTimeoutError(error)) {
    code = 504
  }
  const message = error?.message || 'Internal Server Error'
  const detail = error?.detail
  if (detail !== undefined) {
    return { code, message, detail }
  }
  return { code, message }
}

function formatMetaValue(value) {
  return JSON.stringify(value)
}

function redact(value, key = '') {
  if (/^(?:cookie|set-cookie|authorization|password|authToken|token|cf_clearance)$/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, redact(item, name)])
  )
  if (typeof value !== 'string') return value
  return value.replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[redacted-header]')
    .replace(/\b(?:https?|socks[45]):\/\/[^\s"'<>]+/gi, raw => {
    try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}` }
    catch { return '[invalid-url]' }
  }).replace(/\b(cf_clearance|token|authToken|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
}

function formatMeta(meta) {
  return Object.entries(meta)
    .map(([key, value]) => `${key}=${formatMetaValue(value)}`)
    .join(' ')
}

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

function normalizeLogLevel(level) {
  const normalized = String(level || 'info').toLowerCase()
  return LOG_LEVELS.includes(normalized) ? normalized : 'info'
}

function buildTimeFormatter(timeZone) {
  const resolvedTimeZone = timeZone || DEFAULT_TIME_ZONE
  const options = {
    timeZone: resolvedTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', options)
  } catch (error) {
    // 时区不合法时回退到默认上海时区，避免日志崩溃
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: DEFAULT_TIME_ZONE })
  }

  return () => {
    const parts = formatter.formatToParts(new Date())
    const valueMap = {}
    for (const part of parts) {
      valueMap[part.type] = part.value
    }
    return `${valueMap.year}-${valueMap.month}-${valueMap.day} ${valueMap.hour}:${valueMap.minute}:${valueMap.second}`
  }
}

function createLogger(options = {}) {
  const formatNow = buildTimeFormatter(options.timeZone)
  const minLevel = normalizeLogLevel(options.level)

  function buildLine(level, message, meta) {
    if (options.format === 'json') {
      const event = /^event=([a-z_]+)$/.exec(message)?.[1]
      return JSON.stringify({
        ...meta,
        timestamp: new Date().toISOString(),
        level,
        ...(event ? { event } : { message }),
      })
    }
    const time = formatNow()
    if (message === 'event=request_complete') {
      const parts = [meta.summary, meta.mode, meta.target, `HTTP ${meta.code}`]
      if (meta.request_elapsed_ms !== undefined) parts.push(`${(meta.request_elapsed_ms / 1000).toFixed(2)}s`)
      if (meta.click_attempt_count) parts.push(`clicks=${meta.click_attempt_count}`)
      if (meta.failure_phase) parts.push(`phase=${meta.failure_phase}`)
      if (meta.failure_reason) parts.push(`reason=${meta.failure_reason}`)
      if (meta.error) parts.push(`error=${JSON.stringify(meta.error)}`)
      parts.push(`request_id=${meta.request_id}`)
      const summary = parts.filter(Boolean).join(' | ').replace(/[\u0000-\u001f\u007f]/g,
        character => JSON.stringify(character).slice(1, -1))
      return `[${time}] ${level.toUpperCase()} ${summary}`
    }
    const metaText = meta && typeof meta === 'object' ? formatMeta(meta) : ''
    const suffix = metaText ? ` ${metaText}` : ''
    return `[${time}] level=${level} ${message}${suffix}`
  }

  function sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta

    return Object.fromEntries(
      Object.entries(meta).filter(([, value]) => value !== undefined && value !== null)
    )
  }

  function shouldLog(level) {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minLevel)
  }

  function write(level, message, meta) {
    if (!shouldLog(level)) return

    const line = buildLine(level, redact(message), redact(sanitizeMeta(meta)))
    if (level === 'warn') {
      console.warn(line)
      return
    }
    if (level === 'error') {
      console.error(line)
      return
    }
    console.log(line)
  }

  return {
    request(meta) {
      const code = meta.code ?? 200
      const outcome = code < 400 ? 'success' : code === 504 ? 'timeout' : code === 499 ? 'cancelled' : code < 500 ? 'rejected' : 'failed'
      const labels = { success: '获取成功', timeout: '请求超时', cancelled: '客户端取消', rejected: '请求被拒绝', failed: '获取失败' }
      write(code >= 500 ? 'error' : code >= 400 ? 'warn' : 'info', 'event=request_complete', {
        summary: labels[outcome], outcome,
        target: meta.target, mode: meta.mode, code,
        request_elapsed_ms: meta.request_elapsed_ms,
        ...(meta.click_attempt_count > 0 ? { click_attempt_count: meta.click_attempt_count } : {}),
        ...(meta.failure_phase ? { failure_phase: meta.failure_phase } : {}),
        ...(meta.failure_reason ? { failure_reason: meta.failure_reason } : {}),
        ...(meta.error ? { error: meta.error } : {}),
        request_id: meta.request_id,
      })
      write('debug', 'event=request_details', meta)
    },
    debug(message, meta) {
      write('debug', message, meta)
    },
    info(message, meta) {
      write('info', message, meta)
    },
    log(message, meta) {
      write('info', message, meta)
    },
    warn(message, meta) {
      write('warn', message, meta)
    },
    error(message, meta) {
      write('error', message, meta)
    },
  }
}

module.exports = {
  createError,
  isTimeoutError,
  normalizeError,
  createLogger,
}
