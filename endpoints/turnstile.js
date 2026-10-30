const { applyProxyAuthentication, applyRequestInterception } = require('../utils/browser')
const { runUntil } = require('../utils/async')
const { createError, isTimeoutError } = require('../utils/errors')
const { createTurnstileDiagnostics } = require('../utils/turnstile/diagnostics')
const { waitForTurnstile } = require('../utils/turnstile/solver')

const DIAGNOSTIC_GRACE_MS = 2000
const TOKEN_SELECTORS = ['[name="cf-response"]', '[name="cf-turnstile-response"]']

async function readTurnstileToken(page) {
  return page.evaluate((selectors) => {
    const callbackToken = window.__turnstileToken?.trim?.()
    if (callbackToken?.length >= 10) return callbackToken

    for (const selector of selectors) {
      const value = document.querySelector(selector)?.value?.trim()
      if (value?.length >= 10) return value
    }
    return null
  }, TOKEN_SELECTORS)
}

function inlineScriptString(value) {
  return JSON.stringify(String(value)).replace(/<\/script/gi, '<\\/script')
}

function normalizeDocumentUrl(value) {
  const url = new URL(value)
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }
  return `${url.protocol}//${url.host}${url.pathname || '/'}${url.search}`
}

function isTargetDocumentRequest(request, page, targetUrl) {
  if (request.resourceType() !== 'document') return false
  if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) return false

  try {
    if (typeof request.frame === 'function' && request.frame() !== page.mainFrame()) return false
    return normalizeDocumentUrl(request.url()) === normalizeDocumentUrl(targetUrl)
  } catch {
    return false
  }
}

function buildSyntheticHtml(siteKey) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <body>
      <div class="turnstile"></div>
      <script>
        window.__turnstileToken = null;
        window.__storeTurnstileToken = function (token) {
          window.__turnstileToken = token;
          var input = document.querySelector('[name="cf-response"]');
          if (!input) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'cf-response';
            document.body.appendChild(input);
          }
          input.value = token;
        };
        window.onloadTurnstileCallback = function () {
          turnstile.render('.turnstile', {
            sitekey: ${inlineScriptString(siteKey)},
            callback: window.__storeTurnstileToken,
          });
        };
      </script>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
    </body>
    </html>
  `
}

async function installSyntheticTurnstilePage(page, { domain, htmlContent, logger, requestId }) {
  await applyRequestInterception(page, async (request) => {
    if (isTargetDocumentRequest(request, page, domain)) {
      await request.respond({
        status: 200,
        contentType: 'text/html',
        body: htmlContent,
      })
      return
    }

    await request.continue()
  }, {
    logger,
    logMeta: {
      request_id: requestId,
      mode: 'turnstile',
    },
  })
}

async function turnstile(
  { domain, proxy, siteKey, timeoutMs, requestDeadline, defaultTimeoutMs, logger, requestId, debugArtifacts, signal },
  page
) {
  if (!domain) throw createError('Missing domain parameter', 400)
  if (!siteKey) throw createError('Missing siteKey parameter', 400)

  const timeout = Number(timeoutMs) || defaultTimeoutMs || 60000
  const startedAt = Date.now()
  const deadline = requestDeadline || startedAt + timeout
  const diagnosticBudget = Math.min(DIAGNOSTIC_GRACE_MS, Math.max(1, Math.floor(timeout / 4)))
  const solveDeadline = deadline - diagnosticBudget
  const diagnostics = createTurnstileDiagnostics({ page, requestId, logger, debugArtifacts })
  let phase = 'turnstile_page_load'

  try {
    await runUntil(solveDeadline, phase, () => applyProxyAuthentication(page, proxy))
    await runUntil(solveDeadline, phase, () => installSyntheticTurnstilePage(page, {
      domain,
      htmlContent: buildSyntheticHtml(siteKey),
      logger,
      requestId,
    }))
    diagnostics.attach()

    await runUntil(solveDeadline, phase, () => page.goto(domain, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, solveDeadline - Date.now()),
    }))

    phase = 'turnstile_wait_token'
    const solveResult = await waitForTurnstile(page, {
      signal,
      deadline: solveDeadline,
      diagnostics,
      readValue: () => readTurnstileToken(page),
    })
    if (!solveResult.value) {
      throw createError(`Turnstile timeout after ${timeout}ms`, 504, { phase })
    }

    const userAgent = await runUntil(solveDeadline, phase, () => page.evaluate(() => navigator.userAgent)).catch(() => null)
    return {
      token: solveResult.value,
      user_agent: userAgent,
      elapsed_time: (Date.now() - startedAt) / 1000,
      _meta: { interaction: solveResult.interaction },
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    // Leave time for the caller to receive diagnostics before its request timer closes the browser.
    const detail = await diagnostics.captureFailure({
      timeoutMs: timeout,
      deadline: Math.min(Date.now() + diagnosticBudget, deadline - Math.min(50, diagnosticBudget / 2)),
      phase: error?.detail?.phase || phase,
      reason: error.message,
    })
    const code = Number(error?.code) || (isTimeoutError(error) ? 504 : 500)
    throw createError(error.message || 'Turnstile failed', code, detail)
  }
}

module.exports = turnstile
