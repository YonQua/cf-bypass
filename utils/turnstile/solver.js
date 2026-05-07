const { createError } = require('../errors')

const TOKEN_SELECTORS = ['[name="cf-response"]', '[name="cf-turnstile-response"]']
const SOLVER_INTERVAL_MS = 1000
const CLICK_X_OFFSET = 30

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

async function findTurnstileClickCandidates(page) {
  return page.evaluate(() => {
    const candidates = []
    const seen = new Set()

    function addCandidate(element, source) {
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return

      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`
      if (seen.has(key)) return
      seen.add(key)

      candidates.push({
        source,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
    }

    for (const input of document.querySelectorAll('[name="cf-turnstile-response"]')) {
      addCandidate(input.parentElement, 'response_parent')
    }

    for (const iframe of document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i]'
    )) {
      addCandidate(iframe, 'iframe')
    }

    for (const element of document.querySelectorAll('.turnstile, [data-sitekey]')) {
      addCandidate(element, 'container')
    }

    for (const element of document.querySelectorAll('div')) {
      const rect = element.getBoundingClientRect()
      if (!rect || rect.width <= 290 || rect.width > 310 || rect.height <= 0) continue
      if (element.querySelector('*')) continue
      addCandidate(element, 'empty_300px_box')
    }

    return candidates
      .filter((candidate) => candidate.x >= 0 && candidate.y >= 0)
      .slice(0, 8)
  })
}

async function clickTurnstileCandidates(page, candidates, diagnostics) {
  diagnostics?.recordSolverAttempt?.(candidates)

  for (const candidate of candidates) {
    const x = candidate.x + Math.min(CLICK_X_OFFSET, candidate.width / 2)
    const y = candidate.y + candidate.height / 2
    await page.mouse.move(x, y, { steps: 8 }).catch(() => {})
    await delay(120)
    await page.mouse.click(x, y, { delay: 80 }).catch(() => {})
    diagnostics?.recordSolverClick?.()
  }
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
        const candidates = await findTurnstileClickCandidates(page)
        await clickTurnstileCandidates(page, candidates, diagnostics)
      } catch (error) {
        diagnostics?.recordSolverError?.(error)
      }
    }

    await delay(250)
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
