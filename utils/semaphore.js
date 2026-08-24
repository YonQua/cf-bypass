function createSemaphore(max) {
  let inUse = 0

  return {
    tryAcquire() {
      if (inUse >= max) return null
      inUse += 1
      let released = false

      return () => {
        if (released) return
        released = true
        inUse -= 1
      }
    },
    getState() {
      return { limit: max, inUse, available: Math.max(0, max - inUse) }
    },
  }
}

module.exports = { createSemaphore }
