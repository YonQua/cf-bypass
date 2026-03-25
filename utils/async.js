const { createError } = require('./errors')

// 统一超时控制，超时直接抛错，便于上层统一处理
function withTimeout(promise, timeoutMs, label) {
  const safeTimeoutMs = Number(timeoutMs) || 60000
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const message = `${label} timeout after ${safeTimeoutMs}ms`
      reject(createError(message, 504, { timeoutMs: safeTimeoutMs, label }))
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

module.exports = { withTimeout }
