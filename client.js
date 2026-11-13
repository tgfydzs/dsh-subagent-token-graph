/**
 * Browser half of the subagent token graph.
 *
 * The browser owns the rendering only: it asks the Host for one snapshot of
 * the conversation tree and renders it as a fleet-style swimlane board —
 * in the spirit of dsh-context's fleet/pulse page: a compact stat header on
 * top, then one swimlane per delegation depth, with node cards flowing
 * left-to-right in delegation order. Everything is native DOM laid out with
 * flex/grid: no transform scaling, no canvas panning — text is always
 * rendered at its natural size and never blurs, and the board adapts to the
 * tab width on its own.
 *
 * ── Refresh mechanism ───────────────────────────────────────────────────────
 * The board polls the Host while it is mounted and the page is visible, and
 * stops the moment the tab is hidden or the page is backgrounded — the graph
 * costs nothing when nobody is looking at it. The poll interval comes from
 * the Host's payload, so it is configurable in one place.
 *
 * ── Transport ───────────────────────────────────────────────────────────────
 * The Host serves one RPC method below the `/api` channel
 * (`subagent-token-graph.graph`); the browser calls it through the client's
 * connection RPC, the same carrier the harness's own session API uses.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-subagent-token-graph',
  factory(require) {
    const React = require('react')

    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /** The locale namespace this plugin's dictionaries live under. */
    const NS = 'subagent-token-graph'

    /** The RPC method the Host serves below the `/api` channel. */
    const GRAPH_METHOD = 'subagent-token-graph.graph'

    /** The run states the status filter offers, in chip order. */
    const FILTER_STATES = ['running', 'done', 'failed', 'idle']
    // A gap wider than this splits delegation into separate rounds. Subagents
    // spawned in one fan-out land milliseconds apart; a parent that thinks for
    // a while before delegating again leaves a much wider gap. Two minutes is
    // deliberately generous so one round is never split in half.
    const SEGMENT_GAP_MS = 2 * 60 * 1000
