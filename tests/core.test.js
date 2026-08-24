const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createCacheStore } = require('../utils/cacheStore')
const { createSemaphore } = require('../utils/semaphore')
const { openApiDocument } = require('../openapi')
const solveIuam = require('../endpoints/cloudflare')

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

function createIuamPage({ strictClearance, cookieValues }) {
  let responseHandler = null
  let cookieIndex = 0
  let evaluateCount = 0

  return {
    on(event, handler) {
      if (event === 'response') responseHandler = handler
    },
    off(event, handler) {
      if (event === 'response' && responseHandler === handler) responseHandler = null
    },
    async goto() {
      if (!strictClearance) return
      responseHandler?.({
        url: () => 'https://example.com/cdn-cgi/challenge-platform/flow/ov1',
        request: () => ({
          method: () => 'POST',
          headers: () => ({ 'content-type': 'application/json' }),
        }),
        headers: () => ({ 'set-cookie': `cf_clearance=${strictClearance}; Path=/` }),
      })
    },
    async evaluate() {
      evaluateCount += 1
      return evaluateCount === 1 ? 'test-user-agent' : []
    },
    async cookies() {
      const value = cookieValues[Math.min(cookieIndex, cookieValues.length - 1)]
      cookieIndex += 1
      return value ? [{ name: 'cf_clearance', value }] : []
    },
    mouse: {
      move: async () => {},
      click: async () => {},
    },
  }
}

test('IUAM ignores a random cookie until it matches strict response clearance', async () => {
  const page = createIuamPage({
    strictClearance: 'final-clearance',
    cookieValues: ['random-transition-value', 'final-clearance'],
  })

  const result = await solveIuam({ domain: 'https://example.com', timeoutMs: 1000 }, page)

  assert.equal(result.cf_clearance, 'final-clearance')
  assert.notEqual(result.cf_clearance, 'random-transition-value')
  assert.equal(result.user_agent, 'test-user-agent')
  assert.equal(result._meta.clearanceSource, 'strict_cookie_match')
})

test('IUAM ignores a non-JSON challenge cookie and times out without strict confirmation', async () => {
  let responseHandler = null
  const page = {
    on(event, handler) {
      if (event === 'response') responseHandler = handler
    },
    off() {},
    async goto() {
      responseHandler?.({
        url: () => 'https://example.com/cdn-cgi/challenge-platform/flow/ov1',
        request: () => ({
          method: () => 'POST',
          headers: () => ({ 'content-type': 'text/plain' }),
        }),
        headers: () => ({
          'set-cookie': 'cf_clearance=random-transition-value; Path=/',
        }),
      })
    },
    evaluate: async () => [],
    cookies: async () => [{ name: 'cf_clearance', value: 'random-transition-value' }],
    mouse: {
      move: async () => {},
      click: async () => {},
    },
  }

  await assert.rejects(
    solveIuam({ domain: 'https://example.com', timeoutMs: 50 }, page),
    (error) => error.code === 504 && error.detail?.phase === 'iuam_wait_clearance'
  )
})
