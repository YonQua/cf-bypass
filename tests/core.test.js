const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const solveIuam = require('../endpoints/cloudflare')
const { openApiDocument } = require('../openapi')
const { createCacheStore } = require('../utils/cacheStore')
const { isCacheableIuamResult } = require('../utils/cachePolicy')
const { createSemaphore } = require('../utils/semaphore')
const {
  clickIuamTurnstileOnce,
  clickTurnstileOnce,
  probeTurnstileCheckbox,
} = require('../utils/turnstile/clicker')
const { waitForTurnstile } = require('../utils/turnstile/solver')

test('semaphore reports capacity and releases idempotently', () => {
  const semaphore = createSemaphore(2)
  const releaseFirst = semaphore.tryAcquire()
  const releaseSecond = semaphore.tryAcquire()

  assert.deepEqual(semaphore.getState(), { limit: 2, inUse: 2, available: 0 })
  assert.equal(semaphore.tryAcquire(), null)

  releaseFirst()
  releaseFirst()
  assert.deepEqual(semaphore.getState(), { limit: 2, inUse: 1, available: 1 })
  releaseSecond()
})

test('cache persists atomically and exposes readiness state', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cf-bypass-cache-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'cache.json')
  const store = createCacheStore({
    filePath,
    dirPath: directory,
    ttlMs: 60000,
    flushIntervalMs: 60000,
    flushDebounceMs: 60000,
    logger: { warn() {}, debug() {} },
  })

  await store.start()
  assert.equal(store.getState().loaded, true)
  store.set('key', { value: 1 })
  await store.stop()

  const persisted = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
  assert.deepEqual(persisted.key.value, { value: 1 })
  assert.deepEqual(
    (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('IUAM cache only accepts strict cookie matches', () => {
  assert.equal(isCacheableIuamResult({ clearanceSource: 'strict_cookie_match' }), true)
  assert.equal(
    isCacheableIuamResult({ clearanceSource: 'interaction_strict_cookie_match' }),
    true
  )
  assert.equal(isCacheableIuamResult({ clearanceSource: 'verified_non_json_cookie_match' }), false)
  assert.equal(isCacheableIuamResult(null), false)
})

test('OpenAPI document describes all public endpoints and timeout contract', () => {
  assert.equal(openApiDocument.openapi, '3.1.0')
  for (const route of ['/cloudflare', '/health', '/ready', '/openapi.json', '/docs']) {
    assert.ok(openApiDocument.paths[route])
  }

  const timeout = openApiDocument.components.schemas.SolveRequest.properties.timeoutMs
  assert.deepEqual(
    { minimum: timeout.minimum, maximum: timeout.maximum },
    { minimum: 1000, maximum: 300000 }
  )

  const platform = openApiDocument.components.schemas.SolveRequest.properties.browserPlatform
  assert.deepEqual(platform.enum, ['windows', 'macos', 'linux'])
  assert.equal(platform.default, 'macos')
})

function createIuamPage({
  cookieValues = [],
  challengeClearedResults = [true],
  mainStatus = 200,
  cfMitigated = null,
  executeChallengeCheck = false,
  emptyResponseCount = 0,
  detection = null,
}) {
  const handlers = new Map()
  let cookieIndex = 0
  let challengeCheckIndex = 0
  const mainFrame = {}
  const detectionUrl = detection &&
    `https://example.com/cdn-cgi/challenge-platform/scripts/${detection.kind}/main.js`
  const detectionPostUrl = detection &&
    `https://example.com/cdn-cgi/challenge-platform/h/b/${detection.kind}/result`

  function emitDetection() {
    if (!detection) return
    const request = {
      url: () => detection.scriptOnly ? detectionUrl : detectionPostUrl,
      method: () => detection.scriptOnly ? 'GET' : 'POST',
      resourceType: () => detection.scriptOnly ? 'script' : 'fetch',
      isNavigationRequest: () => false,
    }
    handlers.get('request')?.(request)
    const response = {
      url: request.url,
      request: () => request,
      status: () => 200,
      headers: () => ({
        'content-type': detection.contentType || 'text/plain',
        ...(detection.cookie ? { 'set-cookie': `cf_clearance=${detection.cookie}; Path=/` } : {}),
      }),
    }
    handlers.get('response')?.(response)
    if (detection.followupScript) {
      const scriptRequest = {
        url: () => detectionUrl,
        method: () => 'GET',
        resourceType: () => 'script',
        isNavigationRequest: () => false,
      }
      handlers.get('request')?.(scriptRequest)
      handlers.get('requestfinished')?.(scriptRequest)
    }
    if (!detection.unfinished) {
      handlers.get(detection.failed ? 'requestfailed' : 'requestfinished')?.(request)
    }
  }

  return {
    on(event, handler) {
      handlers.set(event, handler)
    },
    off(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event)
    },
    async goto() {
      const request = {
        url: () => 'https://example.com/',
        method: () => 'GET',
        resourceType: () => 'document',
        isNavigationRequest: () => true,
        frame: () => mainFrame,
      }
      handlers.get('request')?.(request)
      handlers.get('response')?.({
        url: request.url,
        request: () => request,
        status: () => mainStatus,
        headers: () => (cfMitigated ? { 'cf-mitigated': cfMitigated } : {}),
      })
      handlers.get('domcontentloaded')?.()
      emitDetection()
    },
    async evaluate(_callback, ...args) {
      if (args.length > 0) {
        if (executeChallengeCheck) {
          const previousDocument = global.document
          const previousLocation = global.location
          const previousNavigator = Object.getOwnPropertyDescriptor(global, 'navigator')
          Object.defineProperty(global, 'navigator', { value: { userAgent: 'test-user-agent' }, configurable: true })
          global.document = {
            title: 'Target page',
            readyState: 'complete',
            scripts: detectionUrl ? [{ src: detectionUrl }] : [],
            querySelector: (selector) =>
              selector === '[name="cf-turnstile-response"]' && emptyResponseCount === 0
                ? { value: 'token' }
                : null,
            querySelectorAll: (selector) =>
              selector === '[name="cf-turnstile-response"]'
                ? [{ value: 'token' }, ...Array(emptyResponseCount).fill({ value: '' })]
                : [],
          }
          global.location = { origin: 'https://example.com' }
          try {
            return _callback(...args)
          } finally {
            global.document = previousDocument
            global.location = previousLocation
            if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator)
            else delete global.navigator
          }
        }
        const cleared =
          challengeClearedResults[
            Math.min(challengeCheckIndex, challengeClearedResults.length - 1)
          ]
        challengeCheckIndex += 1
        return { sameOrigin: true, ready: true,
          challenged: !cleared || emptyResponseCount > 0,
          detectors: detection ? [detection.kind] : [], userAgent: 'test-user-agent' }
      }
      return 'test-user-agent'
    },
    browserContext() {
      return {
        async cookies() {
          const value = cookieValues[Math.min(cookieIndex, cookieValues.length - 1)]
          cookieIndex += 1
          return value ? [{ name: 'cf_clearance', value, domain: 'example.com', path: '/' }] : []
        },
      }
    },
    $$: async () => [],
    mouse: { click: async () => {} },
    mainFrame: () => mainFrame,
  }
}

