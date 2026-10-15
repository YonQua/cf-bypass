const { createError } = require('./errors')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 统一超时控制，超时直接抛错，便于上层统一处理
function withTimeout(promise, timeoutMs, label, options = {}) {
  const safeTimeoutMs = Number(timeoutMs) || 60000
  const { code = 504, message, ...detail } = options
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutMessage = message || `${label} timeout after ${safeTimeoutMs}ms`
      reject(createError(timeoutMessage, code, { timeoutMs: safeTimeoutMs, label, ...detail }))
    }, safeTimeoutMs)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function runUntil(deadline, phase, operation, maximumMs = Infinity) {
  const remaining = Math.min(maximumMs, deadline - Date.now())
  if (remaining <= 0) {
    return Promise.reject(createError('Request deadline exceeded', 504, { phase }))
  }
  return withTimeout(Promise.resolve().then(() => {
    if (Date.now() >= deadline) {
      throw createError('Request deadline exceeded', 504, { phase })
    }
    return operation()
  }), remaining, 'request', { phase })
}

module.exports = { sleep, withTimeout, runUntil }
