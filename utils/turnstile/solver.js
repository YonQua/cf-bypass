const { sleep, runUntil } = require('../async')
const { clickTurnstileOnce } = require('./clicker')

const POLL_INTERVAL_MS = 250
const CLICK_RETRY_INTERVAL_MS = 5000

async function waitForTurnstile(page, { timeoutMs, deadline = Date.now() + timeoutMs, readValue, diagnostics, signal }) {
  const interaction = { clickCount: 0, lastState: null, lastError: null }
  diagnostics?.recordInteraction(interaction)
  let nextClickAt = 0

  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const value = await runUntil(deadline, 'turnstile_wait_token', readValue)
    if (Date.now() >= deadline) break
    if (value) return { value, interaction }

    const now = Date.now()
    if (now >= nextClickAt) {
      const attempt = await clickTurnstileOnce(page, { deadline })
      interaction.lastState = attempt.state
      interaction.lastError = attempt.error || null
      interaction.clickCount += attempt.clickCount
      nextClickAt = now + (attempt.clickCount > 0 ? CLICK_RETRY_INTERVAL_MS : POLL_INTERVAL_MS)
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
  }

  return { value: null, interaction }
}

module.exports = { waitForTurnstile }
