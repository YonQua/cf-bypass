const fs = require('fs')

function createCacheStore({
  filePath,
  dirPath,
  ttlMs,
  flushIntervalMs,
  flushDebounceMs,
  logger = console,
}) {
  let store = {}
  let dirty = false
  let flushing = false
  let dirtyDuringFlush = false
  let debounceTimer = null
  let intervalTimer = null

  function logInfo(message) {
    if (logger?.debug) {
      logger.debug(message)
      return
    }
    if (logger?.log) {
      logger.log(message)
    }
  }

  function logWarn(message, error) {
    if (!logger?.warn) return
    logger.warn(message, error ? { error: error.message } : undefined)
  }

  function markDirty() {
    if (flushing) {
      dirtyDuringFlush = true
    } else {
      dirty = true
    }
    scheduleFlush()
  }

  // O(n) 清理过期条目，降低内存占用与磁盘写入体积
  function purgeExpired(now) {
    let removed = 0
    for (const [key, entry] of Object.entries(store)) {
      if (!entry?.timestamp || now - entry.timestamp >= ttlMs) {
        delete store[key]
        removed += 1
      }
    }
    return removed
  }

  async function loadFromDisk() {
    if (!fs.existsSync(filePath)) return
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object') {
        store = parsed
      }
      const removed = purgeExpired(Date.now())
      if (removed > 0) {
        logInfo(`event=cache_purge removed=${removed}`)
        markDirty()
      }
    } catch (error) {
      logWarn('event=cache_load_failed', error)
    }
  }

  async function flushToDisk() {
    if (flushing || !dirty) return
    flushing = true
    dirty = false

    try {
      await fs.promises.mkdir(dirPath, { recursive: true })
      const payload = JSON.stringify(store, null, 2)
      await fs.promises.writeFile(filePath, payload, 'utf-8')
    } catch (error) {
      dirty = true
      logWarn('event=cache_flush_failed', error)
    } finally {
      flushing = false
      if (dirtyDuringFlush) {
        dirtyDuringFlush = false
        dirty = true
        flushToDisk()
      }
    }
  }

  function scheduleFlush() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      flushToDisk()
    }, flushDebounceMs)
    if (typeof debounceTimer.unref === 'function') {
      debounceTimer.unref()
    }
  }

  function get(key) {
    const entry = store[key]
    if (!entry) return null
    if (!entry.timestamp || Date.now() - entry.timestamp >= ttlMs) {
      delete store[key]
      markDirty()
      return null
    }
    return entry.value
  }

  function set(key, value) {
    store[key] = { timestamp: Date.now(), value }
    markDirty()
  }

  async function start() {
    await loadFromDisk()
    intervalTimer = setInterval(() => {
      const removed = purgeExpired(Date.now())
      if (removed > 0) {
        logInfo(`event=cache_purge removed=${removed}`)
        markDirty()
      }
      flushToDisk()
    }, flushIntervalMs)
    if (typeof intervalTimer.unref === 'function') {
      intervalTimer.unref()
    }
  }

  async function stop() {
    if (intervalTimer) clearInterval(intervalTimer)
    if (debounceTimer) clearTimeout(debounceTimer)
    await flushToDisk()
  }

  return {
    get,
    set,
    start,
    stop,
  }
}

module.exports = { createCacheStore }
