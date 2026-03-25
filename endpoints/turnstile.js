const { applyProxyAuthentication, applyRequestInterception } = require('../utils/browser')
const { withTimeout } = require('../utils/async')
const { createError } = require('../utils/errors')

function escapeInlineScriptString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/<\/script/gi, '<\\/script')
}

async function turnstile(
  { domain, proxy, siteKey, timeoutMs, defaultTimeoutMs, logger, requestId },
  page
) {
  if (!domain) throw createError('Missing domain parameter', 400)
  if (!siteKey) throw createError('Missing siteKey parameter', 400)

  const timeout = Number(timeoutMs) || defaultTimeoutMs || 60000
  const startTime = Date.now()
  const escapedSiteKey = escapeInlineScriptString(siteKey)

  const workPromise = (async () => {
    await applyProxyAuthentication(page, proxy)

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
      <body>
        <div class="turnstile"></div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
        <script>
          window.onloadTurnstileCallback = function () {
            turnstile.render('.turnstile', {
              sitekey: '${escapedSiteKey}',
              callback: function (token) {
                var c = document.createElement('input');
                c.type = 'hidden';
                c.name = 'cf-response';
                c.value = token;
                document.body.appendChild(c);
              },
            });
          };
        </script>
      </body>
      </html>
    `

    await applyRequestInterception(page, async (request) => {
      if ([domain, domain + '/'].includes(request.url()) && request.resourceType() === 'document') {
        await request.respond({
          status: 200,
          contentType: 'text/html',
          body: htmlContent,
        })
      } else {
        await request.continue()
      }
    }, {
      logger,
      logMeta: {
        request_id: requestId,
        mode: 'turnstile',
      },
    })

    await page.goto(domain, { waitUntil: 'domcontentloaded', timeout })

    await page.waitForSelector('[name="cf-response"]', { timeout })

    const token = await page.evaluate(() => {
      try {
        return document.querySelector('[name="cf-response"]').value
      } catch {
        return null
      }
    })

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null)

    if (!token || token.length < 10) throw new Error('Failed to get token')
    return {
      token,
      user_agent: userAgent,
      elapsed_time: (Date.now() - startTime) / 1000,
    }
  })()

  return withTimeout(workPromise, timeout, 'Turnstile')
}

module.exports = turnstile
