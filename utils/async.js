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

module.exports = { sleep, withTimeout }
