/**
 * Host half of the subagent token graph.
 *
 * The Host is the only side that can see a session's log, so every number the
 * graph shows is computed here and shipped to the browser as one plain JSON
 * payload. The browser never folds events itself.
 *
 * ── What the Host reads ─────────────────────────────────────────────────────
 * 1. The conversation tree, from each session's `parentSession` header field
 *    (the durable lineage the session store writes) and, for the live case,
 *    from `subagents.listDescendants()`, which walks the durable direct-child
 *    catalogs. Both agree on the same parent/child edges: the catalog is
 *    written into the PARENT session as a `subagent/catalog` event, and the
 *    header records the same edge from the child's side.
 * 2. Per-session token facts, folded from the session's own log:
 *    - `assistant/message` (and `assistant/attempt`) carry a provider
 *      `TokenUsage` — input, output, cache read, cache write.
 *    - `turn/start` / `turn/end` give the run state and the duration.
 *    - `request/context` gives the model's advertised context window.
 *
 * A live session is read from memory; a cold (persisted-only) session is read
 * through `sessionPersistence` and cached, so the per-request cost of the
 * graph stays flat as the tree grows.
 *
 * ── Refresh mechanism ───────────────────────────────────────────────────────
 * The browser polls `/api/subagent-token-graph.graph` while the Conversation
 * tab is visible and stops as soon as the tab is hidden or the page is
 * backgrounded. The Host does no background work of its own: it answers one
 * request with one snapshot. That keeps the cost proportional to "a human is
 * looking at the tab" instead of "the plugin is installed".
 */
import {
  addReplacing,
  bucketsFrom,
  cacheHitRate,
  zeroBuckets,
} from './semantics.js'

/** Required Host services. `sessionPersistence` is optional at runtime. */
export const inject = ['sessions', 'subagents']

/**
 * The plugin's own configuration, read from the bundle patch's `config`.
 *
 * The plugin takes NO runtime dependency, so it cannot use a zod schema for
 * its Config; the values are read from the config object the Loader hands
 * to `apply` and validated here, which keeps a malformed value from
 * breaking the plugin.
 *
 * @typedef {object} GraphConfig
 * @property {number} [pollIntervalMs]
 */

/** The default poll interval, in milliseconds. */
const LINK_LIMIT = 400
const DEFAULT_POLL_INTERVAL_MS = 2000

/**
 * Resolve the effective poll interval from the row's config.
 * @param {GraphConfig | undefined} config
 * @returns {number}
 */
function pollIntervalOf(config) {
  const value = config?.pollIntervalMs
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS
  return Math.min(60_000, Math.max(500, Math.round(value)))
}

// ── The wire payload ─────────────────────────────────────────────────────────

/**
 * One session's row in the graph.
 *
 * The shape is documented here rather than declared with a schema: the plugin
 * takes no runtime dependency, and the payload is produced and consumed
 * inside this package.
 *
 * @typedef {object} GraphNode
 * @property {string} id                    the session id
 * @property {string} [parentId]            the durable parent session id
 * @property {string} [label]               the subagent label frozen at creation
 * @property {string} [mode]                one-shot | continuable | external
 * @property {number} [createdAt]           the session creation timestamp (ms)
 * @property {'root' | 'subagent'} kind     'root' for the main conversation
 * @property {number} depth                 the depth below the graph root
 * @property {'running' | 'done' | 'failed' | 'idle'} status
 * @property {import('./semantics.js').TokenBuckets} [last] the newest request's buckets
 * @property {import('./semantics.js').TokenBuckets} totals    the cumulative buckets
 * @property {number | null} hitRate        the newest request's cache-hit rate
 * @property {number | null} totalHitRate   the cumulative cache-hit rate
 * @property {number} [contextWindow]       the advertised context window
 * @property {number} [pressureTokens]      the newest request's prompt occupancy
 * @property {number | null} durationMs     the last completed turn's wall time
 * @property {number} [turn]                the turn of the newest sample
 * @property {number} [step]                the step of the newest sample
 * @property {number} eventCount            how many events this session logged
 * @property {number} [lastEventTime]       the newest event's timestamp (ms)
 */

