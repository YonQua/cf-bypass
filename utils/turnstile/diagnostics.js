const fs = require('fs')
const path = require('path')
const { runUntil } = require('../async')
const { normalizeUrl } = require('../domain')

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

function classifyTurnstileEndpoint(url) {
  try {
    const parsed = new URL(url)
    const pathName = parsed.pathname
    if (isTurnstileApiUrl(url)) return 'api_js'
    if (pathName.includes('/turnstile/')) return 'challenge_frame'
    if (pathName.includes('/flow/')) return 'flow'
    if (pathName.includes('/pat/')) return 'pat'
    if (pathName.includes('/cmg/')) return 'cmg'
    if (pathName.includes('/d/')) return 'diagnostic_image'
    return 'other'
  } catch {
    return 'other'
  }
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
    interaction: { clickCount: 0, lastState: null, lastError: null },
  }
}

function summarizeTurnstileResponses(turnstileRequests) {
  const statusCounts = {}
  const nonOkResponses = []

  for (const entry of turnstileRequests) {
    if (entry.event !== 'response') continue

    const statusKey = String(entry.status)
    statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1

    if (entry.status >= 400) {
      nonOkResponses.push({
        endpoint: classifyTurnstileEndpoint(entry.url),
        status: entry.status,
        resourceType: entry.resourceType,
      })
    }
  }

  return {
    requestCount: turnstileRequests.length,
    statusCounts,
    nonOkResponses: nonOkResponses.slice(-8),
  }
}

async function capturePageState(page, deadline, includeArtifacts) {
  try {
    return await runUntil(deadline, 'turnstile_state_capture',
      () => page.evaluate((limits) => {
        const tokenInput = document.querySelector('[name="cf-response"]')
        const tokenValue = typeof tokenInput?.value === 'string' ? tokenInput.value.trim() : ''
        const turnstileInput = document.querySelector('[name="cf-turnstile-response"]')
        const turnstileValue =
          typeof turnstileInput?.value === 'string' ? turnstileInput.value.trim() : ''
        const syntheticToken =
          typeof window.__turnstileToken === 'string' ? window.__turnstileToken.trim() : ''
        const turnstileResponse =
          typeof window.turnstile?.getResponse === 'function' &&
          window.__turnstileWidgetId !== null &&
          window.__turnstileWidgetId !== undefined
            ? String(window.turnstile.getResponse(window.__turnstileWidgetId) || '').trim()
            : ''
        // Serialization and innerText layout are only needed by private artifacts.
        const html = limits.includeArtifacts ? document.documentElement?.outerHTML || '' : ''
        const bodyText = limits.includeArtifacts ? document.body?.innerText || '' : ''

        return {
          currentUrl: window.location.href,
          pageTitle: document.title || null,
          apiObjectPresent: typeof window.turnstile === 'object',
          renderFunctionPresent: typeof window.turnstile?.render === 'function',
          executeFunctionPresent: typeof window.turnstile?.execute === 'function',
          callbackFunctionPresent: typeof window.onloadTurnstileCallback === 'function',
          widgetIdPresent: window.__turnstileWidgetId !== null && window.__turnstileWidgetId !== undefined,
          shouldExecute: window.__turnstileShouldExecute === true,
          turnstileLastError:
            typeof window.__turnstileLastError === 'string' && window.__turnstileLastError.length > 0
              ? window.__turnstileLastError
              : null,
          hiddenInputPresent: Boolean(tokenInput),
          tokenValueLength: tokenValue.length,
          turnstileResponseInputPresent: Boolean(turnstileInput),
          turnstileResponseValueLength: turnstileValue.length,
          syntheticTokenValueLength: syntheticToken.length,
          getResponseValueLength: turnstileResponse.length,
          turnstileContainerCount: document.querySelectorAll('.turnstile, [data-sitekey]').length,
          turnstileIframeCount: document.querySelectorAll(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i]'
          ).length,
          bodyTextSample: bodyText.slice(0, limits.maxBodyTextLength),
          htmlSample: html.slice(0, limits.maxHtmlSampleLength),
          htmlLength: html.length,
        }
      }, {
        includeArtifacts,
        maxBodyTextLength: MAX_BODY_TEXT_LENGTH,
        maxHtmlSampleLength: MAX_HTML_SAMPLE_LENGTH,
      }),
      STATE_TIMEOUT_MS
    )
  } catch {
    return null
  }
}

