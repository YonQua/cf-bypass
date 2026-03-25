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
  }
}

module.exports = { createSemaphore }