test('IUAM reads the latest browser cookie when it changes during capture', async () => {
  const result = await solveIuam(
    { domain: 'https://example.com', timeoutMs: 5000 },
    createIuamPage({
      cookieValues: [
        'random-transition-value',
        'final-clearance',
      ],
    })
  )

  assert.equal(result.cf_clearance, 'final-clearance')
  assert.notEqual(result.cf_clearance, 'random-transition-value')
  assert.equal(result.user_agent, 'test-user-agent')
  assert.equal(result._meta.clearanceSource, 'browser_cookie')
})

test('IUAM accepts a completed Precursor POST with a non-JSON response', async () => {
  const result = await solveIuam(
    { domain: 'https://example.com', timeoutMs: 1000 },
    createIuamPage({
      cookieValues: ['page-clearance'],
      detection: { kind: 'precursor', cookie: 'page-clearance', contentType: 'text/plain' },
      executeChallengeCheck: true,
    })
  )
  assert.equal(result.cf_clearance, 'page-clearance')
  assert.equal(result._meta.clearanceSource, 'browser_cookie')
  assert.equal(result._meta.detectionCompleted, true)
})

test('IUAM accepts a populated Turnstile response left on the target page', async () => {
  const result = await solveIuam(
    { domain: 'https://example.com', timeoutMs: 5000 },
    createIuamPage({
      cookieValues: ['final-clearance'],
      executeChallengeCheck: true,
    })
  )

  assert.equal(result.cf_clearance, 'final-clearance')
  assert.equal(result._meta.clearanceSource, 'browser_cookie')
})