function buildDetail({ timeoutMs, phase, state, pageState, artifactDir }) {
  const turnstileNetwork = summarizeTurnstileResponses(state.turnstileRequests)

  return {
    timeoutMs,
    label: 'Turnstile',
    phase,
    apiScriptRequested: state.apiScriptRequested,
    apiScriptLoaded: state.apiScriptLoaded,
    apiScriptStatus: state.apiScriptStatus,
    apiScriptFailed: state.apiScriptFailed,
    turnstileRequestCount: turnstileNetwork.requestCount,
    turnstileStatusCounts: turnstileNetwork.statusCounts,
    turnstileNonOkResponses: turnstileNetwork.nonOkResponses,
    consoleErrorCount: state.consoleErrors.length,
    pageErrorCount: state.pageErrors.length,
    failedRequestCount: state.failedRequests.length,
    currentUrl: normalizeUrl(pageState?.currentUrl),
    pageTitle: pageState?.pageTitle,
    apiObjectPresent: pageState?.apiObjectPresent,
    renderFunctionPresent: pageState?.renderFunctionPresent,
    executeFunctionPresent: pageState?.executeFunctionPresent,
    callbackFunctionPresent: pageState?.callbackFunctionPresent,
    widgetIdPresent: pageState?.widgetIdPresent,
    shouldExecute: pageState?.shouldExecute,
    turnstileLastError: pageState?.turnstileLastError,
    turnstileIframeCount: pageState?.turnstileIframeCount,
    turnstileContainerCount: pageState?.turnstileContainerCount,
    hiddenInputPresent: pageState?.hiddenInputPresent,
    tokenValueLength: pageState?.tokenValueLength,
    turnstileResponseInputPresent: pageState?.turnstileResponseInputPresent,
    turnstileResponseValueLength: pageState?.turnstileResponseValueLength,
    getResponseValueLength: pageState?.getResponseValueLength,
    interaction: { ...state.interaction },
    solverClicks: state.interaction.clickCount,
    solverLastState: state.interaction.lastState,
    solverLastError: state.interaction.lastError,
    ...(artifactDir ? { artifactDir } : {}),
  }
}

function createTurnstileDiagnostics({ page, requestId, logger, debugArtifacts }) {
  const state = createState()
  const shouldWriteArtifacts = parseBoolean(debugArtifacts)

  function attach() {
    page.on('console', (message) => {
      if (!shouldWriteArtifacts && !['error', 'warning', 'warn'].includes(message.type())) return
      const entry = {
        type: message.type(),
        text: message.text(),
        ...(shouldWriteArtifacts ? { location: message.location() } : {}),
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

  function recordInteraction(interaction) {
    state.interaction = interaction
  }

  async function writeArtifacts({ reason, pageState, deadline }) {
    const write = (operation) => runUntil(deadline, 'turnstile_artifact_write', operation)
    const artifactDir = path.join(
      ARTIFACT_ROOT,
      `turnstile-${safeRequestId(requestId)}-${Date.now()}`
    )
    await write(() => fs.promises.mkdir(artifactDir, { recursive: true, mode: 0o700 }))
    await write(() => fs.promises.chmod(artifactDir, 0o700))

    const summary = {
      reason,
      capturedAt: new Date().toISOString(),
      diagnostics: state,
      pageState,
    }

    await write(() => fs.promises.writeFile(
      path.join(artifactDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      { encoding: 'utf-8', mode: 0o600, flag: 'wx' }
    ))

    if (pageState?.htmlSample) {
      await write(() => fs.promises.writeFile(path.join(artifactDir, 'html-summary.txt'), pageState.htmlSample,
        { encoding: 'utf-8', mode: 0o600, flag: 'wx' }))
    }

    try {
      const screenshot = await write(() => page.screenshot({ fullPage: true }))
      await write(() => fs.promises.writeFile(path.join(artifactDir, 'screenshot.png'), screenshot,
        { mode: 0o600, flag: 'wx' }))
    } catch (error) {
      await write(() => fs.promises.writeFile(
        path.join(artifactDir, 'screenshot-error.txt'),
        error.message,
        { encoding: 'utf-8', mode: 0o600, flag: 'wx' }
      ))
    }

    return artifactDir
  }

  async function captureFailure({ timeoutMs, phase, reason, deadline = Date.now() + 2000 }) {
    let artifactDir = null
    const pageState = await capturePageState(page, deadline, shouldWriteArtifacts)

    if (shouldWriteArtifacts) {
      try {
        artifactDir = await writeArtifacts({ reason, pageState, deadline })
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
      turnstile_status_counts: detail.turnstileStatusCounts,
      turnstile_non_ok_responses: detail.turnstileNonOkResponses,
      turnstile_iframe_count: detail.turnstileIframeCount,
      widget_id_present: detail.widgetIdPresent,
      turnstile_last_error: detail.turnstileLastError,
      hidden_input_present: detail.hiddenInputPresent,
      token_value_length: detail.tokenValueLength,
      console_error_count: detail.consoleErrorCount,
      page_error_count: detail.pageErrorCount,
      failed_request_count: detail.failedRequestCount,
      current_url: detail.currentUrl,
      page_title: detail.pageTitle,
      turnstile_response_input_present: detail.turnstileResponseInputPresent,
      turnstile_response_value_length: detail.turnstileResponseValueLength,
      solver_clicks: detail.solverClicks,
      solver_last_state: detail.solverLastState,
      solver_last_error: detail.solverLastError,
      artifact_dir: artifactDir,
    })

    return detail
  }

  return {
    attach,
    captureFailure,
    recordInteraction,
  }
}

module.exports = {
  createTurnstileDiagnostics,
}
