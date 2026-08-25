const { applyProxyAuthentication, applyRequestInterception } = require('../utils/browser')
const { withTimeout } = require('../utils/async')
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

function hasDiagnosticDetail(error) {
  return (
    error?.detail?.label === 'Turnstile' &&
    Object.prototype.hasOwnProperty.call(error.detail, 'apiScriptRequested')
  )
}

async function turnstile(
  { domain, proxy, siteKey, timeoutMs, defaultTimeoutMs, logger, requestId, debugArtifacts },
  page
) {
  if (!domain) throw createError('Missing domain parameter', 400)
  if (!siteKey) throw createError('Missing siteKey parameter', 400)

  const timeout = Number(timeoutMs) || defaultTimeoutMs || 60000
  const tokenTimeout = Math.max(1000, timeout - DIAGNOSTIC_GRACE_MS)
  const startedAt = Date.now()
  const diagnostics = createTurnstileDiagnostics({ page, requestId, logger, debugArtifacts })

  async function throwWithDiagnostics(error, phase, options = {}) {
    const detail = await diagnostics.captureFailure({
      timeoutMs: timeout,
      phase,
      reason: error.message,
    })
    const code = options.code || Number(error?.code) || (isTimeoutError(error) ? 504 : 500)
    const message = options.message || error.message || 'Turnstile failed'
    throw createError(message, code, detail)
  }

  const workPromise = (async () => {
    await applyProxyAuthentication(page, proxy)

    await installSyntheticTurnstilePage(page, {
      domain,
      htmlContent: buildSyntheticHtml(siteKey),
      logger,
      requestId,
    })
    diagnostics.attach()

    try {
      await page.goto(domain, { waitUntil: 'domcontentloaded', timeout })
    } catch (error) {
      await throwWithDiagnostics(error, 'turnstile_page_load')
    }

    const solveResult = await waitForTurnstile(page, {
      timeoutMs: tokenTimeout,
      diagnostics,
      readValue: () => readTurnstileToken(page),
    })

    const token = solveResult.value
    if (!token) {
      await throwWithDiagnostics(
        new Error(`Turnstile timeout after ${timeout}ms`),
        'turnstile_wait_token',
        { code: 504 }
      )
    }

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null)
    return {
      token,
      user_agent: userAgent,
      elapsed_time: (Date.now() - startedAt) / 1000,
      _meta: { interaction: solveResult.interaction },
    }
  })()

  try {
    return await withTimeout(workPromise, timeout + DIAGNOSTIC_GRACE_MS, 'Turnstile', {
      phase: 'turnstile_execute',
      message: `Turnstile timeout after ${timeout}ms`,
    })
  } catch (error) {
    if (hasDiagnosticDetail(error)) throw error
    await throwWithDiagnostics(error, error?.detail?.phase || 'turnstile_execute')
  }
}

module.exports = turnstile