/**
 * The whole graph, as one JSON payload.
 *
 * One cross-session hand-off: a delegation, an agent-to-agent message, or a
 * settled-subagent report. `direction` is from the recording session's point
 * of view.
 *
 * @typedef {object} GraphLink
 * @property {number} [at]                  when it happened (ms)
 * @property {'delegation' | 'message' | 'report'} kind
 * @property {'in' | 'out'} direction
 * @property {string} [peerId]              the other session's id
 * @property {string} [form]                relay | notice | ...
 * @property {string} [summary]             a short excerpt, already truncated
 * @property {string} sessionId             the session that recorded it
 * @property {string} [label]               that session's label
 */

/**
 * The whole graph, as one JSON payload.
 *
 * @typedef {object} GraphPayload
 * @property {string} rootId
 * @property {GraphNode[]} nodes
 * @property {GraphLink[]} links
 * @property {number} pollIntervalMs
 * @property {number} now
 */

// ── Host-side session reading ───────────────────────────────────────────────

/**
 * Fold one session's events into its token and lifecycle facts.
 *
 * The fold mirrors the official `dsh-token-meter` projections: the newest
 * usage sample of a (turn, step) REPLACES the previous one, so a retried
 * step is not counted twice, and the totals accumulate across steps.
 *
 * @param {readonly unknown[]} events
 * @returns {{totals: import('./semantics.js').TokenBuckets, last?: import('./semantics.js').TokenBuckets, turn?: number, step?: number, contextWindow?: number, pressureTokens?: number, status: 'running' | 'done' | 'failed' | 'idle', durationMs: number | null, firstEventTime?: number, eventCount: number, lastEventTime?: number, links: GraphLink[]}}
 */
export function foldSessionFacts(events) {
  const totals = zeroBuckets()
  let last
  let lastTurn
  let lastStep
  let previousForLast
  let contextWindow
  let pressureTokens
  let openTurn = false
  let lastTurnEndReason
  let turnStartedAt
  let lastTurnDuration = null
  let anyTurn = false
  let firstEventTime
  // Traffic count and the newest activity stamp drive the "quiet agent"
  // collapse in the UI: a card whose lane has been silent for a while can be
  // folded away so live work stays readable.
  let eventCount = 0
  let lastEventTime
  // Cross-session traffic that this session either sent or received. Only
  // events that carry a peer identity are collected; ordinary user turns are
  // not "collaboration".
  const links = []

  for (const raw of events) {
    const event = raw
    const type = event.type
    const data = event.data

    if (typeof event.time === 'number') {
      eventCount += 1
      lastEventTime = event.time
    }

    // An inbound message from another agent: the sender is recorded on the
    // spliced item's `source`, not on the event itself.
    if (type === 'agent/inbox/spliced') {
      const source = data?.inserted?.[0]?.source
      const kind = source?.kind
      if (kind === 'agent-message' || kind === 'subagent-settled') {
        links.push({
          at: event.time,
          kind: kind === 'subagent-settled' ? 'report' : 'message',
          direction: 'in',
          peerId: typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined,
          form: typeof source.form === 'string' ? source.form : undefined,
          summary: typeof source.summary === 'string'
            ? source.summary.slice(0, 120)
            : undefined,
        })
      }
    }

    // An outbound delegation recorded in the parent's own catalog.
    if (type === 'subagent/catalog') {
      links.push({
        at: typeof data?.childCreatedAt === 'number' ? data.childCreatedAt : event.time,
        kind: 'delegation',
        direction: 'out',
        peerId: typeof data?.childId === 'string' ? data.childId : undefined,
        summary: typeof data?.label === 'string' ? data.label.slice(0, 120) : undefined,
      })
    }

    // The first event's timestamp is the durable start time. The in-memory
    // session header does not always expose `createdAt`, but every persisted
    // entry carries `time`, and the first one lands milliseconds after the
    // session was created.
    if (firstEventTime === undefined && typeof event.time === 'number') firstEventTime = event.time

    if (type === 'turn/start') {
      openTurn = true
      anyTurn = true
      turnStartedAt = event.time
      continue
    }
    if (type === 'turn/end') {
      openTurn = false
      const reason = data?.reason
      lastTurnEndReason = typeof reason === 'string'
        ? reason
        : (reason && typeof reason.kind === 'string' ? reason.kind : undefined)
      // A turn that ended with an error carries the failure in `error`.
      if (data?.error !== undefined && lastTurnEndReason === undefined) lastTurnEndReason = 'error'
      if (turnStartedAt !== undefined && event.time !== undefined) {
        lastTurnDuration = event.time - turnStartedAt
      }
      turnStartedAt = undefined
      continue
    }
    if (type === 'request/context') {
      const window = data?.contextWindow
      if (typeof window === 'number' && window > 0) contextWindow = window
      continue
    }

    const usage = usageOf(event)
    if (usage === undefined) continue

    const buckets = bucketsFrom(usage)
    const turn = typeof data?.turn === 'number' ? data.turn : undefined
    const step = typeof data?.step === 'number' ? data.step : undefined
    const isSameStep = turn !== undefined && step !== undefined
      && lastTurn === turn && lastStep === step
    // The sample that replaces the newest one is the one we subtract.
    const replaced = isSameStep ? previousForLast : undefined

    const nextTotals = addReplacing(totals, replaced, buckets)
    totals.uncachedInputTokens = nextTotals.uncachedInputTokens
    totals.outputTokens = nextTotals.outputTokens
    totals.cacheReadTokens = nextTotals.cacheReadTokens
    totals.cacheWriteTokens = nextTotals.cacheWriteTokens

    previousForLast = isSameStep ? buckets : undefined
    last = buckets
    lastTurn = turn
    lastStep = step
    pressureTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }

  const status = openTurn
    ? 'running'
    : lastTurnEndReason === undefined
      ? (anyTurn ? 'done' : 'idle')
      : (lastTurnEndReason === 'error' || lastTurnEndReason === 'blocked') ? 'failed' : 'done'

  return {
    totals,
    last,
    turn: lastTurn,
    step: lastStep,
    contextWindow,
    pressureTokens,
    status,
    durationMs: lastTurnDuration,
    firstEventTime,
    eventCount,
    lastEventTime,
    links,
  }
}

