const fs = require('fs')
const path = require('path')
const { withTimeout } = require('../async')

const STATE_TIMEOUT_MS = 1000
const ARTIFACT_ROOT = process.env.DEBUG_ARTIFACT_DIR || '/tmp/cf-bypass-artifacts'
const MAX_CONSOLE_ENTRIES = 50
const MAX_NETWORK_ENTRIES = 50
const MAX_ERROR_ENTRIES = 20
const MAX_HTML_SAMPLE_LENGTH = 20000
const MAX_BODY_TEXT_LENGTH = 4000

function parseBoolean(value) {
  if (value === true) return true
  if (value === false || value == null) return false
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function safeRequestId(value) {
  return String(value || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function pushLimited(target, entry, limit) {
  target.push(entry)
  if (target.length > limit) target.shift()
}

function isTurnstileApiUrl(url) {
  return (
    url.includes('https://challenges.cloudflare.com/turnstile/v0/api.js') ||
    /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/g\/[^/]+\/api\.js/.test(url)
  )
}

function isTurnstileUrl(url) {
  return url.includes('challenges.cloudflare.com') || url.includes('cloudflare.com/turnstile')
}

function createState() {
  return {
    apiScriptRequested: false,
    apiScriptLoaded: false,
    apiScriptStatus: null,
    apiScriptFailed: null,
    consoleErrors: [],
    consoleMessages: [],
    pageErrors: [],
    failedRequests: [],
    turnstileRequests: [],
    solverAttempts: 0,
    solverClicks: 0,
    solverLastCandidates: [],
    solverLastError: null,
  }
}

async function capturePageState(page) {
  try {
    return await withTimeout(
      page.evaluate((limits) => {
        const tokenInput = document.querySelector('[name="cf-response"]')
        const tokenValue = typeof tokenInput?.value === 'string' ? tokenInput.value.trim() : ''
        const turnstileInput = document.querySelector('[name="cf-turnstile-response"]')
        const turnstileValue =
          typeof turnstileInput?.value === 'string' ? turnstileInput.value.trim() : ''
        const syntheticToken =
          typeof window.__turnstileToken === 'string' ? window.__turnstileToken.trim() : ''
        const html = document.documentElement?.outerHTML || ''
        const bodyText = document.body?.innerText || ''

        return {
          currentUrl: window.location.href,
          pageTitle: document.title || null,
          apiObjectPresent: typeof window.turnstile === 'object',
          renderFunctionPresent: typeof window.turnstile?.render === 'function',
          callbackFunctionPresent: typeof window.onloadTurnstileCallback === 'function',
          hiddenInputPresent: Boolean(tokenInput),
          tokenValueLength: tokenValue.length,
          turnstileResponseInputPresent: Boolean(turnstileInput),
          turnstileResponseValueLength: turnstileValue.length,
          syntheticTokenValueLength: syntheticToken.length,
          turnstileContainerCount: document.querySelectorAll('.turnstile, [data-sitekey]').length,
          turnstileIframeCount: document.querySelectorAll(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i]'
          ).length,
          bodyTextSample: bodyText.slice(0, limits.maxBodyTextLength),
          htmlSample: html.slice(0, limits.maxHtmlSampleLength),
          htmlLength: html.length,
        }
      }, {
        maxBodyTextLength: MAX_BODY_TEXT_LENGTH,
        maxHtmlSampleLength: MAX_HTML_SAMPLE_LENGTH,
      }),
      STATE_TIMEOUT_MS,
      'Turnstile page state',
      { phase: 'turnstile_state_capture' }
    )
  } catch {
    return null
  }
}

function buildDetail({ timeoutMs, phase, state, pageState, artifactDir }) {
  return {
    timeoutMs,
    label: 'Turnstile',
    phase,
    apiScriptRequested: state.apiScriptRequested,
    apiScriptLoaded: state.apiScriptLoaded,
    apiScriptStatus: state.apiScriptStatus,
    apiScriptFailed: state.apiScriptFailed,
    consoleErrorCount: state.consoleErrors.length,
    pageErrorCount: state.pageErrors.length,
    failedRequestCount: state.failedRequests.length,
    currentUrl: pageState?.currentUrl,
    pageTitle: pageState?.pageTitle,
    apiObjectPresent: pageState?.apiObjectPresent,
    renderFunctionPresent: pageState?.renderFunctionPresent,
    callbackFunctionPresent: pageState?.callbackFunctionPresent,
    turnstileIframeCount: pageState?.turnstileIframeCount,
    turnstileContainerCount: pageState?.turnstileContainerCount,
    hiddenInputPresent: pageState?.hiddenInputPresent,
    tokenValueLength: pageState?.tokenValueLength,
    turnstileResponseInputPresent: pageState?.turnstileResponseInputPresent,
    turnstileResponseValueLength: pageState?.turnstileResponseValueLength,
    solverAttempts: state.solverAttempts,
    solverClicks: state.solverClicks,
    solverLastCandidates: state.solverLastCandidates,
    solverLastError: state.solverLastError,
    ...(artifactDir ? { artifactDir } : {}),
  }
}

function createTurnstileDiagnostics({ page, requestId, logger, debugArtifacts }) {
  const state = createState()
  const shouldWriteArtifacts = parseBoolean(debugArtifacts)

  function attach() {
    page.on('console', (message) => {
      const entry = {
        type: message.type(),
        text: message.text(),
        location: message.location(),
      }
      pushLimited(state.consoleMessages, entry, MAX_CONSOLE_ENTRIES)
      if (['error', 'warning', 'warn'].includes(entry.type)) {
        pushLimited(state.consoleErrors, entry, MAX_ERROR_ENTRIES)
      }
    })

    page.on('pageerror', (error) => {
      pushLimited(state.pageErrors, {
        name: error.name,
        message: error.message,
        stack: error.stack,
      }, MAX_ERROR_ENTRIES)
    })

    page.on('request', (request) => {
      const url = request.url()
      if (isTurnstileApiUrl(url)) state.apiScriptRequested = true
      if (isTurnstileUrl(url)) {
        pushLimited(state.turnstileRequests, {
          event: 'request',
          url,
          method: request.method(),
          resourceType: request.resourceType(),
        }, MAX_NETWORK_ENTRIES)
      }
    })

    page.on('response', (response) => {
      const url = response.url()
      if (!isTurnstileUrl(url)) return

      const status = response.status()
      if (isTurnstileApiUrl(url)) {
        state.apiScriptLoaded = status >= 200 && status < 400
        state.apiScriptStatus = status
      }
      pushLimited(state.turnstileRequests, {
        event: 'response',
        url,
        status,
        resourceType: response.request().resourceType(),
      }, MAX_NETWORK_ENTRIES)
    })

    page.on('requestfailed', (request) => {
      const url = request.url()
      const failure = request.failure()
      const entry = {
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: failure?.errorText || null,
      }
      pushLimited(state.failedRequests, entry, MAX_NETWORK_ENTRIES)
      if (isTurnstileApiUrl(url)) state.apiScriptFailed = entry.errorText || 'request_failed'
    })
  }

  function recordSolverAttempt(candidates) {
    state.solverAttempts += 1
    state.solverLastCandidates = candidates.map((candidate) => ({
      source: candidate.source,
      x: Math.round(candidate.x),
      y: Math.round(candidate.y),
      width: Math.round(candidate.width),
      height: Math.round(candidate.height),
    }))
  }

  function recordSolverClick() {
    state.solverClicks += 1
  }

  function recordSolverError(error) {
    state.solverLastError = error.message
    logger?.debug?.('event=turnstile_solver_click_failed', {
      request_id: requestId,
      mode: 'turnstile',
      error: error.message,
    })
  }

  async function writeArtifacts({ reason, pageState }) {
    const artifactDir = path.join(
      ARTIFACT_ROOT,
      `turnstile-${safeRequestId(requestId)}-${Date.now()}`
    )
    await fs.promises.mkdir(artifactDir, { recursive: true })

    const summary = {
      reason,
      capturedAt: new Date().toISOString(),
      diagnostics: state,
      pageState,
    }

    await fs.promises.writeFile(
      path.join(artifactDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8'
    )

    if (pageState?.htmlSample) {
      await fs.promises.writeFile(path.join(artifactDir, 'html-summary.txt'), pageState.htmlSample, 'utf-8')
    }

    try {
      await page.screenshot({
        path: path.join(artifactDir, 'screenshot.png'),
        fullPage: true,
      })
    } catch (error) {
      await fs.promises.writeFile(
        path.join(artifactDir, 'screenshot-error.txt'),
        error.message,
        'utf-8'
      )
    }

    return artifactDir
  }

  async function captureFailure({ timeoutMs, phase, reason }) {
    let artifactDir = null
    let pageState = await capturePageState(page)

    if (shouldWriteArtifacts) {
      try {
        artifactDir = await writeArtifacts({ reason, pageState })
      } catch (error) {
        logger?.warn?.('event=turnstile_debug_artifact_failed', {
          request_id: requestId,
          mode: 'turnstile',
          error: error.message,
        })
      }
    }

    const detail = buildDetail({ timeoutMs, phase, state, pageState, artifactDir })
    logger?.warn?.('event=turnstile_debug_state', {
      request_id: requestId,
      mode: 'turnstile',
      phase,
      api_script_requested: detail.apiScriptRequested,
      api_script_loaded: detail.apiScriptLoaded,
      api_script_status: detail.apiScriptStatus,
      turnstile_iframe_count: detail.turnstileIframeCount,
      hidden_input_present: detail.hiddenInputPresent,
      token_value_length: detail.tokenValueLength,
      console_error_count: detail.consoleErrorCount,
      page_error_count: detail.pageErrorCount,
      failed_request_count: detail.failedRequestCount,
      current_url: detail.currentUrl,
      page_title: detail.pageTitle,
      turnstile_response_input_present: detail.turnstileResponseInputPresent,
      turnstile_response_value_length: detail.turnstileResponseValueLength,
      solver_attempts: detail.solverAttempts,
      solver_clicks: detail.solverClicks,
      artifact_dir: artifactDir,
    })

    return detail
  }

  return {
    attach,
    captureFailure,
    recordSolverAttempt,
    recordSolverClick,
    recordSolverError,
  }
}

module.exports = {
  createTurnstileDiagnostics,
}
