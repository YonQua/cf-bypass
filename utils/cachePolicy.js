const CACHEABLE_IUAM_SOURCES = new Set([
  'strict_cookie_match',
  'interaction_strict_cookie_match',
])

function isCacheableIuamResult(internalMeta) {
  return CACHEABLE_IUAM_SOURCES.has(internalMeta?.clearanceSource)
}

module.exports = { isCacheableIuamResult }