/**
 * The provider usage of one event, when it reports any.
 *
 * A settled assistant message carries `usage` directly. A retry attempt
 * carries it as the trailing `usage` chunk of its stream.
 *
 * @param {{type?: string, data?: any}} event
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number} | undefined}
 */
function usageOf(event) {
  const data = event.data
  if (data === undefined || data === null) return undefined
  if (event.type === 'assistant/message') {
    const usage = data.usage
    return usage?.inputTokens !== undefined && usage?.outputTokens !== undefined ? usage : undefined
  }
  if (event.type === 'assistant/attempt') {
    const stream = data.stream
    if (!Array.isArray(stream)) return undefined
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const chunk = stream[index]?.chunk
      if (chunk?.type === 'usage') {
        const usage = chunk.usage
        if (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined) return usage
      }
    }
    return undefined
  }
  return undefined
}

/**
 * Fold a session's facts, tolerating a session whose log cannot be read.
 * An unreadable descendant is isolated: it still appears in the graph (so
 * the tree shape stays honest) with zeroed totals and an idle state.
 *
 * @param {readonly unknown[] | undefined} events
 */
function factsOf(events) {
  if (events === undefined) {
    return { totals: zeroBuckets(), status: 'idle', durationMs: null }
  }
  try {
    return foldSessionFacts(events)
  } catch {
    return { totals: zeroBuckets(), status: 'idle', durationMs: null }
  }
}

// ── The graph builder ────────────────────────────────────────────────────────

/**
 * Build the whole graph for one root session.
 *
 * The tree comes from two sources that agree on the same edges:
 * - `subagents.listDescendants(root)` walks the durable direct-child catalogs
 *   and returns every descendant with its parent id and depth. It needs no
 *   Agent to be loaded.
 * - the live session headers carry `parentSession`, which is the same edge
 *   seen from the child's side and covers a child whose parent catalog has
 *   not been read yet.
 *
 * The union is used, so a child is in the graph even when only one of the two
 * sources knows about it.
 *
 * @param {any} ctx - the Host context
 * @param {string} rootId
 * @param {AbortSignal | undefined} signal
 * @param {GraphConfig | undefined} config
 */