// An agent whose lane has been silent for this long is "quiet": still worth
// keeping in the tree, but collapsible so live work stays readable.
const QUIET_AFTER_MS = 5 * 60 * 1000

    // ── Shared semantics ─────────────────────────────────────────────────────
    //
    // These are the same formulas the Host half applies (see ./semantics.js).
    // They are repeated here rather than imported because the browser module
    // table resolves package ids and chunk ids only — it cannot resolve a
    // relative path inside this package — so the browser half of a plugin
    // must be self-contained. The two copies must stay in step; the formula
    // is documented once, in ./semantics.js, and mirrored here.

    /**
     * The cache-hit rate of one bucket set, as a fraction in [0, 1].
     *
     * Formula: cache read ÷ (uncached input + cache read + cache write) — the
     * share of prompt-side tokens served from the provider's prompt cache.
     * `null` when the session reported no prompt-side tokens at all.
     */
    function cacheHitRate(buckets) {
      const hit = buckets.cacheReadTokens
      const miss = buckets.uncachedInputTokens + buckets.cacheWriteTokens
      const denominator = hit + miss
      if (denominator === 0) return null
      return hit / denominator
    }

    /** The zero bucket set. */
    function zeroBuckets() {
      return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }

    /** Compact a token count the way the host's stats pills do. */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      const n = Math.max(0, Math.round(value))
      if (n < 10_000) return n.toLocaleString('en-US')
      if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
      return `${(n / 1_000_000).toFixed(1)}M`
    }

    /** Render a cache-hit rate as a percentage string, or an em dash. */
    function formatHitRate(rate) {
      if (rate === null || rate === undefined) return '—'
      return `${(rate * 100).toFixed(1)}%`
    }

    /** Render a duration in milliseconds as a compact human string. */
    function formatDuration(ms) {
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

    /** Render an epoch timestamp as a local HH:MM clock. */
    function formatClock(ms) {
      if (!Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    /** A session id that is not in the tree, shortened for display. */
    function shortenId(id) {
      if (typeof id !== 'string') return ''
      return id.length <= 12 ? id : `${id.slice(0, 8)}…`
    }

    /** A round's time span, collapsed to one clock when both ends match. */
    function formatSpan(from, to) {
      const start = formatClock(from)
      const end = formatClock(to)
      return start === end ? start : `${start}–${end}`
    }

    /**
     * Cluster sessions by delegation start time.
     *
     * Delegation is bursty: one turn fans out several subagents within
     * seconds, then the parent thinks for minutes before the next burst. So
     * sorting by `createdAt` and cutting wherever the gap exceeds `gapMs`
     * recovers the actual delegation rounds without needing any marker in the
     * data. Nodes with no timestamp are counted separately rather than being
     * silently dropped or lumped into the first segment.
     */
    function groupByStartTime(nodes, gapMs) {
      const timed = []
      let undated = 0
      for (const node of nodes) {
        if (typeof node.createdAt === 'number' && Number.isFinite(node.createdAt)) timed.push(node)
        else undated += 1
      }
      timed.sort((a, b) => a.createdAt - b.createdAt)
      const groups = []
      let current = null
      for (const node of timed) {
        if (current === null || node.createdAt - current.lastAt > gapMs) {
          current = { firstAt: node.createdAt, lastAt: node.createdAt, ids: [] }
          groups.push(current)
        }
        current.ids.push(node.id)
        current.lastAt = node.createdAt
      }
      return { groups, undated }
    }

    // ── Layout geometry ─────────────────────────────────────────────────────
    //
    // Cards are laid out in real pixels and drawn with an SVG connector layer
    // of the same size, so nothing is ever scaled: text renders at its natural
    // size and stays crisp at any window size. These constants are the single
    // source of truth — the node card CSS uses the same width and height.

    /**
     * Card sizing is *derived from the space the tab actually gives us*, not
     * fixed in pixels. A tab can be 700px wide or 1600px wide, 400px tall or
     * 900px tall; a board built against four constants either wastes most of a
     * wide tab or forces a horizontal scrollbar on a narrow one. So the layout
     * takes an `avail` box and solves for the card size and gaps that fill it.
     */
    const MIN_NODE_WIDTH = 132
    const MAX_NODE_WIDTH = 268
    /* The floor is what the card's own content occupies — header, the 2x2
       metric grid, the context bar and the totals footer — measured in the
       browser at 113px. A smaller floor lets the solver shrink a card below
       its content, and overflow:hidden then silently eats the footer, so the
       floor is a content measurement rather than a taste value. */
    const MIN_NODE_HEIGHT = 114
    const MAX_NODE_HEIGHT = 132
    /** Horizontal gap between sibling subtrees, as a fraction of card width. */
    const GAP_X_RATIO = 0.13
    /** Vertical gap between delegation rows, as a fraction of card height. */
    const GAP_Y_RATIO = 0.45

    /**
     * Lay the conversation tree out as a downward tidy tree: every delegation
     * depth is one row, deeper rows run downwards, and a parent sits centred
     * over the block of its children. The depth of a node is recomputed here
     * by BFS from the root, since the payload's `node.depth` is informational
     * only and has been observed inconsistent (direct subagents arrive with
     * depth 0) — trusting it once stacked parents and children in the same row
     * and tangled every connector.
     *
     * The layout is a classic two-pass tidy tree:
     *   1. measure — a node's slot is the widest of (its own card, the summed
     *      slots of its children plus the gaps between them);
     *   2. place — children are packed left to right inside the parent's slot
     *      and the parent is centred over the span of its first and last child.
     *
     * `avail` is the pixel box the tab gives the board ({ width, height }, and
     * either may be 0 when not measurable yet). It drives the card size: the
     * widest row is fitted to `avail.width` first, then the card height is
     * chosen so a tree that would fit vertically shrinks its rows to fit
     * rather than forcing a scrollbar. When `avail` is unknown the maximum
     * card size is used, which is the old, safe appearance.
     *
     * Returns `{ positions, edges, width, height, depthCount, nodeWidth,
     * nodeHeight }`, where `positions` maps a node id to its card's top-left
     * corner, `edges` lists the parent id of every non-root node (the renderer
     * draws the connectors) and `width`/`height` size the scrollable board.
     *
     * `childrenOf` maps a parent id to its VISIBLE child ids — the caller has
     * already dropped filtered-out nodes.
     */
    function treeLayout(childrenOf, rootId, avail) {
      // Real depth from the root, the single source of truth for the rows.
      const depthOf = new Map([[rootId, 0]])
      const order = [rootId]
      const queue = [rootId]
      while (queue.length > 0) {
        const id = queue.shift()
        const depth = depthOf.get(id) ?? 0
        for (const child of childrenOf.get(id) ?? []) {
          if (!depthOf.has(child)) {
            depthOf.set(child, depth + 1)
            order.push(child)
            queue.push(child)
          }
        }
      }

      const kidsOf = (id) => (childrenOf.get(id) ?? []).filter((child) => depthOf.has(child))

      // ── solve the card size against the available box ────────────────────
      // The tree's width is not simply the widest row's card count: a subtree
      // occupies the sum of its children's slots, so one deep branch can be far
      // wider than the leaf count suggests. Measure the real tree with a unit
      // card first, then scale the card so that measured width lands on the
      // available width. Scaling is exact because the tidy layout is linear in
      // the card size for a fixed topology.
      // `avail` is already the scroller's CONTENT box (the measuring effect
      // subtracts its padding and the scrollbar), so no further inset here.
      const availWidth = avail !== undefined && avail.width > 0 ? avail.width : 0
      const availHeight = avail !== undefined && avail.height > 0 ? avail.height : 0
      let maxRows = 0
      for (const id of order) {
        const depth = depthOf.get(id) ?? 0
        if (depth > maxRows) maxRows = depth
      }

      // Pass 0 — width of the tree at unit card size, with unit gaps.
      const unitWidth = (id) => {
        const kids = kidsOf(id)
        if (kids.length === 0) return 1
        let sum = 0
        for (const kid of kids) sum += unitWidth(kid)
        return Math.max(1, sum + GAP_X_RATIO * (kids.length - 1))
      }
      const unitRoot = unitWidth(rootId)
      let nodeWidth = MAX_NODE_WIDTH
      if (availWidth > 0) {
        // unitRoot is measured in "card widths" (gaps included as a fraction),
        // so the card that exactly fills the tab is availWidth / unitRoot.
        const fitted = Math.floor(availWidth / Math.max(1, unitRoot))
        nodeWidth = Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, fitted))
      }
      let gapX = Math.round(nodeWidth * GAP_X_RATIO)

      // A wide tab on a small tree: the cards are capped at a readable width, so
      // the leftover width used to pile up as dead space on both sides of a
      // centred block. Spend it on the gaps instead: the tree then spreads
      // across the tab, every parent still sits centred over its children, and
      // the connections get easier to follow rather than the layout getting
      // emptier. Bounded so a three-node tree on a 4K panel does not turn into
      // three cards at opposite corners.
      if (availWidth > 0 && nodeWidth >= MAX_NODE_WIDTH) {
        const naturalWidth = nodeWidth * unitRoot
        const slack = availWidth - naturalWidth
        if (slack > 0 && unitRoot > 1) {
          const extra = Math.floor(slack / (unitRoot - 1))
          // Cap at one card width: enough to fill the tab, not enough to turn
          // siblings into unrelated islands. Beyond this the tree reads better
          // centred with margins than stretched across the whole panel.
          gapX = Math.min(gapX + extra, nodeWidth)
        }
      }

      // Card height: portrait-ish cards read better. The rows decide whether
      // the board scrolls, so when the natural height overflows the tab, scale
      // the whole column stack (card + gap) by the same factor instead of
      // shaving them independently — uniform scaling keeps the vertical rhythm
      // proportional and cannot reintroduce height it just removed.
      const rowCountTotal = maxRows + 1
      let nodeHeight = Math.round(nodeWidth * 0.56)
      nodeHeight = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, nodeHeight))
      let gapY = Math.round(nodeHeight * GAP_Y_RATIO)
      if (availHeight > 0) {
        const naturalHeight = rowCountTotal * nodeHeight + (rowCountTotal - 1) * gapY
        if (naturalHeight > availHeight) {
          const scale = availHeight / naturalHeight
          nodeHeight = Math.max(MIN_NODE_HEIGHT, Math.floor(nodeHeight * scale))
          gapY = Math.max(16, Math.floor(gapY * scale))
          // If the card hit its readable floor, the stack may still be taller
          // than the tab; that is correct — a very short tab should scroll
          // rather than show cards too small to read.
        }
      }

      // Pass 1 — the width of every node's slot, leaves upwards.
      const slotOf = new Map()
      const measure = (id) => {
        const kids = kidsOf(id)
        if (kids.length === 0) {
          slotOf.set(id, nodeWidth)
          return nodeWidth
        }
        let sum = 0
        for (const kid of kids) sum += measure(kid)
        sum += gapX * (kids.length - 1)
        const slot = Math.max(nodeWidth, sum)
        slotOf.set(id, slot)
        return slot
      }
      measure(rootId)

      // Pass 2 — pack children inside the parent's slot, then centre the
      // parent over the span of its outermost children.
      const xOf = new Map()
      const place = (id, left) => {
        const kids = kidsOf(id)
        const slot = slotOf.get(id) ?? nodeWidth
        if (kids.length === 0) {
          xOf.set(id, left + (slot - nodeWidth) / 2)
          return
        }
        let kidsWidth = 0
        for (const kid of kids) kidsWidth += slotOf.get(kid) ?? nodeWidth
        kidsWidth += gapX * (kids.length - 1)
        let cursor = left + (slot - kidsWidth) / 2
        for (const kid of kids) {
          place(kid, cursor)
          cursor += (slotOf.get(kid) ?? nodeWidth) + gapX
        }
        const first = (xOf.get(kids[0]) ?? left) + nodeWidth / 2
        const last = (xOf.get(kids[kids.length - 1]) ?? left) + nodeWidth / 2
        xOf.set(id, (first + last) / 2 - nodeWidth / 2)
      }
      place(rootId, 0)

      const positions = new Map()
      const edges = []
      let maxDepth = 0
      for (const id of order) {
        const depth = depthOf.get(id) ?? 0
        if (depth > maxDepth) maxDepth = depth
        const x = xOf.get(id) ?? 0
        positions.set(id, { x, y: depth * (nodeHeight + gapY), depth })
      }
      for (const id of order) {
        if (id === rootId) continue
        edges.push({ from: null, to: id })
      }
      // Resolve each edge's parent from the children map (the tree is a tree:
      // exactly one parent per non-root node).
      const parentOf = new Map()
      for (const [parentId, kids] of childrenOf) {
        for (const kid of kids) if (depthOf.has(kid)) parentOf.set(kid, parentId)
      }
      for (const edge of edges) edge.from = parentOf.get(edge.to) ?? null

      // The board never reports less than the space it was given: a small tree
      // in a large tab should sit in a canvas that fills the tab.
      //
      // Horizontally the tree is centred, because a wide tab with a narrow tree
      // looks broken when the trunk hugs the left edge.
      //
      // Vertically it hangs from the TOP, not the middle. Centring the depth
      // axis put a third of a screen of dead space above the root node, which
      // reads as a layout that failed to start; a tree grows downward and its
      // first row belongs at the top. (The extra height when the tree is short
      // simply stays below, where the eye expects the tree to continue.)
      const naturalWidth = slotOf.get(rootId) ?? nodeWidth
      const naturalHeight = (maxDepth + 1) * nodeHeight + maxDepth * gapY
      const width = Math.max(naturalWidth, availWidth > 0 ? availWidth : 0)
      const height = Math.max(naturalHeight, availHeight > 0 ? availHeight : 0)
      return {
        positions,
        edges: edges.filter((edge) => edge.from !== null),
        width,
        height,
        naturalWidth,
        naturalHeight,
        offsetX: Math.max(0, Math.round((width - naturalWidth) / 2)),
        offsetY: 0,
        depthCount: maxDepth + 1,
        nodeWidth,
        nodeHeight,
        gapX,
        gapY,
      }
    }

    // ── Locale ───────────────────────────────────────────────────────────────

    /** English dictionary. */
    const en = {
      'tab.label': 'Token graph',
      'canvas.title': 'Token usage graph',
      'canvas.subtitle': 'The main conversation and every subagent it derived, with the newest request of each.',
      'canvas.empty': 'No subagents yet. This conversation has not delegated anything.',
      'canvas.loading': 'Loading the token graph…',
      'canvas.error': 'The token graph could not be loaded.',
      'canvas.retry': 'Retry',
      'canvas.legend.root': 'Main conversation',
      'canvas.card': 'Node graph',
      'canvas.cardBadge': '{count} of {total}',
      'canvas.legend.subagent': 'Subagent',
      'stats.running': 'Running',
      'stats.done': 'Completed',
      'stats.failed': 'Failed',
      'stats.tokens': 'Total tokens',
      'lane.root': 'Main conversation',
      'lane.delegated': 'Delegation {depth}',
      'filter.all': 'All',
      'filter.running': 'Running',
      'filter.done': 'Completed',
      'filter.failed': 'Failed',
      'filter.idle': 'Idle',
      'filter.summary': 'Filtered: {scope} (+ ancestor chain) · {visible}/{total} sessions',
      'filter.search': 'Search agents…',
      'filter.queryScope': 'search \u201c{query}\u201d',
      'segment.label': 'Delegation round',
      'segment.all': 'All rounds',
      'segment.scope': 'round {span}',
      'segment.tip': '{count} sessions started between {from} and {to}',
      'segment.undated': '{count} undated',
      'segment.undatedTip': 'These sessions carry no start time, so they are never hidden by a round filter.',
      'filter.empty': 'No session matches this filter.',
      'node.input': 'In',
      'node.output': 'Out',
      'node.hit': 'Cache hit',
      'node.duration': 'Duration',
      'node.totals': 'Session total',
      'node.depth': 'Depth {depth}',
      'node.open': 'Open this agent\u2019s own conversation',
      'node.events': '{count} ev',
      'node.eventsTip': 'Events this agent logged ({count})',
      'quiet.hidden': 'Hide {count} quiet',
      'quiet.shown': '{count} quiet hidden',
      'quiet.tip': '{count} agents have been idle for over 5 minutes',
      'filter.quietScope': '{count} quiet hidden',
      'flow.title': 'Collaboration',
      'flow.total': '{count} hand-offs',
      'flow.empty': 'No cross-agent traffic recorded yet',
      'flow.noMatch': 'Nothing of this kind',
      'flow.kind.all': 'All',
      'flow.kind.delegation': 'Delegation',
      'flow.kind.message': 'Message',
      'flow.kind.report': 'Report',
      'flow.tag.delegation': 'delegated',
      'flow.tag.message': 'sent',
      'flow.tag.report': 'reported',
      'status.running': 'Running',
      'status.done': 'Completed',
      'status.failed': 'Failed',
      'status.idle': 'Idle',
    }

    /** Chinese dictionary. */
    const zh = {
      'tab.label': 'Token 节点图',
      'canvas.title': 'Token 用量节点图',
      'canvas.subtitle': '主对话及其派生的各级子代理，每个节点显示最新一轮的用量。',
      'canvas.empty': '暂无子代理。该对话还没有派生出任何子代理。',
      'canvas.loading': '正在加载 Token 节点图…',
      'canvas.error': 'Token 节点图加载失败。',
      'canvas.retry': '重试',
      'canvas.legend.root': '主对话',
      'canvas.card': '节点图',
      'canvas.cardBadge': '显示 {count} / {total} 个',
      'canvas.legend.subagent': '子代理',
      'stats.running': '运行中',
      'stats.done': '已完成',
      'stats.failed': '失败',
      'stats.tokens': '全树累计 tokens',
      'lane.root': '主对话',
      'lane.delegated': '第 {depth} 层委派',
      'filter.all': '全部',
      'filter.running': '运行中',
      'filter.done': '已完成',
      'filter.failed': '失败',
      'filter.idle': '空闲',
      'filter.summary': '已过滤：{scope}（含上级链）· {visible}/{total} 个会话',
      'filter.search': '搜索代理…',
      'filter.queryScope': '搜索「{query}」',
      'segment.label': '委派轮次',
      'segment.all': '全部轮次',
      'segment.scope': '{span} 委派的一轮',
      'segment.tip': '{from} 至 {to} 之间启动了 {count} 个会话',
      'segment.undated': '{count} 个无时间',
      'segment.undatedTip': '这些会话没有记录开始时间，因此不会被轮次过滤隐藏。',
      'filter.empty': '没有会话匹配当前过滤条件。',
      'node.input': '输入',
      'node.output': '输出',
      'node.hit': '缓存命中',
      'node.duration': '耗时',
      'node.totals': '会话累计',
      'node.depth': '层级 {depth}',
      'node.open': '打开该代理自己的会话',
      'node.events': '{count} 事件',
      'node.eventsTip': '该代理记录的事件数（{count}）',
      'quiet.hidden': '隐藏 {count} 个安静',
      'quiet.shown': '已隐藏 {count} 个',
      'quiet.tip': '有 {count} 个代理已超过 5 分钟没有动静',
      'filter.quietScope': '隐藏 {count} 个安静',
      'flow.title': '协作往来',
      'flow.total': '{count} 次交接',
      'flow.empty': '暂时没有跨代理往来',
      'flow.noMatch': '没有这一类往来',
      'flow.kind.all': '全部',
      'flow.kind.delegation': '委派',
      'flow.kind.message': '消息',
      'flow.kind.report': '回报',
      'flow.tag.delegation': '委派',
      'flow.tag.message': '发送',
      'flow.tag.report': '回报',
      'status.running': '运行中',
      'status.done': '已完成',
      'status.failed': '失败',
      'status.idle': '空闲',
    }

    // ── Types ────────────────────────────────────────────────────────────────

    /** One node of the graph, as the Host serves it. */
    const GraphNodeShape = {
      id: '',
      kind: 'root',
      depth: 0,
      status: 'idle',
      totals: null,
      hitRate: null,
      totalHitRate: null,
      durationMs: null,
    }

    // ── The fleet board ──────────────────────────────────────────────────────

    /**
     * The Conversation tab body.
     *
     * @param props - the slot props: the current session id, the locale
     *   translator, and the RPC caller the Host injected.
     */
    function TokenGraphView({ sessionId, t, callGraph, openSession }) {
      const [payload, setPayload] = useState(null)
      const [error, setError] = useState(undefined)
      const [loading, setLoading] = useState(true)
      const [statusFilter, setStatusFilter] = useState('all')
      // null = no time window; otherwise the selected segment index.
      const [segmentFilter, setSegmentFilter] = useState(null)
      // Free-text agent search; matches label or session id, case-insensitive.
      const [query, setQuery] = useState('')
      // When true, agents that have gone quiet are dropped from the board and
      // only reported as a count the reader can expand back.
      const [hideQuiet, setHideQuiet] = useState(false)
      // The collaboration panel is open by default: the hand-offs are the
      // reason the tree looks the way it does, so they belong on screen from
      // the first frame. It stays collapsible for readers who want the whole
      // width for the board.
      const [flowOpen, setFlowOpen] = useState(true)
      // 'all' | 'delegation' | 'message' | 'report'
      const [flowKind, setFlowKind] = useState('all')

      // ── data ──────────────────────────────────────────────────────────────
      const refresh = useCallback(async () => {
        if (sessionId === undefined) return
        try {
          const next = await callGraph(sessionId)
          if (next === null || next === undefined) {
            setError(t('canvas.error'))
            setLoading(false)
            return
          }
          setPayload(next)
          setError(undefined)
          setLoading(false)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoading(false)
        }
      }, [sessionId, callGraph, t])

      // Poll only while the tab is mounted and the page is visible: the graph
      // costs nothing when nobody is looking at it.
      const pollIntervalMs = payload && typeof payload.pollIntervalMs === 'number'
        ? payload.pollIntervalMs
        : 2000

      useEffect(() => {
        let timer
        let cancelled = false

        const tick = () => {
          if (cancelled) return
          void refresh()
        }
        const start = () => {
          if (timer !== undefined) return
          tick()
          timer = window.setInterval(tick, pollIntervalMs)
        }
        const stop = () => {
          if (timer !== undefined) window.clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (document.hidden) stop()
          else start()
        }

        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [refresh, pollIntervalMs])

      // ── node list ─────────────────────────────────────────────────────────
      const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : []

      // ── filter visibility bookkeeping ─────────────────────────────────────
      // A node is visible when it matches the active status or is an ancestor
      // of a match, so a filtered child never dangles without its chain. The
      // set is computed once and shared by the layout and the summary line.
      // ── delegation segments ───────────────────────────────────────────────
      // Created once per payload; every segment is a burst of delegations the
      // parent started together. Kept independent of the status filter so the
      // chips always describe the whole run, not the already-filtered subset.
      // The root is the conversation, not a delegation, so it never forms a
      // round of its own; it still shows up because every round keeps its
      // ancestor chain.
      const segments = useMemo(
        () => groupByStartTime(nodes.filter((node) => node.id !== payload?.rootId), SEGMENT_GAP_MS),
        [nodes, payload],
      )

      // A stale index (payload changed under us) must not blank the board.
      const activeSegment = segmentFilter !== null && segmentFilter < segments.groups.length
        ? segmentFilter
        : null

      // An agent is "quiet" when it is not running and has not logged anything
      // for a while. Computed from the whole payload, like the round chips, so
      // the count it reports does not shift as the other filters change.
      // Undated agents are never called quiet: hiding what we cannot date would
      // silently drop live work.
      const quietIds = useMemo(() => {
        if (payload === null) return new Set()
        const now = typeof payload.now === 'number' ? payload.now : Date.now()
        const quiet = new Set()
        for (const node of payload.nodes) {
          if (node.kind === 'root') continue
          if (node.status === 'running') continue
          if (typeof node.lastEventTime !== 'number') continue
          if (now - node.lastEventTime >= QUIET_AFTER_MS) quiet.add(node.id)
        }
        return quiet
      }, [payload])

      const statusActive = statusFilter !== 'all'
      const timeActive = activeSegment !== null
      const normalizedQuery = query.trim().toLowerCase()
      const queryActive = normalizedQuery !== ''
      const quietActive = hideQuiet && quietIds.size > 0
      const filterActive = statusActive || timeActive || queryActive || quietActive

      // All three filters are applied to the same match set, then every
      // ancestor of a match is added back so no connector ever dangles.
      // Intersecting here (instead of filtering an already-filtered list)
      // keeps the controls combinable in any order.
      const visibleIds = useMemo(() => {
        if (payload === null) return null
        if (!filterActive) return null
        const segmentIds = timeActive ? new Set(segments.groups[activeSegment].ids) : null
        const byId = new Map(payload.nodes.map((node) => [node.id, node]))
        const visible = new Set()
        for (const node of payload.nodes) {
          if (statusActive && node.status !== statusFilter) continue
          if (segmentIds !== null && !segmentIds.has(node.id)) continue
          // A quiet agent drops out, but the ancestor walk below can still pull
          // it back when one of its own children is active — a running child
          // must never lose its chain.
          if (quietActive && quietIds.has(node.id)) continue
          if (queryActive) {
            const haystack = `${node.label ?? ''} ${node.id}`.toLowerCase()
            if (!haystack.includes(normalizedQuery)) continue
          }
          let cursor = node.id
          while (cursor !== undefined && !visible.has(cursor)) {
            visible.add(cursor)
            const parent = byId.get(cursor)
            cursor = parent === undefined ? undefined : parent.parentId
          }
        }
        return visible
      }, [payload, filterActive, statusFilter, statusActive, timeActive, segments, activeSegment, queryActive, normalizedQuery, quietActive, quietIds])
      const filterVisibleCount = visibleIds === null ? 0 : visibleIds.size
      const filterTotalCount = nodes.length

      // ── layout ────────────────────────────────────────────────────────────
      // The tree is laid out in real pixels from the visible child map; the
      // renderer draws cards and connectors at those coordinates, unscaled.
      //
      // The box the tab gives the board is measured first, because the card
      // size, the gaps and the row pitch are all solved from it: a wide tab
      // earns bigger cards and wider gaps, a short tab earns a compressed row
      // pitch. Nothing here is a hard-coded pixel size standing in for the
      // tab's real dimensions.
      const [avail, setAvail] = useState({ width: 0, height: 0 })
      const scrollRef = useRef(null)
      // ── the height this tab really has ─────────────────────────────────────
      // The built-in fleet view gets away with 'height: 100%' because the Host
      // keeps a definite height on the slot wrapper for it. While a
      // conversation is active that wrapper is rewritten to
      //   flex: 1 0 auto; min-height: auto
      // — a content-sized box — so a percentage inside it resolves against our
      // own content and the three cells never get a box to divide: the page
      // grows and scrolls as one column instead of each cell scrolling.
      //
      // Rather than fight the Host's cascade, read the number off the one box
      // that is NOT part of that loop: the nearest ancestor that already clips
      // (overflow-y hidden/auto/scroll — .scrollBody in the Host, and it is
      // fed by the window, not by us). Then pin this root to that many pixels.
      // One rAF per resize, no polling, no transform.
      const rootRef = useRef(null)
      const [frameHeight, setFrameHeight] = useState(0)
      useEffect(() => {
        const el = rootRef.current
        if (el === null || typeof window === 'undefined') return undefined
        let clipper = null
        for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          const oy = getComputedStyle(node).overflowY
          if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') {
            clipper = node
            break
          }
        }
        if (clipper === null) return undefined

        // Ask the Host to drop the composer while this tab is up. The Host's
        // own composer CSS leaves the stack in flow even though the seat is
        // absolute, so its 128px is real estate the board needs. Marking is
        // ref-counted per clipper: dsh-context (or a second instance of this
        // tab) may want the same thing, and whoever leaves last clears it.
        // A WeakMap keeps the count without pinning a detached node.
        const surface = clipper.hasAttribute('data-conversation-scroll')
          ? clipper
          : clipper.closest('[data-conversation-scroll]')
        const marks = clipper.__stgSurfaceMarks || (clipper.__stgSurfaceMarks = new WeakMap())
        let mark = null
        let marked = false
        const applyMark = () => {
          if (marked || surface === null) return
          if (mark === null) {
            mark = marks.get(surface)
            if (mark === undefined) {
              mark = { count: 0 }
              marks.set(surface, mark)
            }
          }
          mark.count += 1
          surface.setAttribute('data-stg-surface', '')
          marked = true
        }
        const releaseMark = () => {
          if (!marked || mark === null || surface === null) return
          marked = false
          mark.count -= 1
          if (mark.count <= 0) {
            surface.removeAttribute('data-stg-surface')
            marks.delete(surface)
            mark = null
          }
        }
        applyMark()

        const measure = () => {
          // The tab gets the clipper's own content height. That is the whole
          // calculation, and it is only this simple because the composer is
          // gone: with the seat hidden the clipper holds exactly one in-flow
          // child chain (the slot wrapper, which is display:contents-like in
          // turn), so its clientHeight IS the room available to this view.
          //
          // Two things this deliberately does NOT do. It does not read this
          // root's own top edge: the slot wrapper above is content-sized
          // (flex: 1 0 auto), so our height feeds back into where our top lands
          // and the measurement would converge on itself — it froze at 742px
          // for an afternoon doing exactly that. And it does not subtract the
          // composer any more: hiding the seat already removed it from the flow,
          // so subtracting would now under-count the tab by that same 128px.
          const next = Math.max(0, Math.round(clipper.clientHeight))
          setFrameHeight((prev) => (prev === next ? prev : next))
        }

        // Run the measurement outside the observer callback. Writing the height
        // inside a ResizeObserver notification resizes the very box being
        // observed, which makes the browser abort the remaining callbacks
        // ("ResizeObserver loop completed with undelivered notifications") and
        // can leave the tab pinned to a stale height. Scheduling on the next
        // frame keeps every write outside the notification itself.
        let queued = 0
        const schedule = () => {
          if (queued !== 0) return
          queued = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(() => { queued = 0; measure() })
            : window.setTimeout(() => { queued = 0; measure() }, 16)
        }

        measure()
        let observer
        if (typeof ResizeObserver === 'function') {
          // Observe ONLY the clipper: it is sized by the window, not by this
          // tab, so it is the one signal that cannot be driven by our own
          // writes. Observing an intermediate wrapper (which is content-sized)
          // turns every measurement into a new notification.
          observer = new ResizeObserver(schedule)
          observer.observe(clipper)
        }
        // Hand the composer back whenever this view stops being on screen, and
        // take it away again when it comes back. Unmount is not the only way a
        // tab can go away: if the Host keeps the view mounted and merely hides
        // it behind another tab, an unreleased mark would keep the message box
        // hidden in the REAL conversation — a far worse bug than a scrollbar.
        // IntersectionObserver on our own root is the honest signal: the view
        // is on screen if and only if we want the composer gone.
        let visibility
        if (typeof IntersectionObserver === 'function') {
          visibility = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1]
            if (entry === undefined) return
            if (entry.isIntersecting) {
              applyMark()
              schedule()
            } else {
              releaseMark()
            }
          })
          visibility.observe(el)
        }
        window.addEventListener('resize', schedule)
        return () => {
          if (queued !== 0) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(queued)
            else window.clearTimeout(queued)
            queued = 0
          }
          window.removeEventListener('resize', schedule)
          if (observer !== undefined) observer.disconnect()
          if (visibility !== undefined) visibility.disconnect()
          // Give the composer back, unless someone else still wants it gone.
          releaseMark()
        }
      }, [])
      useEffect(() => {
        const el = scrollRef.current
        if (el === null || typeof window === 'undefined') return undefined
        const measure = () => {
          // clientWidth/clientHeight already exclude borders and the scrollbar,
          // but they INCLUDE padding. The scroller has 22px/26px padding, so a
          // board sized against clientWidth overflows by exactly that padding
          // and grows a scrollbar of its own making. Subtract the padding and
          // measure the true content box; `scrollbar-gutter: stable` in the CSS
          // keeps the scrollbar from changing the answer between measurements.
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
          const padX = style === null ? 0
            : (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
          const padY = style === null ? 0
            : (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
          const width = Math.max(0, el.clientWidth - padX)
          const height = Math.max(0, el.clientHeight - padY)
          setAvail((prev) => (prev.width === width && prev.height === height
            ? prev
            : { width, height }))
        }
        measure()
        // Follow the tab box through several independent signals, because no
        // single one is reliable everywhere:
        //  - ResizeObserver on the scroller and its parent: the precise signal
        //    in a foreground window, and the one that fires for splitter drags.
        //  - window resize: covers a window-level resize that observers coalesce.
        //  - a slow interval: covers environments that defer the observer
        //    callbacks entirely. The interval is coarse on purpose (a background
        //    tab throttles timers to ~1/second, and a foreground one only pays
        //    one layout read), and measure() only writes state when the numbers
        //    actually changed, so a steady board never re-renders.
        let observer
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(el)
          if (el.parentElement !== null) observer.observe(el.parentElement)
        }
        window.addEventListener('resize', measure)
        const timer = window.setInterval(measure, 400)
        return () => {
          window.removeEventListener('resize', measure)
          window.clearInterval(timer)
          if (observer !== undefined) observer.disconnect()
        }
        // Re-attach whenever the scroller mounts or unmounts: the loading,
        // error and empty states render .stg-state instead of the scroller, so
        // the ref only exists once a tree is on screen.
      }, [payload === null, nodes.length === 0])

      const board = useMemo(() => {
        if (payload === null) return null
        const childrenOf = new Map()
        for (const node of payload.nodes) {
          if (node.parentId === undefined) continue
          if (visibleIds !== null && !visibleIds.has(node.id)) continue
          const bucket = childrenOf.get(node.parentId) || []
          bucket.push(node.id)
          childrenOf.set(node.parentId, bucket)
        }
        if (visibleIds !== null && !visibleIds.has(payload.rootId)) {
          // The filter matched nothing at all (not even the root survives).
          return null
        }
        return treeLayout(childrenOf, payload.rootId, avail)
      }, [payload, visibleIds, avail])

      // ── header stats ──────────────────────────────────────────────────────
      // Aggregated straight from the node list: one running/done/failed count
      // each, plus the cumulative token count of the whole tree.
      const stats = useMemo(() => {
        let running = 0
        let done = 0
        let failed = 0
        let totalTokens = 0
        for (const node of nodes) {
          if (node.status === 'running') running += 1
          else if (node.status === 'done') done += 1
          else if (node.status === 'failed') failed += 1
          const totals = node.totals
          if (totals !== undefined && totals !== null) {
            totalTokens += totals.uncachedInputTokens + totals.cacheReadTokens
              + totals.cacheWriteTokens + totals.outputTokens
          }
        }
        return { running, done, failed, totalTokens }
      }, [nodes])

      // ── collaboration flow ────────────────────────────────────────────────
      // The hand-off timeline: delegations out, messages between agents, and
      // settled reports coming back. Names are resolved from the node list so a
      // peer that is not part of this tree still shows something readable.
      const links = payload !== undefined && payload !== null && Array.isArray(payload.links)
        ? payload.links
        : []
      const linksById = useMemo(() => {
        const byId = new Map()
        for (const node of nodes) byId.set(node.id, node)
        return byId
      }, [nodes])

      // Newest first: the last thing that happened is what the reader wants.
      const linkRows = useMemo(() => {
        const nameOf = (id) => {
          const node = linksById.get(id)
          if (node === undefined) return id === undefined ? '' : shortenId(id)
          return node.label || (node.kind === 'root' ? t('canvas.legend.root') : shortenId(id))
        }
        return links
          .map((link, index) => ({
            key: `${link.sessionId}-${link.at ?? 0}-${link.kind}-${index}`,
            kind: link.kind,
            direction: link.direction,
            at: link.at,
            from: link.direction === 'out' ? nameOf(link.sessionId) : nameOf(link.peerId),
            to: link.direction === 'out' ? nameOf(link.peerId) : nameOf(link.sessionId),
            summary: link.summary,
          }))
          // A delegation's summary IS the delegate's name, so the row would
          // read "X → Y 委派 Y". Keep the summary only when it says something
          // the path already did not.
          .map((row) => (row.summary !== undefined && row.summary.trim() === row.to.trim()
            ? { ...row, summary: undefined }
            : row))
          .reverse()
      }, [links, linksById, t])

      const flowRows = flowKind === 'all'
        ? linkRows
        : linkRows.filter((row) => row.kind === flowKind)

      const flowCounts = useMemo(() => {
        const counts = { delegation: 0, message: 0, report: 0 }
        for (const row of linkRows) counts[row.kind] += 1
        return counts
      }, [linkRows])

      const flowPanel = h(CollabPanel, {
        open: flowOpen,
        onToggle: () => setFlowOpen((previous) => !previous),
        kind: flowKind,
        onKind: setFlowKind,
        counts: flowCounts,
        rows: flowRows,
        total: linkRows.length,
        t,
      })

      // ── render ────────────────────────────────────────────────────────────
      // Per-state counts on the chips: the filter reports what it can show
      // before it is clicked, and a zero-count state is visibly empty.
      const stateCounts = new Map(FILTER_STATES.map((state) => [state, 0]))
      for (const node of nodes) {
        if (stateCounts.has(node.status)) stateCounts.set(node.status, stateCounts.get(node.status) + 1)
      }

      const filterChips = [
        h('button', {
          type: 'button',
          key: 'all',
          className: `stg-filter-chip${statusFilter === 'all' ? ' stg-filter-chip--active' : ''}`,
          onClick: () => setStatusFilter('all'),
        },
        h('span', null, t('filter.all')),
        h('span', { className: 'stg-filter-count' }, String(nodes.length)),
        ),
        ...FILTER_STATES.map((state) => h('button', {
          type: 'button',
          key: state,
          className: `stg-filter-chip${statusFilter === state ? ' stg-filter-chip--active' : ''}`,
          onClick: () => setStatusFilter(state),
        },
        h('span', { className: `stg-dot stg-filter-dot stg-dot--${state}`, 'aria-hidden': true }),
        h('span', null, t(`filter.${state}`)),
        h('span', { className: 'stg-filter-count' }, String(stateCounts.get(state))),
        )),
      ]

      // A segmented control framing the chips (dsh-context's work-filter
      // style): the group itself is visible, so the filter is discoverable,
      // and a filter's state name reads through to the summary line.
      const filterGroup = h('div', { className: 'stg-filter-group' }, filterChips)

      // The quiet toggle sits with the search box: both are about narrowing
      // the board to what still matters, as opposed to labelling a state.
      // It only appears when something is actually quiet — an always-on
      // control that never changes anything is noise.
      const quietToggle = quietIds.size > 0
        ? h('button', {
          type: 'button',
          className: `stg-quiet-toggle${hideQuiet ? ' stg-quiet-toggle--on' : ''}`,
          'aria-pressed': hideQuiet ? 'true' : 'false',
          title: t('quiet.tip', { count: String(quietIds.size) }),
          onClick: () => setHideQuiet((previous) => !previous),
        },
          h('span', { className: 'stg-quiet-icon', 'aria-hidden': true }, '☾'),
          h('span', null, hideQuiet
            ? t('quiet.shown', { count: String(quietIds.size) })
            : t('quiet.hidden', { count: String(quietIds.size) })),
        )
        : null

      // ── delegation rounds ─────────────────────────────────────────────────
      // A run is a sequence, so "which round" is a slice of the run rather than
      // a set of states. Only rendered when there is more than one round (or
      // some node without a timestamp): a single round is not a choice.
      // A selector with a single option is noise, so it appears only when a
      // real choice exists: two or more rounds.
      const segmentBar = segments.groups.length > 1
        ? h('div', { className: 'stg-segment-bar' },
          h('span', { className: 'stg-segment-label' }, t('segment.label')),
          h('div', { className: 'stg-segment-track' },
            h('button', {
              type: 'button',
              className: `stg-segment-chip${activeSegment === null ? ' stg-segment-chip--active' : ''}`,
              onClick: () => setSegmentFilter(null),
            },
            h('span', { className: 'stg-segment-range' }, t('segment.all')),
            ),
            segments.groups.map((group, index) => h('button', {
              type: 'button',
              key: `${group.firstAt}-${index}`,
              className: `stg-segment-chip${activeSegment === index ? ' stg-segment-chip--active' : ''}`,
              title: t('segment.tip', {
                count: String(group.ids.length),
                from: formatClock(group.firstAt),
                to: formatClock(group.lastAt),
              }),
              onClick: () => setSegmentFilter(activeSegment === index ? null : index),
            },
            h('span', { className: 'stg-segment-range' },
              formatSpan(group.firstAt, group.lastAt),
            ),
            h('span', { className: 'stg-segment-count' }, String(group.ids.length)),
            )),
          ),
          segments.undated > 0
            ? h('span', { className: 'stg-segment-note', title: t('segment.undatedTip') },
              t('segment.undated', { count: String(segments.undated) }))
            : null,
        )
        : segments.undated > 0
          // Nothing to slice, but the reader still deserves to know that some
          // sessions carry no start time and therefore are not filterable.
          ? h('div', { className: 'stg-segment-bar' },
            h('span', { className: 'stg-segment-label' }, t('segment.label')),
            h('span', { className: 'stg-segment-note', title: t('segment.undatedTip') },
              t('segment.undated', { count: String(segments.undated) })),
          )
          : null

      // One small line above the board, only while a filter is active — the
      // visible feedback that the controls actually did something.
      const filterSummary = filterActive && filterVisibleCount > 0
        ? h('div', { className: 'stg-filter-summary' },
          h('span', { className: 'stg-filter-summary-dot', 'aria-hidden': true }),
          t('filter.summary', {
            scope: [
              statusActive ? t(`filter.${statusFilter}`) : null,
              timeActive
                ? t('segment.scope', {
                  span: formatSpan(
                    segments.groups[activeSegment].firstAt,
                    segments.groups[activeSegment].lastAt,
                  ),
                })
                : null,
              queryActive ? t('filter.queryScope', { query: query.trim() }) : null,
              quietActive ? t('filter.quietScope', { count: String(quietIds.size) }) : null,
            ].filter(Boolean).join(' · '),
            visible: String(filterVisibleCount),
            total: String(filterTotalCount),
          }),
        )
        : null

      // Left column = the board, right column = the hand-off flow. The board
      // column never scrolls as a whole: its control block (header, toolbar,
      // rounds) is frozen at the top and only the canvas moves under it, so a
      // reader deep in a scrolled tree can still retarget the graph.
      // `frameHeight` wins over the stylesheet's `height: 100%` once it is
      // known; before the first measurement it stays 0 and the CSS chain
      // applies unchanged, so there is no flash of a collapsed tab.
      return h('div', {
        className: 'stg-root',
        ref: rootRef,
        style: frameHeight > 0 ? { height: `${frameHeight}px`, maxHeight: `${frameHeight}px` } : undefined,
      },
        h('div', { className: 'stg-main' },
        h('div', { className: 'stg-controls' },
        // Header card: the title block on the left, the four counters packed
        // on the right at their natural width — the counters never stretch to
        // fill a wide tab.
        h('div', { className: 'stg-header' },
          h('div', { className: 'stg-headings' },
            h('h2', { className: 'stg-title' }, t('canvas.title')),
            h('p', { className: 'stg-subtitle' }, t('canvas.subtitle')),
          ),
          h('div', { className: 'stg-stats' },
            statCard(t('stats.running'), String(stats.running), 'running'),
            statCard(t('stats.done'), String(stats.done), 'done'),
            statCard(t('stats.failed'), String(stats.failed), 'failed'),
            statCard(t('stats.tokens'), formatTokens(stats.totalTokens), null),
          ),
        ),
        h('div', { className: 'stg-toolbar' },
          filterGroup,
          h('input', {
            type: 'search',
            className: 'stg-search',
            value: query,
            placeholder: t('filter.search'),
            'aria-label': t('filter.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          quietToggle,
          filterSummary,
        ),
        segmentBar,
        ),
        // ── the node-graph card ──
        // A bordered card with a header of its own, holding the only scrolling
        // region in this column. The controls above are a separate grid cell, so
        // nothing here can push them around.
        h('div', { className: 'stg-card' },
        h('div', { className: 'stg-card-head' },
          h('span', { className: 'stg-card-title' }, t('canvas.card')),
          // null means "no filter is active", i.e. every node is visible — the
          // badge must then say so rather than report zero hidden.
          h('span', { className: 'stg-card-badge' }, t('canvas.cardBadge', {
            count: String(visibleIds === null ? filterTotalCount : filterVisibleCount),
            total: String(filterTotalCount),
          })),
        ),
        error !== undefined
          ? h('div', { className: 'stg-state' },
            h('p', { className: 'stg-state-text' }, t('canvas.error')),
            h('button', { type: 'button', className: 'stg-btn', onClick: () => { setLoading(true); void refresh() } }, t('canvas.retry')),
          )
          : loading
            ? h('div', { className: 'stg-state' }, h('p', { className: 'stg-state-text' }, t('canvas.loading')))
            : nodes.length <= 1
              ? h('div', { className: 'stg-state' }, h('p', { className: 'stg-state-text' }, t('canvas.empty')))
              : board === null && filterActive
                ? h('div', { className: 'stg-state' },
                  h('p', { className: 'stg-state-text' }, t('filter.empty')),
                  h('button', {
                    type: 'button',
                    className: 'stg-btn',
                    onClick: () => {
                      setStatusFilter('all')
                      setSegmentFilter(null)
                      setQuery('')
                      setHideQuiet(false)
                    },
                  }, t('filter.all')),
                )
                : board === null
                  ? h('div', { className: 'stg-state' }, h('p', { className: 'stg-state-text' }, t('canvas.empty')))
                  : h('div', { className: 'stg-board-scroll', ref: scrollRef },
                    h('div', {
                      className: 'stg-board',
                      style: {
                        width: `${board.width}px`,
                        height: `${board.height}px`,
                        '--stg-node-w': `${board.nodeWidth}px`,
                        '--stg-node-h': `${board.nodeHeight}px`,
                      },
                    },
                    // The connector layer sits under the cards and is drawn in
                    // the board's own pixel space: no scaling, so the strokes
                    // stay hairline-crisp.
                    h('svg', {
                      className: 'stg-edges',
                      width: board.width,
                      height: board.height,
                      viewBox: `0 0 ${board.width} ${board.height}`,
                      'aria-hidden': true,
                    },
                    board.edges.map((edge) => {
                      const from = board.positions.get(edge.from)
                      const to = board.positions.get(edge.to)
                      if (from === undefined || to === undefined) return null
                      const x1 = from.x + board.nodeWidth / 2 + board.offsetX
                      const y1 = from.y + board.nodeHeight + board.offsetY
                      const x2 = to.x + board.nodeWidth / 2 + board.offsetX
                      const y2 = to.y + board.offsetY
                      const midY = (y1 + y2) / 2
                      // Orthogonal elbow: down, across, down — the shape that
                      // reads as "this card hangs from that one".
                      return h('path', {
                        key: `${edge.from}->${edge.to}`,
                        className: 'stg-edge',
                        d: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
                      })
                    }),
                    ),
                    nodes.map((node) => {
                      if (visibleIds !== null && !visibleIds.has(node.id)) return null
                      const position = board.positions.get(node.id)
                      if (position === undefined) return null
                      return h(NodeCard, {
                        key: node.id,
                        node,
                        t,
                        depth: position.depth,
                        openSession,
                        style: {
                          left: `${position.x + board.offsetX}px`,
                          top: `${position.y + board.offsetY}px`,
                        },
                      })
                    }),
                    ),
                  ),
        ),
        // ── right column: the hand-off flow ──
        // A sibling of the board rather than a strip under it: the two are read
        // together (a card and the events that produced it), so they share the
        // viewport instead of competing for the same vertical space.
        h('div', { className: 'stg-col--side' }, flowPanel),
        ),
      )
    }

    /** The collaboration panel: a collapsed strip until the reader asks. */
    function CollabPanel({ open, onToggle, kind, onKind, counts, rows, total, t }) {
      const kinds = [
        ['all', t('flow.kind.all'), total],
        ['delegation', t('flow.kind.delegation'), counts.delegation],
        ['message', t('flow.kind.message'), counts.message],
        ['report', t('flow.kind.report'), counts.report],
      ]
      return h('div', { className: `stg-flow${open ? ' stg-flow--open' : ''}` },
        h('button', {
          type: 'button',
          className: 'stg-flow-head',
          'aria-expanded': open ? 'true' : 'false',
          onClick: onToggle,
        },
          h('span', { className: `stg-flow-caret${open ? ' stg-flow-caret--open' : ''}`, 'aria-hidden': true }, '▸'),
          h('span', { className: 'stg-flow-title' }, t('flow.title')),
          h('span', { className: 'stg-flow-count' }, t('flow.total', { count: String(total) })),
          total === 0 ? h('span', { className: 'stg-flow-hint' }, t('flow.empty')) : null,
        ),
        open && total > 0
          ? h('div', { className: 'stg-flow-body' },
            h('div', { className: 'stg-flow-kinds' }, kinds.map(([id, label, count]) => h('button', {
              type: 'button',
              key: id,
              className: `stg-flow-kind${kind === id ? ' stg-flow-kind--on' : ''}`,
              onClick: () => onKind(id),
            },
            h('span', null, label),
            h('span', { className: 'stg-flow-kind-count' }, String(count)),
            ))),
            h('div', { className: 'stg-flow-list' }, rows.length === 0
              ? h('p', { className: 'stg-flow-none' }, t('flow.noMatch'))
              : rows.map((row) => h('div', {
                key: row.key,
                className: `stg-flow-row stg-flow-row--${row.kind}`,
              },
              h('span', { className: `stg-flow-dot stg-flow-dot--${row.kind}`, 'aria-hidden': true }),
              h('span', { className: 'stg-flow-time' }, formatClock(row.at)),
              h('span', { className: 'stg-flow-path' },
                h('span', { className: 'stg-flow-from' }, row.from),
                h('span', { className: 'stg-flow-arrow', 'aria-hidden': true }, '→'),
                h('span', { className: 'stg-flow-to' }, row.to),
              ),
              h('span', { className: 'stg-flow-kind-tag' }, t(`flow.tag.${row.kind}`)),
              row.summary === undefined
                ? null
                : h('span', { className: 'stg-flow-summary', title: row.summary }, row.summary),
              ))),
          )
          : null,
      )
    }

    /** One small stat card in the header row. */
    function statCard(label, value, state) {
      return h('div', {
        className: `stg-stat${state === null ? '' : ` stg-stat--${state}`}`,
      },
        h('div', { className: 'stg-stat-label' },
          state === null
            ? null
            : h('span', { className: `stg-dot stg-dot--${state}`, 'aria-hidden': true }),
          h('span', { className: 'stg-stat-label-text' }, label),
        ),
        h('div', { className: 'stg-stat-value' }, value),
      )
    }

    /**
     * One card of the board.
     *
     * Four tight rows: head (status dot + title + small depth badge on the
     * right for subagents), a 2×2 metric grid (input, output, cache-hit rate,
     * duration), a thin context bar with the occupancy percentage beside it
     * (omitted when the session reported no context window), and a small
     * grey footer carrying the cumulative session tokens and cumulative
     * hit rate. The primary reading stays the latest round; the totals are
     * secondary.
     *
     * The card is absolutely positioned at the coordinates the layout handed
     * down, so the cards and the SVG connector layer share one pixel space
     * and nothing is ever scaled — the text renders at its natural size.
     */
    function NodeCard({ node, t, depth, style, openSession }) {
      // Only subagents open elsewhere: the root already IS the conversation
      // being viewed, so offering a jump to it would be a no-op.
      const openable = node.kind === 'subagent' && typeof openSession === 'function'
      const hasLast = node.last !== undefined && node.last !== null
      const last = hasLast ? node.last : zeroBuckets()
      const rate = node.hitRate !== null && node.hitRate !== undefined ? node.hitRate : cacheHitRate(last)
      const contextPercent = node.contextWindow !== undefined
        && node.contextWindow > 0
        && node.pressureTokens !== undefined
        ? Math.min(100, (node.pressureTokens / node.contextWindow) * 100)
        : undefined

      const title = node.label
        || (node.kind === 'root' ? t('canvas.legend.root') : node.id)

      const promptTokens = last.uncachedInputTokens + last.cacheReadTokens + last.cacheWriteTokens

      // The whole card opens the agent's own conversation — the same jump the
      // reference fleet view offers as a per-lane arrow. Keyboard users get
      // the same action through Enter/Space.
      const openProps = openable
        ? {
          role: 'button',
          tabIndex: 0,
          title: t('node.open'),
          'aria-label': `${title} — ${t('node.open')}`,
          onClick: () => openSession(node.id),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openSession(node.id)
            }
          },
        }
        : {}

      return h('div', {
        className: `stg-node stg-node--${node.kind} stg-node--${node.status}${openable ? ' stg-node--openable' : ''}`,
        'data-node-id': node.id,
        style,
        ...openProps,
      },
        h('div', { className: 'stg-node-head' },
          h('span', { className: `stg-dot stg-dot--${node.status}`, 'aria-hidden': true }),
          h('span', { className: 'stg-node-title', title: node.id }, title),
          node.kind === 'subagent'
            ? h('span', { className: 'stg-badge' }, t('node.depth', { depth }))
            : null,
          openable
            ? h('span', { className: 'stg-node-open', 'aria-hidden': true }, '↗')
            : null,
        ),
        h('div', { className: 'stg-node-grid' },
          metric(t('node.input'), hasLast ? formatTokens(promptTokens) : '—'),
          metric(t('node.output'), hasLast ? formatTokens(last.outputTokens) : '—'),
          metric(t('node.hit'), formatHitRate(rate)),
          metric(t('node.duration'), formatDuration(node.durationMs)),
        ),
        contextPercent === undefined
          ? null
          : h('div', { className: 'stg-context-row' },
            h('div', { className: 'stg-context-bar', title: `${contextPercent.toFixed(1)}%` },
              h('span', { className: 'stg-context-fill', style: { width: `${contextPercent}%` } }),
            ),
            h('span', { className: 'stg-context-pct' }, `${contextPercent.toFixed(1)}%`),
          ),
        h('div', { className: 'stg-node-foot' },
          h('span', { className: 'stg-node-foot-totals' },
            `${t('node.totals')} ${formatTokens(node.totals.uncachedInputTokens + node.totals.cacheReadTokens + node.totals.cacheWriteTokens + node.totals.outputTokens)}`,
          ),
          h('span', null, formatHitRate(node.totalHitRate)),
          // Traffic: how much this agent actually did, in events. A cheaper
          // and more legible "work volume" than tokens.
          node.eventCount === undefined
            ? null
            : h('span', {
              className: 'stg-node-foot-events',
              title: t('node.eventsTip', { count: String(node.eventCount) }),
            }, t('node.events', { count: String(node.eventCount) })),
        ),
      )
    }

    /** One labelled metric inside a node card. */
    function metric(label, value) {
      return h('div', { className: 'stg-metric' },
        h('span', { className: 'stg-metric-label' }, label),
        h('span', { className: 'stg-metric-value' }, value),
      )
    }

    // ── Styles ──────────────────────────────────────────────────────────────

    /**
     * The plugin's stylesheet.
     *
     * Every colour resolves through a `--dsw-alias-*` theme token, so the
     * board follows the host's light/dark theme instead of hard-coding its
     * own palette.
     */
    const CSS = `
/* ── Composer hand-off ───────────────────────────────────────────────────── */

/* This tab is a board, not a transcript: there is nothing to type at. The
   Host's composer is 128px of IN-FLOW height inside the scroll body (the seat
   is absolute, but the stack that holds it is not), so leaving it up costs a
   quarter of the tab on a laptop panel. Hide it while this tab is the active
   surface.

   Copied in spirit from dsh-context, which does exactly this
   ([data-conversation-scroll][data-lc-surface] > [data-composer-seat]). The
   seat is only hidden when it holds neither an approval prompt nor a plan
   review: those two must stay reachable, so the rule excludes them and the
   Host keeps its 128px. Marking is ref-counted through a WeakMap, so two tabs
   that both want the composer gone cannot un-mark each other. */[data-conversation-scroll][data-stg-surface] > [data-composer-seat]:not(:has([data-approval-key], [data-plan-review-key])),
[data-conversation-scroll][data-stg-surface] > [data-stg-composer-hide] {
  display: none;
}

.stg-root {
  /* Local accents. Every one resolves through the Host palette; violet is the
     official "done" hue (violet-400/600), and the fallbacks keep the board
     legible when a Host build lacks that alias. Declared here so the whole
     stylesheet can stay literal-free. */
  --stg-violet: var(--dsw-alias-state-done-primary, var(--dsw-static-violet-400, #8b7cf6));
  --stg-cyan: var(--dsw-alias-state-business-primary, var(--dsw-static-deepseek-400, #4d6bfe));
  --stg-green: var(--dsw-alias-state-success-primary, #3ecf8e);
  --stg-red: var(--dsw-alias-state-error-primary, #ef5350);
  --stg-ink: var(--dsw-alias-label-primary, #e6e9ef);
  --stg-ink-2: var(--dsw-alias-label-secondary, #a9b3c1);
  /* No fallback here was a real bug: with the alias missing this resolved to
     nothing, every color-mix() that mentioned it became invalid, and the
     connection lines between cards disappeared with no error anywhere. Always
     give a Host alias a literal fallback. */
  --stg-ink-3: var(--dsw-alias-label-tertiary, #7b8698);

  /* Also a query container. The single-column fallback below must answer the
     width of THIS tab, not the width of the window, so a media query cannot do
     the job — a wide window showing a narrow tab still has to stack. Container
     queries and flex coexist: this only adds inline-size containment. */
  container-type: inline-size;
  /* Height is a plain 100% chain: the board and the flow list scroll inside
     their own cells, and the board's geometry comes from measuring its own
     cell. There is no pixel height pinned anywhere. The column is what passes
     the resolved height down to the grid — without it the grid sizes to its
     content and overflows the tab. */
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  /* Clip, don't grow. The Host puts this slot in .viewArea, which it flips to
     'flex: 1 0 auto; min-height: auto' while the conversation is active — a
     CONTENT-SIZED box. Against an auto height 'height: 100%' has nothing to
     borrow and degrades to auto, so the board's own content height feeds back
     into the page and the tab grows instead of scrolling inside its cells.
     'overflow: hidden' caps what this root reports, which is what keeps the
     grid below it from leaking into the page. */
  overflow: hidden;
  padding: 14px 16px 16px;
  box-sizing: border-box;
  color: var(--stg-ink);
  font-size: 12px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}



/* ── Three-cell shell ────────────────────────────────────────────────────── */

/* The same shape the reference layout uses: the control card occupies the top
   row at its natural height, the node graph takes the whole remaining height in
   the bottom row, and the side panel spans both rows. Grid rather than nested
   flex because the two rows are independent — a taller toolbar must never
   squeeze the canvas by a pixel, and a taller canvas must never move a filter.

   display: contents on the wrapper is deliberate: the wrapper exists only
   because the three cells are built by three different parts of the render, but
   a real element here would add a box between the grid and its cells. */
.stg-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(232px, 26%, 320px);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
}

/* The control block is one cell of the grid now, not a stack inside a column:
   it must not grow, and its own contents keep the column layout they had. */
.stg-controls {
  grid-row: 1;
  grid-column: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* The graph card wraps the scroller and gives it a header of its own, so the
   scrolling region is a bordered card exactly like the reference — not a bare
   overflow box with the filters floating above it. */
.stg-card {
  grid-row: 2;
  grid-column: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 55%, transparent);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

.stg-card-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 45%, transparent);
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 92%, var(--stg-violet) 8%);
  font-size: 11.5px;
  color: var(--stg-ink-2);
}

.stg-card-title {
  font-weight: 600;
  color: var(--stg-ink);
}

.stg-card-badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--stg-violet) 14%, transparent);
  color: color-mix(in oklab, var(--stg-violet) 78%, var(--stg-ink));
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Side panel: same cell coordinates as the reference — it spans both rows and
   owns its own scrolling, so a long flow never scrolls the board away. */
.stg-col--side {
  grid-row: 1 / 3;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* One column: the control card, the graph card and the flow stack instead of
   sitting side by side. This is the reference's breakpoint, but resolved
   against the tab's own width through the container query on .stg-root. */
@container (max-width: 800px) {
  /* One column: controls, board, flow. The flow keeps a readable floor of its
     own instead of collapsing into whatever is left over — on a short tab the
     three stacked blocks simply need more room than the tab has, and the
     honest answer is to scroll this column rather than to squeeze the flow to
     a sliver. The overflow rule below only engages in that case. */
  .stg-main {
    grid-template-columns: minmax(0, 1fr);
    /* max-content, not auto: an auto track is ALLOWED to shrink below its
       content when the grid is over-subscribed, and at 480x380 it did exactly
       that — the control row collapsed to zero height while its buttons were
       still in it. max-content keeps it at its real height and pushes the
       overflow onto the scroll instead. */
    grid-template-rows: max-content minmax(180px, 1fr) max-content;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .stg-controls {
    grid-row: 1;
    grid-column: 1;
    /* Belt and braces with max-content above: never let the frozen control
       block be the block that gets squeezed. */
    flex: none;
  }

  .stg-card {
    grid-row: 2;
    grid-column: 1;
    min-height: 180px;
  }

  .stg-col--side {
    grid-row: 3;
    grid-column: 1;
    /* No max-height here: in a column flow that only re-introduces the
       squeeze the floor above is there to prevent. */
    max-height: none;
    min-height: 140px;
  }
}

/* ── Header card ─────────────────────────────────────────────────────────── */

.stg-header {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 14px;
  padding: 14px 16px 12px;
  border-radius: 14px;
  border: 1px solid color-mix(in oklab, var(--stg-violet) 14%, transparent);
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in oklab, var(--stg-violet) 13%, transparent), transparent 62%),
    linear-gradient(100deg, color-mix(in oklab, var(--stg-violet) 5%, transparent), transparent 55%),
    var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 24px color-mix(in oklab, var(--stg-violet) 7%, transparent);
}
.stg-headings { min-width: 0; }
.stg-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.024em;
  line-height: 1.2;
  color: var(--stg-ink);
}
.stg-subtitle {
  margin: 5px 0 0;
  max-width: 62ch;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--stg-ink-2);
}

/* ── Toolbar ─────────────────────────────────────────────────────────────── */

.stg-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
}
.stg-btn {
  appearance: none;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 70%, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--stg-ink);
  font: inherit;
  font-size: 11.5px;
  font-weight: 560;
  padding: 6px 11px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.stg-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); }
.stg-btn:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--stg-violet) 55%, transparent);
  outline-offset: 1px;
}

/* ── Segmented status filter ─────────────────────────────────────────────── */

.stg-filter-group {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: 9px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 60%, transparent);
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 80%, transparent);
}
.stg-filter-chip {
  appearance: none;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--stg-ink-2);
  font: inherit;
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0.01em;
  padding: 5px 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 120ms ease, color 120ms ease;
}
.stg-filter-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
  color: var(--stg-ink);
}
.stg-filter-chip:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--stg-violet) 55%, transparent);
  outline-offset: 1px;
}
.stg-filter-chip--active {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--stg-ink);
  font-weight: 640;
  box-shadow: 0 1px 3px color-mix(in oklab, var(--stg-ink) 12%, transparent);
}
.stg-filter-count {
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink-3);
}
.stg-filter-chip--active .stg-filter-count { color: var(--stg-ink-2); }
.stg-filter-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

/* ── Run-state dots ──────────────────────────────────────────────────────── */

.stg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  display: inline-block;
  background: var(--stg-ink-3);
}
.stg-dot--running {
  background: var(--stg-green);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--stg-green) 22%, transparent);
  animation: stg-pulse 1.7s ease-in-out infinite;
}
.stg-dot--done { background: var(--stg-violet); }
.stg-dot--failed { background: var(--stg-red); }
.stg-dot--idle { background: var(--stg-ink-3); }
.stg-filter-dot.stg-dot--running { box-shadow: none; animation: none; }
@keyframes stg-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .stg-dot--running { animation: none; }
}

/* ── Stat strip ──────────────────────────────────────────────────────────── */

.stg-stats {
  flex: none;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(74px, auto);
  gap: 6px;
}
.stg-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 11px 6px;
  border-radius: 9px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 55%, transparent);
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.stg-stat-label {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.045em;
  text-transform: uppercase;
  color: var(--stg-ink-3);
}
.stg-stat-label-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stg-stat-value {
  font-size: 19px;
  font-weight: 720;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink);
}
.stg-stat--running .stg-stat-value { color: var(--stg-cyan); }
.stg-stat--done .stg-stat-value { color: var(--stg-violet); }
.stg-stat--failed .stg-stat-value { color: var(--stg-red); }

/* ── States ──────────────────────────────────────────────────────────────── */

.stg-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 120px;
  border-radius: 12px;
  border: 1px dashed color-mix(in oklab, var(--dsw-alias-border-l2) 70%, transparent);
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 60%, transparent);
  padding: 24px;
}
.stg-state-text {
  margin: 0;
  font-size: 12.5px;
  color: var(--stg-ink-2);
  text-align: center;
}
.stg-error-detail {
  max-width: 640px;
  max-height: 200px;
  overflow: auto;
  margin: 0;
  opacity: 0.75;
}

/* ── Board scroller ──────────────────────────────────────────────────────── */

.stg-board-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /* No border or radius of its own: it is the body of .stg-card now, and the
     card owns the outline. Padding stays so cards near the edge are readable. */
  background:
    radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--stg-ink-3) 20%, transparent) 1px, transparent 0)
      0 0 / 16px 16px;
  padding: 22px 22px 26px;
  box-sizing: border-box;
  scrollbar-width: thin;
  /* Always reserve the scrollbar gutter. Without this, the board is measured,
     then a scrollbar appears and steals width, the next measurement shrinks
     the board, the scrollbar disappears — a measurement loop that never
     settles. A stable gutter keeps clientWidth constant either way. */
  scrollbar-gutter: stable;
}

/* ── Delegation rounds ───────────────────────────────────────────────────── */

/* Reads as a timeline, not a second set of filters: the chips are ordered by
   time and the range is spelled out, so "which round" is a slice of the run. */
.stg-segment-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 26px;
}
.stg-segment-label {
  flex: none;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--stg-ink-3);
}
.stg-segment-track {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;
}
.stg-segment-chip {
  appearance: none;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 60%, transparent);
  border-radius: 7px;
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 70%, transparent);
  color: var(--stg-ink-2);
  font: inherit;
  font-size: 11px;
  font-weight: 560;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.stg-segment-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
  color: var(--stg-ink);
}
.stg-segment-chip:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--stg-violet) 55%, transparent);
  outline-offset: 1px;
}
/* The active round is the only strongly tinted control on the row. */
.stg-segment-chip--active {
  color: var(--stg-ink);
  border-color: color-mix(in oklab, var(--stg-violet) 52%, transparent);
  background: color-mix(in oklab, var(--stg-violet) 16%, transparent);
}
.stg-segment-range {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
.stg-segment-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--stg-ink-3);
  padding: 0 3px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--stg-ink-3) 16%, transparent);
}
.stg-segment-chip--active .stg-segment-count {
  color: var(--stg-ink);
  background: color-mix(in oklab, var(--stg-violet) 28%, transparent);
}
.stg-segment-note {
  flex: none;
  font-size: 10.5px;
  color: var(--stg-ink-3);
  white-space: nowrap;
}

.stg-search {
  flex: none;
  width: 150px;
  box-sizing: border-box;
  padding: 4px 9px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 60%, transparent);
  border-radius: 7px;
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 70%, transparent);
  color: var(--stg-ink);
  font: inherit;
  font-size: 11px;
  transition: border-color 120ms ease, background 120ms ease;
}
.stg-search::placeholder {
  color: var(--stg-ink-3);
}
.stg-search:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}
.stg-search:focus {
  outline: none;
  border-color: color-mix(in oklab, var(--stg-violet) 52%, transparent);
}
.stg-search::-webkit-search-cancel-button {
  cursor: pointer;
}

.stg-filter-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 4px 9px;
  border-radius: 7px;
  border: 1px solid color-mix(in oklab, var(--stg-violet) 22%, transparent);
  background: color-mix(in oklab, var(--stg-violet) 8%, transparent);
  font-size: 11px;
  color: var(--stg-ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stg-filter-summary-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: none;
  background: var(--stg-violet);
}

/* The board is the exact pixel size of the laid-out tree; the cards and the
   connector paths are positioned inside it and never scale. */
.stg-board { position: relative; margin: 0 auto; }

.stg-edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.stg-edge {
  fill: none;
  /* Literal fallback FIRST, color-mix second. A single color-mix declaration
     makes the whole property drop out on any engine that cannot resolve it
     (stroke then computes to none and every connection silently vanishes),
     and the failure is invisible in devtools until you look at the computed
     style of a path. Two declarations let the browser keep the first one it
     understands. */
  stroke: var(--stg-violet);
  stroke: color-mix(in oklab, var(--stg-violet) 62%, var(--stg-ink-3));
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ── Node card ───────────────────────────────────────────────────────────── */

.stg-node {
  position: absolute;
  box-sizing: border-box;
  /* Size is solved per render from the tab's real dimensions and handed in as
     custom properties; the fallbacks only apply before the first measurement
     lands and match the old fixed cards. */
  width: var(--stg-node-w, 212px);
  height: var(--stg-node-h, 120px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 7px;
  border-radius: 11px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 78%, transparent);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 2px 6px color-mix(in oklab, var(--stg-ink) 7%, transparent);
  overflow: hidden;
  transition: box-shadow 140ms ease, border-color 140ms ease;
}
/* Status accent on the leading edge — readable at a glance without relying
   on colour alone, since the dot and the title carry the same signal. */
.stg-node::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--stg-ink-3);
}
.stg-node--running::before { background: var(--stg-green); }
.stg-node--failed::before { background: var(--stg-red); }
.stg-node--root::before { background: var(--stg-violet); }
.stg-node:hover {
  border-color: color-mix(in oklab, var(--stg-violet) 45%, var(--dsw-alias-border-l2));
  box-shadow: 0 6px 16px color-mix(in oklab, var(--stg-violet) 14%, transparent);
  z-index: 2;
}
/* Cards that jump to another conversation say so with the pointer and the
   arrow; the hover accent already comes from .stg-node:hover above. */
.stg-node--openable {
  cursor: pointer;
}
.stg-node--openable:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--stg-violet) 55%, transparent);
  outline-offset: 1px;
}
.stg-node-open {
  flex: none;
  font-size: 11px;
  line-height: 1;
  color: var(--stg-ink-3);
  transition: color 120ms ease, transform 120ms ease;
}
.stg-node--openable:hover .stg-node-open,
.stg-node--openable:focus-visible .stg-node-open {
  color: var(--stg-violet);
  transform: translate(1px, -1px);
}
.stg-node--root {
  border-color: color-mix(in oklab, var(--stg-violet) 42%, transparent);
  background:
    linear-gradient(160deg, color-mix(in oklab, var(--stg-violet) 9%, transparent), transparent 70%),
    var(--dsw-alias-bg-layer-1);
  box-shadow: 0 4px 14px color-mix(in oklab, var(--stg-violet) 13%, transparent);
}
.stg-node--running {
  border-color: color-mix(in oklab, var(--stg-green) 45%, transparent);
}
.stg-node--failed {
  border-color: color-mix(in oklab, var(--stg-red) 45%, transparent);
  background:
    linear-gradient(160deg, color-mix(in oklab, var(--stg-red) 7%, transparent), transparent 70%),
    var(--dsw-alias-bg-layer-1);
}

.stg-node-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: none;
}
.stg-node-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 620;
  letter-spacing: -0.01em;
  color: var(--stg-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stg-node--root .stg-node-title { font-size: 12.5px; font-weight: 680; }
.stg-badge {
  flex: none;
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  border-radius: 5px;
  color: var(--stg-ink-2);
  background: color-mix(in oklab, var(--stg-ink-3) 16%, transparent);
}

/* 2×2 metric grid: label left, value right, tabular figures so columns line up. */
.stg-node-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 10px;
  flex: none;
}
.stg-metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
}
.stg-metric-label {
  font-size: 9.5px;
  color: var(--stg-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stg-metric-value {
  font-size: 11.5px;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink);
  white-space: nowrap;
}

.stg-context-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.stg-context-bar {
  position: relative;
  flex: 1;
  height: 3px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in oklab, var(--stg-ink-3) 20%, transparent);
}
.stg-context-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: color-mix(in oklab, var(--stg-violet) 75%, transparent);
}
.stg-context-pct {
  flex: none;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink-3);
}

.stg-node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex: none;
  margin-top: auto;
  padding-top: 4px;
  border-top: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 45%, transparent);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink-3);
  white-space: nowrap;
  overflow: hidden;
}

/* ── collaboration flow ─────────────────────────────────────────────────── */

/* A full-height column, not a bottom strip: collapsed it is a single labelled
   row at the top of the pane, expanded it owns the pane and its list scrolls
   on its own without ever pushing the board around. */
.stg-flow {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

/* Expanded, the panel takes the whole column and its list scrolls inside
   itself; collapsed, it stays a single row at the top rather than an empty
   full-height box. */
.stg-flow--open {
  flex: 1;
}

.stg-flow-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  flex: none;
  padding: 8px 11px;
  border: none;
  background: transparent;
  color: var(--stg-ink-2);
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.stg-flow-head:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}

.stg-flow-caret {
  display: inline-block;
  flex: none;
  width: 10px;
  color: var(--stg-ink-3);
  transition: transform 120ms ease;
}

.stg-flow-caret--open {
  transform: rotate(90deg);
}

.stg-flow-title {
  flex: none;
  font-weight: 600;
  color: var(--stg-ink);
}

.stg-flow-count,
.stg-flow-hint {
  flex: none;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink-3);
}

.stg-flow-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-height: 0;
  padding: 0 10px 10px;
}

.stg-flow-kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.stg-flow-kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--stg-ink-2);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}

.stg-flow-kind:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}

.stg-flow-kind--on {
  border-color: var(--stg-accent);
  color: var(--stg-accent);
  background: color-mix(in oklab, var(--stg-accent) 10%, transparent);
}

.stg-flow-kind-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.stg-flow-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  scrollbar-width: thin;
}

.stg-flow-none {
  margin: 0;
  padding: 10px 12px;
  color: var(--stg-ink-3);
  font-size: 11px;
}

.stg-flow-row {
  display: flex;
  /* A 300px column cannot hold time + path + tag + summary on one line, so
     the row wraps: time and kind on the first line, the path on the second,
     and the summary gets whatever width is left. */
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  padding: 5px 9px;
  font-size: 11px;
  border-bottom: 1px solid color-mix(in oklab, var(--dsw-alias-border-l2) 40%, transparent);
}

.stg-flow-row:last-child {
  border-bottom: none;
}

.stg-flow-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}

.stg-flow-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  transform: translateY(-1px);
}

.stg-flow-dot--delegation { background: var(--stg-cyan); }
.stg-flow-dot--message { background: var(--stg-violet); }
.stg-flow-dot--report { background: var(--stg-green); }

.stg-flow-time {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--stg-ink-3);
}

.stg-flow-path {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex: 1 1 100%;
  min-width: 0;
  order: 4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--stg-ink-2);
}

.stg-flow-from,
.stg-flow-to {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stg-flow-arrow {
  flex: none;
  color: var(--stg-ink-3);
}

.stg-flow-kind-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--dsw-alias-border-l2) 55%, transparent);
  color: var(--stg-ink-3);
  font-size: 9.5px;
}

.stg-flow-summary {
  flex: 1 1 100%;
  min-width: 0;
  order: 4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--stg-ink-3);
}

/* The short label column of a narrow row: the dot and time open the first
   line, the kind tag closes it on the right, then the path and the summary
   each take a full line of their own. */
.stg-flow-time { order: 2; }
.stg-flow-dot { order: 1; }
.stg-flow-kind-tag { order: 3; margin-left: auto; }

/* ── quiet-agent toggle ─────────────────────────────────────────────────── */

.stg-quiet-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--stg-ink-2);
  font: inherit;
  font-size: 10.5px;
  white-space: nowrap;
  cursor: pointer;
}

.stg-quiet-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}

.stg-quiet-toggle--on {
  border-color: var(--stg-accent);
  color: var(--stg-accent);
  background: color-mix(in oklab, var(--stg-accent) 10%, transparent);
}

.stg-quiet-icon {
  font-size: 11px;
  line-height: 1;
}
`

    /**
     * Error boundary around the fleet board.
     *
     * A render error inside the board previously unmounted the whole
     * conversation view (white screen with no clue). The boundary keeps the
     * failure contained to this tab and prints the actual error text, so a
     * bug report carries its own diagnosis.
     */
    class GraphBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        const { error } = this.state
        if (error !== null) {
          return h('div', { className: 'stg-state' },
            h('p', { className: 'stg-state-text' },
              `${this.props.t('canvas.error')}`),
            h('pre', {
              className: 'stg-error-detail',
              style: { whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.8, maxWidth: 640 },
            }, String(error && error.stack ? error.stack : error)),
            h('button', {
              type: 'button',
              className: 'stg-btn',
              onClick: () => this.setState({ error: null }),
            }, this.props.t('canvas.retry')),
          )
        }
        return this.props.children
      }
    }

    // ── The plugin body ──────────────────────────────────────────────────────

    /**
     * Register the Conversation tab.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'subagent-token-graph: dictionaries')

      // `connection`/`locale` come in through the plugin's inject list (see the
      // returned object below), so by the time apply runs they are served —
      // `ctx.get` cannot return undefined here.
      const connection = ctx.get('connection')
      const t = ctx.locale.bind(NS)

      // Jump to a subagent's own conversation — the same affordance the
      // reference fleet view exposes as a per-lane arrow. `uiWorkspace` is the
      // host's workspace service; a host that does not expose it just makes
      // the control inert rather than throwing.
      const openSession = (sessionId) => {
        try {
          const workspace = ctx.get('uiWorkspace')
          if (workspace !== undefined && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
          }
        } catch {
          // Navigation is a convenience: never let it break the graph.
        }
      }

      const callGraph = async (sessionId) => {
        if (connection === undefined) return null
        const result = await connection.rpc.call('/api', GRAPH_METHOD, { sessionId })
        if (!result.ok) {
          throw new Error(result.error && result.error.message ? result.error.message : 'the token graph request failed')
        }
        return result.value
      }

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'subagent-token-graph',
        order: 30,
        label: () => t('tab.label'),
        locale: NS,
        inject: () => ({ callGraph, t, openSession }),
      }, (slotProps) => h(GraphBoundary, { t }, h(TokenGraphView, slotProps))))

      // The stylesheet is inserted once, inside the plugin's own effect, so
      // unloading the plugin removes it again.
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-subagent-token-graph'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'subagent-token-graph: styles')
    }

    return { name: '@local/dsh-subagent-token-graph', inject: ['slots', 'locale', 'connection'], apply }
  },
})
