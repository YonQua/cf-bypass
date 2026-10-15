const { runUntil, sleep } = require('../async')

const CLICK_X_OFFSET = 30
const DEFAULT_TIMEOUT_MS = 60000

function result(state, clickCount = 0, error) {
  return { state, clickCount, ...(error && { error: error.message || String(error) }) }
}

function detach(session) {
  if (session?.detach) Promise.resolve().then(() => session.detach()).catch(() => {})
}

function isTurnstileTarget(target) {
  const url = target?.url?.() || ''
  return (
    url.includes('challenges.cloudflare.com/cdn-cgi/challenge-platform/') &&
    url.includes('/turnstile/')
  )
}

async function findTargetFrameBox(page, target, deadline) {
  const frames = page.frames().filter((frame) => frame.url() === target.url())
  if (frames.length !== 1) return null
  const element = await runUntil(deadline, 'turnstile_frame_element', () => frames[0].frameElement())
  try {
    const box = await runUntil(deadline, 'turnstile_frame_box', () => element?.boundingBox())
    if (!box || box.width <= 0 || box.height <= 0) return null
    return box
  } finally {
    if (element?.dispose) Promise.resolve().then(() => element.dispose()).catch(() => {})
  }
}

async function clickTurnstileOnce(page, { deadline = Date.now() + DEFAULT_TIMEOUT_MS } = {}) {
  if (Date.now() >= deadline) return result('deadline_exceeded')
  let targets
  try {
    targets = page.browser().targets().filter(isTurnstileTarget)
  } catch (error) {
    return result('probe_error', 0, error)
  }
  if (targets.length === 0) return result('target_missing')

  let sawCheckbox = false
  let lastError
  let lastFailureState = 'probe_error'
  for (const target of targets) {
    if (Date.now() >= deadline) return result('deadline_exceeded')
    let session
    let phase = 'probe_error'
    try {
      session = await runUntil(deadline, 'turnstile_session', () =>
        target.createCDPSession().then((created) => {
          if (Date.now() >= deadline) detach(created)
          return created
        }))
      await runUntil(deadline, 'turnstile_dom_enable', () => session.send('DOM.enable'))
      const { searchId, resultCount } = await runUntil(deadline, 'turnstile_checkbox_search', () =>
        session.send('DOM.performSearch', {
          query: 'input[type=checkbox]',
          includeUserAgentShadowDOM: true,
        }))
      if (searchId) Promise.resolve().then(() => session.send('DOM.discardSearchResults', { searchId })).catch(() => {})
      if (resultCount === 0) continue
      sawCheckbox = true

      // Puppeteer's frameElement resolves the actual iframe, including one in a closed shadow root.
      phase = 'candidate_error'
      const box = await findTargetFrameBox(page, target, deadline)
      if (!box) continue
      const x = box.x + Math.min(CLICK_X_OFFSET, box.width / 2)
      const y = box.y + box.height / 2
      phase = 'click_error'
      await runUntil(deadline, 'turnstile_mouse_move', () => page.mouse.move(x, y, { steps: 8 }))
      await runUntil(deadline, 'turnstile_click_pause', () => sleep(120))
      if (Date.now() >= deadline) return result('deadline_exceeded')
      await runUntil(deadline, 'turnstile_mouse_click', () => page.mouse.click(x, y, { delay: 80 }))
      return result('clicked', 1)
    } catch (error) {
      if (Date.now() >= deadline) return result('deadline_exceeded')
      lastError = error
      lastFailureState = phase
    } finally {
      detach(session)
    }
  }

  if (lastError) return result(lastFailureState, 0, lastError)
  if (sawCheckbox) return result('candidate_missing')
  return result('checkbox_missing')
}

async function clickIuamTurnstileOnce(page, { deadline = Date.now() + DEFAULT_TIMEOUT_MS } = {}) {
  if (Date.now() >= deadline) return result('deadline_exceeded')
  // IUAM 页面可直接暴露隐藏响应元素；linux.do 依赖其父容器坐标，
  // 不能用普通 Turnstile 的 iframe/容器候选搜索替代这条路径。
  let responseElements
  try {
    responseElements = await runUntil(deadline, 'iuam_response_elements', () =>
      page.$$('[name="cf-turnstile-response"]'))
  } catch (error) {
    return Date.now() >= deadline ? result('deadline_exceeded') : result('response_probe_error', 0, error)
  }

  let clickCount = 0
  let lastError
  for (const element of responseElements) {
    if (Date.now() >= deadline) return result('deadline_exceeded', clickCount)
    let parent
    try {
      parent = await runUntil(deadline, 'iuam_response_parent', () =>
        element.evaluateHandle((item) => item.parentElement))
      const box = await runUntil(deadline, 'iuam_response_box', () => parent.boundingBox())
      if (!box || box.width <= 0 || box.height <= 0) continue
      if (Date.now() >= deadline) return result('deadline_exceeded', clickCount)
      await runUntil(deadline, 'iuam_response_click', () =>
        page.mouse.click(box.x + Math.min(CLICK_X_OFFSET, box.width / 2), box.y + box.height / 2))
      clickCount += 1
    } catch (error) {
      if (Date.now() >= deadline) return result('deadline_exceeded', clickCount)
      lastError = error
    } finally {
      if (parent?.dispose) Promise.resolve().then(() => parent.dispose()).catch(() => {})
    }
  }
  if (clickCount > 0) return result('response_parent_clicked', clickCount)
  if (Date.now() >= deadline) return result('deadline_exceeded')

  // Managed challenges expose the checkbox in a cross-origin iframe rather than
  // as a top-level response element. Reuse the guarded generic path so we only
  // click when the challenge target reports a real checkbox.
  const fallback = await clickTurnstileOnce(page, { deadline })
  return fallback.clickCount === 0 && lastError && !fallback.error
    ? { ...fallback, error: lastError.message }
    : fallback
}

module.exports = {
  clickIuamTurnstileOnce,
  clickTurnstileOnce,
}