async function buildGraph(ctx, rootId, signal, config) {
  const sessions = ctx.get('sessions')
  const subagents = ctx.get('subagents')

  const liveSessions = sessions?.list() ?? []
  const liveById = new Map(liveSessions.map(session => [session.id, session]))

  // ── edges ────────────────────────────────────────────────────────────────
  const parentOf = new Map()
  const labelOf = new Map()
  const modeOf = new Map()
  const createdAtOf = new Map()

  for (const session of liveSessions) {
    const parent = session.header?.parentSession
    if (typeof parent === 'string' && parent !== '' && parent !== session.id) {
      parentOf.set(session.id, parent)
    }
    if (typeof session.header?.createdAt === 'number') createdAtOf.set(session.id, session.header.createdAt)
  }

  // The durable catalogs are the authoritative edge source.
  if (subagents !== undefined) {
    try {
      const descendants = await subagents.listDescendants(rootId, signal)
      for (const entry of descendants) {
        if (entry.kind !== 'child') continue
        parentOf.set(entry.id, entry.parentId)
        if (typeof entry.label === 'string') labelOf.set(entry.id, entry.label)
        if (typeof entry.mode === 'string') modeOf.set(entry.id, entry.mode)
        if (typeof entry.createdAt === 'number') createdAtOf.set(entry.id, entry.createdAt)
      }
    } catch {
      // A catalog read failure must not blank the graph: the live headers
      // still carry the lineage, so the tree survives on those edges alone.
    }
  }

  // ── reachable set ────────────────────────────────────────────────────────
  const childrenOf = new Map()
  for (const [child, parent] of parentOf) {
    const bucket = childrenOf.get(parent) ?? []
    bucket.push(child)
    childrenOf.set(parent, bucket)
  }

  const reachable = new Set([rootId])
  const order = [rootId]
  const queue = [rootId]
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenOf.get(queue[index]) ?? []) {
      if (reachable.has(child)) continue
      reachable.add(child)
      order.push(child)
      queue.push(child)
    }
  }

  // ── per-session facts ────────────────────────────────────────────────────
  const persistence = ctx.get('sessionPersistence')
  const coldCache = new Map()

  const readEvents = async (id) => {
    const live = liveById.get(id)
    if (live !== undefined) {
      try {
        return live.snapshotEvents()
      } catch {
        return undefined
      }
    }
    if (coldCache.has(id)) return coldCache.get(id)
    let events
    if (persistence !== undefined) {
      try {
        const handle = await persistence.open(id, 'read', signal === undefined ? undefined : { signal })
        try {
          const collected = []
          for (let offset = 0; ;) {
            const page = await handle.read(offset, 500, signal === undefined ? undefined : { signal })
            if (page.events.length === 0) break
            for (const event of page.events) collected.push(event)
            offset += page.events.length
          }
          events = collected
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        events = undefined
      }
    }
    coldCache.set(id, events)
    return events
  }

  const nodes = []
  const recentLinks = []
  for (const id of order) {
    const facts = factsOf(await readEvents(id))
    const isRoot = id === rootId
    const parentId = isRoot ? undefined : parentOf.get(id)
    const depth = parentId === undefined ? 0 : depthOf(parentId, parentOf)
    nodes.push({
      id,
      parentId,
      label: labelOf.get(id),
      mode: modeOf.get(id),
      // Header/catalog timestamps first; the session log's first entry is the
      // fallback that makes the round filter work on live sessions too.
      createdAt: createdAtOf.get(id) ?? facts.firstEventTime,
      kind: isRoot ? 'root' : 'subagent',
      depth,
      status: facts.status,
      last: facts.last,
      totals: facts.totals,
      hitRate: facts.last === undefined ? null : cacheHitRate(facts.last),
      totalHitRate: cacheHitRate(facts.totals),
      contextWindow: facts.contextWindow,
      pressureTokens: facts.pressureTokens,
      durationMs: facts.durationMs,
      turn: facts.turn,
      step: facts.step,
      eventCount: facts.eventCount,
      lastEventTime: facts.lastEventTime,
    })
    // Attach this session's identity to each of its links so the panel can
    // name both ends even when the peer is not in the tree.
    for (const link of facts.links) {
      recentLinks.push({ ...link, sessionId: id, label: labelOf.get(id) })
    }
  }

  return {
    rootId,
    nodes,
    // Cross-session traffic flattened into one timeline: who handed what to
    // whom, and when. Sorted oldest-first so the panel reads top-down, and
    // capped so a 50-agent tree cannot bloat the response.
    links: collectLinks(recentLinks),
    pollIntervalMs: pollIntervalOf(config),
    now: Date.now(),
  }
}

