const { sleep } = require('../async')

const CLICK_X_OFFSET = 30

async function findTurnstileClickCandidates(page) {
  return page.evaluate(() => {
    const candidates = []
    const seen = new Set()

    function addCandidate(element, source) {
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return

      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`
      if (seen.has(key)) return
      seen.add(key)

      candidates.push({
        source,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
    }

    for (const input of document.querySelectorAll('[name="cf-turnstile-response"]')) {
      addCandidate(input.parentElement, 'response_parent')
    }

    for (const iframe of document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i]'
    )) {
      addCandidate(iframe, 'iframe')
    }

    for (const element of document.querySelectorAll('.turnstile, [data-sitekey]')) {
      addCandidate(element, 'container')
    }

    for (const element of document.querySelectorAll('div')) {
      const rect = element.getBoundingClientRect()
      if (!rect || rect.width <= 290 || rect.width > 310 || rect.height <= 0) continue
      if (element.querySelector('*')) continue
      addCandidate(element, 'empty_300px_box')
    }

    return candidates
      .filter((candidate) => candidate.x >= 0 && candidate.y >= 0)
      .slice(0, 8)
  })
}

async function clickTurnstileCandidates(page, candidates, diagnostics) {
  diagnostics?.recordSolverAttempt?.(candidates)

  for (const candidate of candidates) {
    const x = candidate.x + Math.min(CLICK_X_OFFSET, candidate.width / 2)
    const y = candidate.y + candidate.height / 2
    await page.mouse.move(x, y, { steps: 8 }).catch(() => {})
    await sleep(120)
    await page.mouse.click(x, y, { delay: 80 }).catch(() => {})
    diagnostics?.recordSolverClick?.()
  }
}

async function clickTurnstileOnce(page, diagnostics) {
  const candidates = await findTurnstileClickCandidates(page)
  await clickTurnstileCandidates(page, candidates, diagnostics)
  return candidates.length
}

async function clickIuamTurnstileOnce(page) {
  const responseElements = await page.$$('[name="cf-turnstile-response"]')
  if (responseElements.length > 0) {
    for (const element of responseElements) {
      let parentElement = null
      try {
        parentElement = await element.evaluateHandle((el) => el.parentElement)
        const box = await parentElement.boundingBox()
        if (!box) continue
        await page.mouse.click(box.x + CLICK_X_OFFSET, box.y + box.height / 2)
      } catch {
      } finally {
        if (parentElement?.dispose) {
          await parentElement.dispose().catch(() => {})
        }
      }
    }
    return true
  }

  const coordinates = await page.evaluate(() => {
    let candidates = []

    document.querySelectorAll('div').forEach((item) => {
      try {
        const rect = item.getBoundingClientRect()
        const css = window.getComputedStyle(item)
        if (
          css.margin === '0px' &&
          css.padding === '0px' &&
          rect.width > 290 &&
          rect.width <= 310 &&
          !item.querySelector('*')
        ) {
          candidates.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
        }
      } catch {}
    })

    if (candidates.length <= 0) {
      document.querySelectorAll('div').forEach((item) => {
        try {
          const rect = item.getBoundingClientRect()
          if (rect.width > 290 && rect.width <= 310 && !item.querySelector('*')) {
            candidates.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
          }
        } catch {}
      })
    }

    return candidates
  })

  for (const item of coordinates) {
    try {
      await page.mouse.click(item.x + CLICK_X_OFFSET, item.y + item.h / 2)
    } catch {}
  }

  return coordinates.length > 0
}

module.exports = {
  clickIuamTurnstileOnce,
  clickTurnstileCandidates,
  clickTurnstileOnce,
  findTurnstileClickCandidates,
}
