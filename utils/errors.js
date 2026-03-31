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
    const time = formatNow()
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

    const line = buildLine(level, message, sanitizeMeta(meta))
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
