const { sleep } = require('../async')

const CLICK_X_OFFSET = 30
const checkboxSessions = new WeakMap()

function isTurnstileTarget(target) {
  const url = target?.url?.() || ''
  return (
    url.includes('challenges.cloudflare.com/cdn-cgi/challenge-platform/') &&
    url.includes('/turnstile/')
  )
}

async function probeTurnstileCheckbox(page) {
  try {
    const target = page.browser().targets().find(isTurnstileTarget)
    if (!target) return { state: 'target_missing' }

    let probe = checkboxSessions.get(page)
    if (!probe || probe.target !== target) {
      await probe?.session?.detach?.().catch(() => {})
      const session = await target.createCDPSession()
      await session.send('DOM.enable')
      probe = { target, session }
      checkboxSessions.set(page, probe)
    }

    const { searchId, resultCount } = await probe.session.send('DOM.performSearch', {
      query: 'input[type=checkbox]',
      includeUserAgentShadowDOM: true,
    })
    await probe.session.send('DOM.discardSearchResults', { searchId }).catch(() => {})
    return { state: resultCount > 0 ? 'checkbox_ready' : 'automatic_verification' }
  } catch (error) {
    checkboxSessions.delete(page)
    return { state: 'probe_error', error: error.message }
  }
}

async function findTurnstileClickCandidate(page) {
  return page.evaluate(() => {
    const candidates = []
    const seen = new Set()

    function add(element, source) {
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0) return

      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ source, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }

    for (const input of document.querySelectorAll('[name="cf-turnstile-response"]')) {
      add(input.parentElement, 'response_parent')
    }
    for (const iframe of document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i]'
    )) {
      add(iframe, 'iframe')
    }
    for (const element of document.querySelectorAll('.turnstile, [data-sitekey]')) {
      add(element, 'container')
    }
    for (const element of document.querySelectorAll('div')) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 290 && rect.width <= 310 && !element.querySelector('*')) {
        add(element, 'empty_300px_box')
      }
    }

    return candidates[0] || null
  })
}

async function clickTurnstileOnce(page, diagnostics) {
  const probe = await probeTurnstileCheckbox(page)
  diagnostics?.recordSolverState?.(probe.state)
  if (probe.error) diagnostics?.recordSolverError?.(new Error(probe.error))
  if (probe.state !== 'checkbox_ready') return { ...probe, clicked: false }

  let candidate
  try {
    candidate = await findTurnstileClickCandidate(page)
  } catch (error) {
    diagnostics?.recordSolverError?.(error)
    return { state: 'candidate_error', error: error.message, clicked: false }
  }
  diagnostics?.recordSolverAttempt?.(candidate ? [candidate] : [])
  if (!candidate) return { state: 'candidate_missing', clicked: false }

  const x = candidate.x + Math.min(CLICK_X_OFFSET, candidate.width / 2)
  const y = candidate.y + candidate.height / 2
  try {
    await page.mouse.move(x, y, { steps: 8 })
    await sleep(120)
    await page.mouse.click(x, y, { delay: 80 })
    diagnostics?.recordSolverClick?.()
    return { state: 'clicked', clicked: true }
  } catch (error) {
    diagnostics?.recordSolverError?.(error)
    return { state: 'click_error', error: error.message, clicked: false }
  }
}

async function clickIuamTurnstileOnce(page) {
  // IUAM 页面可直接暴露隐藏响应元素；linux.do 依赖其父容器坐标，
  // 不能用普通 Turnstile 的 iframe/容器候选搜索替代这条路径。
  const responseElements = await page.$$('[name="cf-turnstile-response"]')
  if (responseElements.length > 0) {
    for (const element of responseElements) {
      let parentElement = null
      try {
        parentElement = await element.evaluateHandle((item) => item.parentElement)
        const box = await parentElement.boundingBox()
        if (!box) continue
        await page.mouse.click(box.x + CLICK_X_OFFSET, box.y + box.height / 2)
      } catch {
      } finally {
        if (parentElement?.dispose) await parentElement.dispose().catch(() => {})
      }
    }
    return true
  }

  const candidates = await page.evaluate(() => {
    const exact = []
    const fallback = []

    for (const element of document.querySelectorAll('div')) {
      try {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 290 || rect.width > 310 || rect.height <= 0 || element.querySelector('*')) {
          continue
        }

        const candidate = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        const css = window.getComputedStyle(element)
        if (css.margin === '0px' && css.padding === '0px') exact.push(candidate)
        else fallback.push(candidate)
      } catch {}
    }

    return exact.length > 0 ? exact : fallback
  })

  for (const candidate of candidates) {
    await page.mouse
      .click(candidate.x + CLICK_X_OFFSET, candidate.y + candidate.height / 2)
      .catch(() => {})
  }

  return candidates.length > 0
}

module.exports = {
  clickIuamTurnstileOnce,
  clickTurnstileOnce,
  findTurnstileClickCandidate,
  probeTurnstileCheckbox,
}
