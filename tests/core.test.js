const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const solveIuam = require('../endpoints/cloudflare')
const { openApiDocument } = require('../openapi')
const { createCacheStore } = require('../utils/cacheStore')
const { createSemaphore } = require('../utils/semaphore')
const {
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
  assert.equal(platform.default, 'windows')
})

function createIuamPage(cookieValue) {
  return {
    browser: () => ({ targets: () => [] }),
    goto: async () => {},
    evaluate: async () => 'test-user-agent',
    cookies: async () =>
      cookieValue ? [{ name: 'cf_clearance', value: cookieValue }] : [],
  }
}

test('IUAM succeeds from the current browser clearance cookie', async () => {
  const result = await solveIuam(
    { domain: 'https://example.com', timeoutMs: 1000 },
    createIuamPage('current-clearance')
  )

  assert.equal(result.cf_clearance, 'current-clearance')
  assert.equal(result.user_agent, 'test-user-agent')
  assert.deepEqual(result._meta.interaction, {
    clickCount: 0,
    lastState: null,
    lastError: null,
  })
})

test('IUAM timeout preserves the final interaction state', async () => {
  await assert.rejects(
    solveIuam({ domain: 'https://example.com', timeoutMs: 30 }, createIuamPage(null)),
    (error) =>
      error.code === 504 &&
      error.detail?.phase === 'iuam_wait_clearance' &&
      error.detail?.interaction?.lastState === 'target_missing'
  )
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