test('IUAM keeps waiting when any Turnstile response input is empty', async () => {
  await assert.rejects(
    solveIuam(
      { domain: 'https://example.com', timeoutMs: 1000 },
      createIuamPage({
        cookieValues: ['transition-clearance'],
        executeChallengeCheck: true,
        emptyResponseCount: 1,
      })
    ),
    (error) => error.code === 504 && error.detail?.phase === 'iuam_wait_challenge'
  )
})

test('IUAM rejects a cookie while the challenge page remains', async () => {
  await assert.rejects(
    solveIuam(
      { domain: 'https://example.com', timeoutMs: 30 },
      createIuamPage({
        cookieValues: ['random-transition-value'],
        challengeClearedResults: [false],
      })
    ),
    (error) =>
      error.code === 504 &&
      error.detail?.phase === 'iuam_wait_challenge'
  )
})

test('IUAM rejects a cookie when the challenge reappears', async () => {
  await assert.rejects(
    solveIuam(
      { domain: 'https://example.com', timeoutMs: 3000 },
      createIuamPage({
        cookieValues: ['transition-clearance'],
        challengeClearedResults: [true, false],
      })
    ),
    (error) => error.code === 504 && error.detail?.phase === 'iuam_wait_challenge'
  )
})

test('IUAM rejects a cookie from a mitigated main document', async () => {
  await assert.rejects(
    solveIuam(
      { domain: 'https://example.com', timeoutMs: 2500 },
      createIuamPage({
        cookieValues: ['transition-clearance'],
        challengeClearedResults: [true],
        cfMitigated: 'challenge',
      })
    ),
    (error) => error.code === 504 && error.detail?.phase === 'iuam_wait_challenge'
  )
})

test('IUAM accepts a completed JSD POST after the browser applies its cookie', async () => {
  const result = await solveIuam(
    { domain: 'https://example.com', timeoutMs: 5000 },
    createIuamPage({
      cookieValues: ['jsd-clearance'],
      detection: { kind: 'jsd', cookie: 'jsd-clearance' },
    })
  )

  assert.equal(result.cf_clearance, 'jsd-clearance')
  assert.equal(result._meta.clearanceSource, 'browser_cookie')
  assert.equal(result._meta.detectionCompleted, true)
})

test('IUAM waits when detection is unfinished, failed, or its cookie is not applied', async () => {
  for (const { detection, cookieValues, reason } of [
    {
      detection: { kind: 'precursor', scriptOnly: true },
      cookieValues: ['old-clearance'], reason: 'result_pending',
    },
    {
      detection: { kind: 'precursor', cookie: 'new-clearance', failed: true },
      cookieValues: ['new-clearance'], reason: 'request_failed',
    },
    {
      detection: { kind: 'precursor', cookie: 'new-clearance', unfinished: true },
      cookieValues: ['new-clearance'], reason: 'request_pending',
    },
    {
      detection: { kind: 'precursor', cookie: 'old-clearance', followupScript: true },
      cookieValues: ['old-clearance'], reason: 'result_pending',
    },
    {
      detection: { kind: 'precursor', cookie: 'new-clearance' },
      cookieValues: ['old-clearance'], reason: 'cookie_not_applied',
    },
  ]) {
    await assert.rejects(
      solveIuam(
        { domain: 'https://example.com', timeoutMs: 150 },
        createIuamPage({ detection, cookieValues })
      ),
      (error) => error.code === 504 && error.detail?.phase === 'iuam_wait_detection' &&
        error.detail.reason === reason
    )
  }
})

function createTurnstilePage({ resultCount = 1, candidate = null, clickError = null } = {}) {
  const calls = []
  let clicks = 0
  const session = {
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'DOM.performSearch') return { searchId: 'search-1', resultCount }
      return {}
    },
    detach: async () => {},
  }
  const target = {
    url: () =>
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/example',
    createCDPSession: async () => session,
  }
  const page = {
    browser: () => ({ targets: () => [target] }),
    evaluate: async () => candidate,
    mouse: {
      move: async () => {},
      click: async () => {
        if (clickError) throw clickError
        clicks += 1
      },
    },
  }

  return { page, target, session, calls, getClicks: () => clicks }
}

test('Turnstile probe searches the challenge OOPIF shadow DOM', async () => {
  const { page, calls } = createTurnstilePage()

  assert.deepEqual(await probeTurnstileCheckbox(page), { state: 'checkbox_ready' })
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['DOM.enable', 'DOM.performSearch', 'DOM.discardSearchResults']
  )
  assert.equal(calls[1].params.query, 'input[type=checkbox]')
  assert.equal(calls[1].params.includeUserAgentShadowDOM, true)
})

