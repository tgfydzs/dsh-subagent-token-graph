/**
 * Shared, dependency-free semantics for the subagent token graph.
 *
 * This module is imported by BOTH the Host half (which folds session logs into
 * per-session token facts) and the browser half (which renders them). It must
 * therefore stay free of Node.js builtins and of DOM types: the client
 * bundle rejects Node builtins, and importing a Host-only module into the
 * browser would drag server code into the page.
 *
 * ── Cache hit rate ──────────────────────────────────────────────────────────
 * The graph reports one cache-hit ratio per session, computed as
 *
 *     cacheHitRate = cacheReadTokens
 *                    ───────────────────────────────────────────────
 *                    cacheReadTokens + uncachedInputTokens + cacheWriteTokens
 *
 * i.e. "cache read ÷ (uncached input + cache read + cache write)" — the
 * share of PROMPT-SIDE tokens that were served from the provider's prompt
 * cache. The denominator is the same "billed input" denominator the official
 * `dsh-token-meter` breakdown uses, so this plugin and the host's own stats
 * pills always agree on the same number. Output tokens are deliberately NOT
 * in the denominator: they are billed separately and never hit the cache.
 *
 * A session that reported no prompt-side tokens at all has no meaningful
 * rate, so `cacheHitRate` is `null` (the UI renders "—" rather than 0%).
 */

/**
 * The provider-reported token buckets of one request, in the four disjoint
 * buckets the harness bills:
 * - `uncachedInputTokens` — prompt tokens the provider did NOT serve from cache
 * - `outputTokens`        — generated completion tokens
 * - `cacheReadTokens`     — prompt tokens served FROM the cache (a hit)
 * - `cacheWriteTokens`    — prompt tokens WRITTEN into the cache
 *
 * @typedef {object} TokenBuckets
 * @property {number} uncachedInputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 */

/** The zero bucket set. @returns {TokenBuckets} */
export function zeroBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/**
 * Whether two bucket sets carry the same numbers.
 * @param {TokenBuckets} a
 * @param {TokenBuckets} b
 * @returns {boolean}
 */
export function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
}

/**
 * Split one provider usage record into the four disjoint billing buckets.
 * `inputTokens` is the provider's UNcached prompt count, so it maps straight
 * onto `uncachedInputTokens`.
 *
 * @param {{inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
 * @returns {TokenBuckets}
 */
export function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * Add one sample to the running totals, replacing the previous sample of the
 * SAME (turn, step) when it exists. A retried step reports its usage twice;
 * counting both would double the spend, so the newer sample replaces the
 * older one instead of adding to it.
 *
 * @param {TokenBuckets} totals
 * @param {TokenBuckets | undefined} previous
 * @param {TokenBuckets} next
 * @returns {TokenBuckets}
 */
export function addReplacing(totals, previous, next) {
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  }
}

/**
 * The cache-hit rate of one bucket set, as a fraction in [0, 1].
 *
 * Formula (see the module header): cache read ÷ (uncached input + cache read
 * + cache write). Returns `null` when the session reported no prompt-side
 * tokens at all — there is no rate to report then.
 *
 * @param {TokenBuckets} buckets
 * @returns {number | null}
 */
export function cacheHitRate(buckets) {
  const hit = buckets.cacheReadTokens
  const miss = buckets.uncachedInputTokens + buckets.cacheWriteTokens
  const denominator = hit + miss
  if (denominator === 0) return null
  return hit / denominator
}

/**
 * The prompt-side token count of one bucket set (the rate's denominator).
 * @param {TokenBuckets} buckets
 * @returns {number}
 */
export function billedInputTokens(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/**
 * Every token one bucket set accounts for.
 * @param {TokenBuckets} buckets
 * @returns {number}
 */
export function totalTokens(buckets) {
  return billedInputTokens(buckets) + buckets.outputTokens
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Compact a token count the way the host's own stats pills do: thousands
 * separators below 10k, a `k` suffix above. Keeps a node card's numbers
 * narrow enough to read at a glance.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return '—'
  const n = Math.max(0, Math.round(value))
  if (n < 10_000) return n.toLocaleString('en-US')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * Render a cache-hit rate as a percentage string with one decimal.
 * `null` (no prompt-side tokens) renders as an em dash, not 0%.
 *
 * @param {number | null} rate
 * @returns {string}
 */
export function formatHitRate(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * Render a duration in milliseconds as a compact human string.
 * Under a second the value is shown in milliseconds, so a fast step still
 * reports a non-zero duration instead of "0s".
 *
 * @param {number | null} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes - hours * 60}m`
}

// ── Graph layout ─────────────────────────────────────────────────────────────

/**
 * Lay the conversation tree out as a left-to-right tree.
 *
 * The root sits in column 0; every child sits one column right of its
 * parent, and siblings stack down their column. This is the classic
 * "node graph" reading of a delegation tree: the flow of control runs left
 * to right, and depth is visible without reading any label.
 *
 * @param {ReadonlyMap<string, readonly string[]>} childrenOf - the direct children of each node id
 * @param {string} rootId - the root of the tree
 * @param {number} [nodeWidth]
 * @param {number} [nodeHeight]
 * @param {number} [gapX]
 * @param {number} [gapY]
 * @returns {Map<string, {x: number, y: number}>} a position for every reachable node id
 */
export function layoutTree(childrenOf, rootId, nodeWidth = 220, nodeHeight = 132, gapX = 96, gapY = 28) {
  const positions = new Map()
  // Depth-first walk that assigns each leaf a vertical slot, then centres its
  // parent on its children — the standard tidy-tree layout.
  let nextLeafSlot = 0

  const place = (id, depth) => {
    const children = childrenOf.get(id) ?? []
    if (children.length === 0) {
      const top = nextLeafSlot * (nodeHeight + gapY)
      nextLeafSlot += 1
      positions.set(id, { x: depth * (nodeWidth + gapX), y: top })
      return { top, bottom: top + nodeHeight }
    }
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const child of children) {
      const range = place(child, depth + 1)
      top = Math.min(top, range.top)
      bottom = Math.max(bottom, range.bottom)
    }
    const y = (top + bottom) / 2 - nodeHeight / 2
    positions.set(id, { x: depth * (nodeWidth + gapX), y })
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + nodeHeight) }
  }

  place(rootId, 0)
  return positions
}
