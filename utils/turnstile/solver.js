const { sleep } = require('../async')
const { clickTurnstileOnce } = require('./clicker')

const POLL_INTERVAL_MS = 250
const CLICK_RETRY_INTERVAL_MS = 5000

async function waitForTurnstile(page, { timeoutMs, readValue, diagnostics }) {
  const deadline = Date.now() + timeoutMs
  const interaction = { clickCount: 0, lastState: null, lastError: null }
  let nextClickAt = 0

  while (Date.now() < deadline) {
    const value = await readValue()
    if (value) return { value, interaction }

    const now = Date.now()
    if (now >= nextClickAt) {
      const attempt = await clickTurnstileOnce(page, diagnostics)
      interaction.lastState = attempt.state
      interaction.lastError = attempt.error || null
      if (attempt.clicked) interaction.clickCount += 1
      nextClickAt = now + (attempt.clicked ? CLICK_RETRY_INTERVAL_MS : POLL_INTERVAL_MS)
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
  }

  const value = await readValue()
  return value ? { value, interaction } : { value: null, interaction }
}

module.exports = { waitForTurnstile }