/**
 * Flatten per-session links into a single ordered timeline, dropping events
 * whose peer is not part of this conversation tree (an unrelated session that
 * happens to share the store).
 *
 * @param {Array<{at: number, kind: string, direction: string, peerId?: string,
 *   form?: string, summary?: string, sessionId: string, label?: string}>} all
 * @returns {Array<object>} newest last, capped at LINK_LIMIT
 */
function collectLinks(all) {
  const known = all.filter((link) => link.peerId !== undefined)
  known.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return known.length > LINK_LIMIT ? known.slice(known.length - LINK_LIMIT) : known
}

/**
 * How deep a node sits below the root, following the parent chain.
 * @param {string} id
 * @param {ReadonlyMap<string, string>} parentOf
 * @returns {number}
 */
function depthOf(id, parentOf) {
  let depth = 0
  let current = id
  const seen = new Set()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const parent = parentOf.get(current)
    if (parent === undefined) break
    depth += 1
    current = parent
  }
  return depth
}

// ── The Host plugin ──────────────────────────────────────────────────────────

/** The RPC method this plugin serves, below the `/api` channel. */
const GRAPH_METHOD = 'subagent-token-graph.graph'

/** The response headers one RPC server-response envelope carries. */
const ENVELOPE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Build an RPC success branch. */
function ok(value) {
  return { ok: true, value }
}

/** Build an RPC error branch. */
function fail(message) {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** Serialize one RPC result as a server-response envelope. */
function envelopeResponse(rpcId, result) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: ENVELOPE_HEADERS,
  })
}

/**
 * Register the graph endpoint.
 *
 * The route is a `connection.fetch.register` under `/api`, the same carrier
 * the harness's own session API uses. The browser reaches it through
 * `connection.rpc.call('/api', 'subagent-token-graph.graph', payload)`, which
 * wraps the request in the connection's `client-request` envelope; this
 * handler unwraps that envelope and answers with the matching
 * `server-response` envelope.
 *
 * @param {any} ctx - the Host context
 * @param {GraphConfig} [config] - the row's config from the bundle patch
 */
export function apply(ctx, config) {
  ctx.inject(['connection'], (rpcCtx) => {
    const connection = rpcCtx.connection
    rpcCtx.effect(() => connection.fetch.register({
      path: `/api/${GRAPH_METHOD}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch {
          return envelopeResponse('invalid-request', fail('body is not JSON'))
        }
        const rpcId = typeof envelope?.rpcId === 'string' && envelope.rpcId !== ''
          ? envelope.rpcId
          : 'invalid-request'
        if (envelope?.type !== 'client-request' || rpcId === 'invalid-request') {
          return envelopeResponse(rpcId, fail('invalid client-request message'))
        }
        if (envelope.method !== GRAPH_METHOD) {
          return envelopeResponse(rpcId, fail(`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(GRAPH_METHOD)}`))
        }
        const sessionId = envelope.payload?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          return envelopeResponse(rpcId, fail('payload.sessionId is required'))
        }
        try {
          const payload = await buildGraph(rpcCtx, sessionId, request.signal, config)
          return envelopeResponse(rpcId, ok(payload))
        } catch (error) {
          return envelopeResponse(rpcId, fail(error instanceof Error ? error.message : String(error)))
        }
      },
    }), 'subagent-token-graph: graph route')
  })
}