test('Turnstile automatic verification does not click', async () => {
  const { page, getClicks } = createTurnstilePage({ resultCount: 0 })

  assert.deepEqual(await clickTurnstileOnce(page), {
    state: 'automatic_verification',
    clicked: false,
  })
  assert.equal(getClicks(), 0)
})

test('Turnstile clicks one visible candidate when the checkbox is ready', async () => {
  const candidate = { source: 'iframe', x: 10, y: 20, width: 300, height: 65 }
  const { page, getClicks } = createTurnstilePage({ candidate })

  assert.deepEqual(await clickTurnstileOnce(page), { state: 'clicked', clicked: true })
  assert.equal(getClicks(), 1)
})

test('Turnstile does not click without a visible candidate', async () => {
  const { page, getClicks } = createTurnstilePage({ candidate: null })

  assert.deepEqual(await clickTurnstileOnce(page), {
    state: 'candidate_missing',
    clicked: false,
  })
  assert.equal(getClicks(), 0)
})

test('Turnstile does not count a failed mouse click', async () => {
  const candidate = { source: 'iframe', x: 10, y: 20, width: 300, height: 65 }
  const { page, getClicks } = createTurnstilePage({
    candidate,
    clickError: new Error('mouse unavailable'),
  })

  assert.deepEqual(await clickTurnstileOnce(page), {
    state: 'click_error',
    error: 'mouse unavailable',
    clicked: false,
  })
  assert.equal(getClicks(), 0)
})

test('IUAM clicks the response parent without falling back to generic candidates', async () => {
  let clicks = 0
  let disposed = 0
  const parent = {
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 65 }),
    dispose: async () => {
      disposed += 1
    },
  }
  const page = {
    $$: async () => [{ evaluateHandle: async () => parent }],
    evaluate: async () => {
      throw new Error('generic candidate search must not run')
    },
    mouse: {
      click: async () => {
        clicks += 1
      },
    },
  }

  assert.equal(await clickIuamTurnstileOnce(page), true)
  assert.equal(clicks, 1)
  assert.equal(disposed, 1)
})

test('IUAM clicks a visible Turnstile iframe when no response element is exposed', async () => {
  let clicks = 0
  const target = {
    url: () =>
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/example',
    createCDPSession: async () => ({
      send: async (method) =>
        method === 'DOM.performSearch' ? { searchId: 'search-1', resultCount: 1 } : {},
    }),
  }
  const page = {
    $$: async () => [],
    browser: () => ({ targets: () => [target] }),
    evaluate: async () => ({ source: 'iframe', x: 10, y: 20, width: 300, height: 65 }),
    mouse: {
      move: async () => {},
      click: async () => {
        clicks += 1
      },
    },
  }

  assert.equal(await clickIuamTurnstileOnce(page), true)
  assert.equal(clicks, 1)
})

test('Turnstile probe replaces the CDP session when its target changes', async () => {
  let activeTarget
  let detached = 0
  const oldSession = {
    async send(method) {
      if (method === 'DOM.performSearch') return { searchId: 'old', resultCount: 0 }
      return {}
    },
    async detach() {
      detached += 1
    },
  }
  const newSession = {
    async send(method) {
      if (method === 'DOM.performSearch') return { searchId: 'new', resultCount: 1 }
      return {}
    },
  }
  const oldTarget = {
    url: () =>
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/old',
    createCDPSession: async () => oldSession,
  }
  const newTarget = {
    url: () =>
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/new',
    createCDPSession: async () => newSession,
  }
  activeTarget = oldTarget
  const page = { browser: () => ({ targets: () => [activeTarget] }) }

  assert.deepEqual(await probeTurnstileCheckbox(page), { state: 'automatic_verification' })
  activeTarget = newTarget
  assert.deepEqual(await probeTurnstileCheckbox(page), { state: 'checkbox_ready' })
  assert.equal(detached, 1)
})

test('shared Turnstile wait returns immediately when a value is ready', async () => {
  const result = await waitForTurnstile({}, {
    timeoutMs: 1000,
    readValue: async () => 'ready-value',
  })

  assert.equal(result.value, 'ready-value')
  assert.deepEqual(result.interaction, {
    clickCount: 0,
    lastState: null,
    lastError: null,
  })
})

test('shared Turnstile wait does not hide value read failures', async () => {
  await assert.rejects(
    waitForTurnstile({}, {
      timeoutMs: 1000,
      readValue: async () => {
        throw new Error('browser disconnected')
      },
    }),
    /browser disconnected/
  )
})
