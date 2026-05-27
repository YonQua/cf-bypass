const { createError } = require('../errors')
const { sleep } = require('../async')
const { clickTurnstileOnce } = require('./clicker')

const TOKEN_SELECTORS = ['[name="cf-response"]', '[name="cf-turnstile-response"]']
const SOLVER_INTERVAL_MS = 1000

async function readTurnstileToken(page) {
  return page.evaluate((selectors) => {
    if (typeof window.__turnstileToken === 'string' && window.__turnstileToken.trim().length >= 10) {
      return window.__turnstileToken.trim()
    }

    for (const selector of selectors) {
      const input = document.querySelector(selector)
      const value = typeof input?.value === 'string' ? input.value.trim() : ''
      if (value.length >= 10) return value
    }

    return null
  }, TOKEN_SELECTORS)
}

async function waitForTurnstileToken(page, { timeoutMs, diagnostics }) {
  const deadline = Date.now() + timeoutMs
  let lastClickAt = 0

  while (Date.now() < deadline) {
    const token = await readTurnstileToken(page).catch(() => null)
    if (token) return token

    const now = Date.now()
    if (now - lastClickAt >= SOLVER_INTERVAL_MS) {
      lastClickAt = now
      try {
        await clickTurnstileOnce(page, diagnostics)
      } catch (error) {
        diagnostics?.recordSolverError?.(error)
      }
    }

    await sleep(250)
  }

  const finalToken = await readTurnstileToken(page).catch(() => null)
  if (finalToken) return finalToken

  throw createError(`Turnstile timeout after ${timeoutMs}ms`, 504, {
    timeoutMs,
    label: 'Turnstile',
    phase: 'turnstile_wait_token',
  })
}

module.exports = {
  waitForTurnstileToken,
}
