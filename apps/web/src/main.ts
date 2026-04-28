import './styles.css'
import type { Agent, AgentStatus, LogEntry, Topology, TopologyEdge, TopologyNode } from './types/agent'

// ── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_AGENTDECK_API_URL ?? ''

// ── State ────────────────────────────────────────────────────────────────────

type LogStreamEntry = { agentId: string; agentName: string; entry: LogEntry }
type TabId = 'topology' | 'activity' | 'files' | 'control'

let agents: Agent[] = []
let liveLogs: LogStreamEntry[] = []
let mode: 'live' | 'demo' | 'reconnecting' = 'demo'
let selectedAgentId: string | null = null
let selectedTab: TabId = 'topology'
let activityScope: 'this' | 'all' = 'this'

// ── Wire types (ISO strings from JSON) ───────────────────────────────────────

interface WireLogEntry {
  timestamp: string
  level: LogEntry['level']
  message: string
  source?: string
}

interface WireTopology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  updatedAt: string
}

interface WireAgent {
  id: string
  name: string
  status: AgentStatus
  task: string
  startedAt: string | null
  updatedAt: string
  logs: WireLogEntry[]
  metrics: { tokensUsed: number; toolCallsCount: number; filesModified: string[]; durationMs: number }
  topology?: WireTopology
}

type WireEvent =
  | { type: 'agent:registered'; agent: WireAgent }
  | { type: 'agent:status';     agentId: string; status: AgentStatus }
  | { type: 'agent:log';        agentId: string; entry: WireLogEntry }
  | { type: 'tool:call';        agentId: string; tool: string; input: unknown }
  | { type: 'tool:result';      agentId: string; tool: string; output: unknown }
  | { type: 'session:end';      agentId: string; summary: { outcome: string } }

// ── Conversion ───────────────────────────────────────────────────────────────

function fromWireEntry(w: WireLogEntry): LogEntry {
  return { ...w, timestamp: new Date(w.timestamp) }
}

function fromWireTopology(w: WireTopology): Topology {
  return {
    nodes: w.nodes,
    edges: w.edges,
    updatedAt: new Date(w.updatedAt),
  }
}

function fromWireAgent(w: WireAgent): Agent {
  return {
    ...w,
    startedAt: w.startedAt ? new Date(w.startedAt) : null,
    updatedAt: new Date(w.updatedAt),
    logs: w.logs.map(fromWireEntry),
    topology: w.topology ? fromWireTopology(w.topology) : undefined,
  }
}

// ── Bridge ───────────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/agents`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { agents: WireAgent[] }
    agents = data.agents.map(fromWireAgent)
    liveLogs = []
    mode = 'live'
    render()
    listenSSE()
  } catch {
    if (mode !== 'demo') {
      agents = makeDemoAgents()
      mode = 'demo'
      render()
    }
    setTimeout(connect, 5000)
  }
}

function listenSSE(): void {
  const es = new EventSource(`${API_BASE}/api/events`)

  es.onmessage = (e: MessageEvent<string>) => {
    const ev = JSON.parse(e.data) as WireEvent
    applyEvent(ev)
    render()
  }

  es.onerror = () => {
    es.close()
    mode = 'reconnecting'
    render()
    setTimeout(connect, 3000)
  }
}

function pushLog(agentId: string, agentName: string, entry: LogEntry): void {
  liveLogs.push({ agentId, agentName, entry })
  if (liveLogs.length > 500) liveLogs = liveLogs.slice(-500)
}

function applyEvent(ev: WireEvent): void {
  switch (ev.type) {
    case 'agent:registered': {
      const agent = fromWireAgent(ev.agent)
      const i = agents.findIndex(a => a.id === agent.id)
      if (i >= 0) agents[i] = agent
      else agents.push(agent)
      break
    }
    case 'agent:status': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) { agent.status = ev.status; agent.updatedAt = new Date() }
      break
    }
    case 'agent:log': {
      const agent = agents.find(a => a.id === ev.agentId)
      const entry = fromWireEntry(ev.entry)
      if (agent) agent.logs.push(entry)
      pushLog(ev.agentId, agent?.name ?? ev.agentId, entry)
      break
    }
    case 'tool:call': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) { agent.metrics.toolCallsCount++; agent.updatedAt = new Date() }
      pushLog(ev.agentId, agent?.name ?? ev.agentId, {
        timestamp: new Date(),
        level: 'debug',
        message: `${ev.tool}(${JSON.stringify(ev.input)})`,
        source: 'tool:call',
      })
      break
    }
    case 'tool:result': {
      const agent = agents.find(a => a.id === ev.agentId)
      pushLog(ev.agentId, agent?.name ?? ev.agentId, {
        timestamp: new Date(),
        level: 'debug',
        message: `  ↳ ${ev.tool} → ${JSON.stringify(ev.output)}`,
        source: 'tool:result',
      })
      break
    }
    case 'session:end': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) {
        agent.status = ev.summary.outcome === 'success' ? 'done' : 'error'
        agent.updatedAt = new Date()
      }
      break
    }
  }
}

// ── Demo fallback ─────────────────────────────────────────────────────────────

function makeDemoAgents(): Agent[] {
  const START = Date.now() - 18 * 60 * 1000
  return [
    {
      id: 'claude-dev',
      name: 'Claude Dev',
      status: 'running',
      task: 'Implement the tmux session bridge',
      startedAt: new Date(START),
      updatedAt: new Date(),
      logs: [],
      metrics: {
        tokensUsed: 18420,
        toolCallsCount: 27,
        filesModified: ['apps/web/src/main.ts', 'docs/architecture.md'],
        durationMs: 18 * 60 * 1000,
      },
      topology: makeDemoTopology('claude-dev', 'Claude Dev'),
    },
    {
      id: 'reviewer',
      name: 'Review Agent',
      status: 'waiting',
      task: 'Waiting for the next diff to review',
      startedAt: null,
      updatedAt: new Date(),
      logs: [],
      metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
    },
    {
      id: 'tests',
      name: 'Test Runner',
      status: 'done',
      task: 'Run typecheck and smoke tests',
      startedAt: new Date(START),
      updatedAt: new Date(),
      logs: [],
      metrics: { tokensUsed: 1420, toolCallsCount: 5, filesModified: [], durationMs: 18 * 60 * 1000 },
    },
  ]
}

function makeDemoTopology(rootId: string, rootLabel: string): Topology {
  return {
    updatedAt: new Date(),
    nodes: [
      { id: rootId, label: rootLabel, kind: 'agent', status: 'running', observed: true, count: 27 },
      { id: 'ws:implementation', label: 'Implementation', kind: 'workstream', status: 'running', observed: false, count: 12, detail: 'patches in flight' },
      { id: 'ws:verification', label: 'Verification', kind: 'workstream', status: 'running', observed: false, count: 8, detail: 'typecheck pending' },
      { id: 'ws:deployment', label: 'Deployment', kind: 'workstream', status: 'idle', observed: false, count: 3, detail: 'queued' },
      { id: 'tool:implementation:patch', label: 'patch', kind: 'tool', status: 'running', observed: true, count: 5, detail: 'apply diff' },
      { id: 'tool:verification:npm', label: 'npm', kind: 'tool', status: 'idle', observed: true, count: 4, detail: 'run typecheck' },
      { id: 'file:apps/web/src/main.ts', label: 'apps/web/src/main.ts', kind: 'file', status: 'running', observed: true, detail: 'edited' },
    ],
    edges: [
      { from: rootId, to: 'ws:implementation' },
      { from: rootId, to: 'ws:verification' },
      { from: rootId, to: 'ws:deployment' },
      { from: 'ws:implementation', to: 'tool:implementation:patch' },
      { from: 'ws:verification', to: 'tool:verification:npm' },
      { from: 'ws:implementation', to: 'file:apps/web/src/main.ts' },
    ],
  }
}

const DEMO_LOGS: Array<{ agentId: string; agentName: string; entry: Omit<LogEntry, 'timestamp'> }> = [
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'info',  message: 'Session attached to tmux pane claude-dev:0.0' } },
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'debug', message: 'Read apps/web/src/types/agent.ts' } },
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'info',  message: 'Planning bridge event schema' } },
  { agentId: 'tests',      agentName: 'Test Runner',  entry: { level: 'info',  message: 'npm run typecheck completed successfully' } },
  { agentId: 'reviewer',   agentName: 'Review Agent', entry: { level: 'warn',  message: 'No active diff yet — standing by' } },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  if (diff < 10_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000)    return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, Math.max(1, n - 1)) + '…'
}

function isInactive(status: AgentStatus): boolean {
  return status === 'done' || status === 'error'
}

function canControlAgent(agent: Agent): boolean {
  return mode === 'live' && agent.id.startsWith('tmux:')
}

function visibleLogStream(): LogStreamEntry[] {
  if (mode === 'live' || mode === 'reconnecting') return liveLogs
  const now = new Date()
  return DEMO_LOGS.map(d => ({ agentId: d.agentId, agentName: d.agentName, entry: { ...d.entry, timestamp: now } }))
}

// ── Render ───────────────────────────────────────────────────────────────────

function preserveInputs(): Map<string, string> {
  const saved = new Map<string, string>()
  document.querySelectorAll<HTMLTextAreaElement>('.agent-controls__input').forEach(ta => {
    const card = ta.closest<HTMLElement>('[data-agent-id]')
    const id = card?.dataset['agentId']
    if (id) saved.set(id, ta.value)
  })
  return saved
}

function restoreInputs(saved: Map<string, string>): void {
  document.querySelectorAll<HTMLTextAreaElement>('.agent-controls__input').forEach(ta => {
    const card = ta.closest<HTMLElement>('[data-agent-id]')
    const id = card?.dataset['agentId']
    if (id) {
      const val = saved.get(id)
      if (val !== undefined) ta.value = val
    }
  })
}

function render(): void {
  const grid      = document.querySelector<HTMLDivElement>('#agent-grid')
  const count     = document.querySelector<HTMLSpanElement>('#agent-count')
  const statusBar = document.querySelector<HTMLDivElement>('#status-bar')
  if (!grid || !count || !statusBar) return

  const running = agents.filter(a => a.status === 'running').length
  const waiting = agents.filter(a => a.status === 'waiting').length
  const errors  = agents.filter(a => a.status === 'error').length
  const totalTokens = agents.reduce((s, a) => s + a.metrics.tokensUsed, 0)

  count.textContent = String(agents.length)

  const heroAgents  = document.querySelector<HTMLElement>('#hero-agents')
  const heroRunning = document.querySelector<HTMLElement>('#hero-running')
  const heroTokens  = document.querySelector<HTMLElement>('#hero-tokens')
  if (heroAgents)  heroAgents.textContent  = String(agents.length)
  if (heroRunning) heroRunning.textContent = String(running)
  if (heroTokens)  heroTokens.textContent  = fmtTokens(totalTokens)

  const connBadge =
    mode === 'live'         ? '<span class="conn-badge conn-badge--live">● live</span>' :
    mode === 'reconnecting' ? '<span class="conn-badge conn-badge--offline">● reconnecting…</span>' :
                              '<span class="conn-badge conn-badge--demo">○ demo</span>'

  statusBar.innerHTML =
    connBadge +
    (waiting ? `<span class="status-count"><strong>${waiting}</strong> waiting</span>` : '') +
    (errors  ? `<span class="status-count status-count--error"><strong>${errors}</strong> error${errors > 1 ? 's' : ''}</span>` : '')

  const saved = preserveInputs()
  grid.innerHTML = agents.map(renderAgentCard).join('')
  restoreInputs(saved)

  renderEventTicker()

  if (selectedAgentId && !agents.some(a => a.id === selectedAgentId)) {
    selectedAgentId = null
  }
  renderAgentDetail()
}

function renderAgentCard(agent: Agent): string {
  const durationMs = agent.startedAt
    ? Date.now() - agent.startedAt.getTime()
    : agent.metrics.durationMs

  const pulseDot = agent.status === 'running'
    ? '<span class="agent-pulse" aria-hidden="true"></span>'
    : ''

  const controls = canControlAgent(agent) ? renderAgentControls(agent) : ''

  const filesSection = agent.metrics.filesModified.length > 0
    ? `<details>
        <summary>${agent.metrics.filesModified.length} modified file${agent.metrics.filesModified.length !== 1 ? 's' : ''}</summary>
        <ul>${agent.metrics.filesModified.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      </details>`
    : ''

  return `
    <article class="agent-card agent-card--${agent.status}${selectedAgentId === agent.id ? ' agent-card--selected' : ''}" data-agent-id="${esc(agent.id)}" data-agent-name="${esc(agent.name)}" role="button" tabindex="0" aria-label="Open details for ${esc(agent.name)}">
      <div class="agent-card__header">
        <h3>${esc(agent.name)}</h3>
        <span class="status status--${agent.status}">${pulseDot}${agent.status}</span>
      </div>
      <div class="agent-card__id">${esc(agent.id)}</div>
      <p class="agent-card__task">${esc(agent.task)}</p>
      <dl class="metrics">
        <div><dt>Tokens</dt><dd>${fmtTokens(agent.metrics.tokensUsed)}</dd></div>
        <div><dt>Tools</dt><dd>${agent.metrics.toolCallsCount}</dd></div>
        <div><dt>Files</dt><dd>${agent.metrics.filesModified.length}</dd></div>
      </dl>
      <div class="agent-card__footer">
        <span class="agent-card__meta">${durationMs > 0 ? formatDuration(durationMs) : '—'}</span>
        <span class="agent-card__meta">${timeAgo(agent.updatedAt)}</span>
      </div>
      ${filesSection}
      ${controls}
    </article>
  `
}

function renderAgentControls(agent: Agent): string {
  const dis = isInactive(agent.status) ? ' disabled' : ''
  return `
    <div class="agent-controls">
      <textarea class="agent-controls__input" rows="2" placeholder="Send input to agent…"${dis}></textarea>
      <div class="agent-controls__row">
        <label><input type="checkbox" class="agent-controls__enter" checked> Enter</label>
        <button class="agent-control-send" data-id="${esc(agent.id)}"${dis}>Send</button>
        <button class="agent-control-stop" data-id="${esc(agent.id)}"${dis}>Stop</button>
      </div>
    </div>
  `
}

// ── Event ticker (compact dashboard strip) ───────────────────────────────────

function renderEventTicker(): void {
  const feed = document.querySelector<HTMLDivElement>('#event-ticker-feed')
  if (!feed) return

  const stream = visibleLogStream()
  const recent = stream.slice(-6).reverse()

  if (recent.length === 0) {
    feed.innerHTML = '<span class="event-ticker__empty">Waiting for the first signal…</span>'
    return
  }

  feed.innerHTML = recent.map(({ agentId, agentName, entry }) => {
    const time = entry.timestamp.toLocaleTimeString('en', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    return `
      <button type="button" class="event-ticker__line event-ticker__line--${entry.level}" data-agent-id="${esc(agentId)}">
        <span class="event-ticker__time">${time}</span>
        <span class="event-ticker__agent">${esc(agentName)}</span>
        <span class="event-ticker__msg">${esc(truncate(entry.message, 140))}</span>
      </button>`
  }).join('')
}

// ── Agent inspector (full-screen, tabbed) ────────────────────────────────────

function renderAgentDetail(): void {
  const shell = document.querySelector<HTMLElement>('#agent-detail-shell')
  const content = document.querySelector<HTMLElement>('#agent-detail-content')
  if (!shell || !content) return

  const agent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : null
  if (!agent) {
    shell.classList.remove('agent-detail-shell--open')
    shell.setAttribute('aria-hidden', 'true')
    content.innerHTML = ''
    return
  }

  const tabs: TabId[] = ['topology', 'activity', 'files']
  if (canControlAgent(agent)) tabs.push('control')
  const activeTab: TabId = tabs.includes(selectedTab) ? selectedTab : 'topology'

  shell.classList.add('agent-detail-shell--open')
  shell.setAttribute('aria-hidden', 'false')

  const saved = preserveInputs()
  content.innerHTML = `
    ${renderInspectorHeader(agent)}
    ${renderInspectorMetrics(agent)}
    ${renderInspectorTabs(tabs, activeTab, agent)}
    <div class="inspector__body">
      ${renderInspectorTabContent(activeTab, agent)}
    </div>
  `
  restoreInputs(saved)
}

function renderInspectorHeader(agent: Agent): string {
  const pulseDot = agent.status === 'running' ? '<span class="agent-pulse" aria-hidden="true"></span>' : ''
  const liveTag = agent.status === 'running'
    ? '<span class="inspector__live"><span class="inspector__live-dot" aria-hidden="true"></span>LIVE</span>'
    : ''
  return `
    <header class="inspector__header">
      <div class="inspector__title-block">
        <span class="inspector__eyebrow">Agent inspector</span>
        <div class="inspector__title-row">
          <h2 id="agent-detail-title">${esc(agent.name)}</h2>
          ${liveTag}
        </div>
        <div class="inspector__meta">
          <span class="status status--${agent.status}">${pulseDot}${agent.status}</span>
          <code title="${esc(agent.id)}">${esc(agent.id)}</code>
          <span class="inspector__meta-time">last update ${timeAgo(agent.updatedAt)}</span>
        </div>
        <p class="inspector__mission">${esc(agent.task)}</p>
      </div>
      <button class="inspector__close agent-detail__close" type="button" aria-label="Close agent detail">×</button>
    </header>`
}

function renderInspectorMetrics(agent: Agent): string {
  const durationMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : agent.metrics.durationMs
  const tiles: Array<[string, string, boolean]> = [
    ['Duration', durationMs > 0 ? formatDuration(durationMs) : '—', agent.status === 'running'],
    ['Updated', timeAgo(agent.updatedAt), false],
    ['Tokens', fmtTokens(agent.metrics.tokensUsed), false],
    ['Tool calls', String(agent.metrics.toolCallsCount), false],
    ['Files', String(agent.metrics.filesModified.length), false],
    ['Mode', mode, mode === 'live'],
  ]
  return `
    <section class="inspector__metrics">
      ${tiles.map(([label, value, live]) => `
        <div class="inspector__metric${live ? ' inspector__metric--live' : ''}">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
        </div>
      `).join('')}
    </section>`
}

function renderInspectorTabs(tabs: TabId[], active: TabId, agent: Agent): string {
  const labels: Record<TabId, string> = {
    topology: 'Topology',
    activity: 'Event Stream',
    files: 'Files',
    control: 'Control',
  }
  const counts: Partial<Record<TabId, number>> = {
    activity: agent.logs.length,
    files: agent.metrics.filesModified.length,
  }
  return `
    <nav class="inspector__tabs" role="tablist" aria-label="Agent inspector sections">
      ${tabs.map(tab => {
        const c = counts[tab]
        return `
          <button class="inspector__tab${tab === active ? ' inspector__tab--active' : ''}"
            role="tab" aria-selected="${tab === active}"
            data-tab="${tab}" type="button">
            <span>${labels[tab]}</span>
            ${typeof c === 'number' ? `<em>${c}</em>` : ''}
          </button>`
      }).join('')}
    </nav>`
}

function renderInspectorTabContent(tab: TabId, agent: Agent): string {
  switch (tab) {
    case 'topology': return renderTopologyTab(agent)
    case 'activity': return renderActivityTab(agent)
    case 'files':    return renderFilesTab(agent)
    case 'control':  return renderControlTab(agent)
  }
}

function renderTopologyTab(agent: Agent): string {
  return `
    <section class="inspector__panel inspector__panel--topology">
      <div class="inspector__panel-head">
        <div>
          <h3>Agent topology</h3>
          <p>${agent.topology
              ? `${agent.topology.nodes.length} node${agent.topology.nodes.length === 1 ? '' : 's'} · ${agent.topology.edges.length} link${agent.topology.edges.length === 1 ? '' : 's'} · refreshed ${timeAgo(agent.topology.updatedAt)}`
              : 'Waiting for activity from Hermes…'}</p>
        </div>
        <div class="inspector__legend">
          <span><i class="legend-dot legend-dot--observed"></i> observed</span>
          <span><i class="legend-dot legend-dot--inferred"></i> inferred</span>
        </div>
      </div>
      ${renderTopologyGraph(agent)}
    </section>`
}

function renderActivityTab(agent: Agent): string {
  const stream = visibleLogStream()
  const filtered = activityScope === 'all'
    ? stream
    : stream.filter(l => l.agentId === agent.id)
  const visible = filtered.slice(-200)

  return `
    <section class="inspector__panel inspector__panel--activity">
      <div class="inspector__panel-head">
        <div>
          <h3>Event stream</h3>
          <p>${visible.length} of ${filtered.length} event${filtered.length === 1 ? '' : 's'}${activityScope === 'all' ? ' across all agents' : ` from ${esc(agent.name)}`}</p>
        </div>
        <div class="inspector__panel-controls">
          <select id="activity-scope" class="panel__select" aria-label="Scope">
            <option value="this"${activityScope === 'this' ? ' selected' : ''}>This agent</option>
            <option value="all"${activityScope === 'all' ? ' selected' : ''}>All agents</option>
          </select>
        </div>
      </div>
      <div class="inspector__log-feed" role="log" aria-live="polite">
        ${visible.length
          ? visible.map(l => renderActivityLogLine(l, agent.id)).join('')
          : '<p class="agent-detail__empty">No events captured yet.</p>'}
      </div>
    </section>`
}

function renderActivityLogLine(l: LogStreamEntry, currentAgentId: string): string {
  const time = l.entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const own = l.agentId === currentAgentId ? ' inspector__log--own' : ''
  return `
    <div class="inspector__log inspector__log--${l.entry.level}${own}">
      <time>${time}</time>
      <span class="inspector__log-agent">${esc(l.agentName)}</span>
      <span class="inspector__log-level">${l.entry.level}</span>
      <p class="inspector__log-msg">${esc(l.entry.message)}</p>
    </div>`
}

function renderFilesTab(agent: Agent): string {
  const files = agent.metrics.filesModified
  return `
    <section class="inspector__panel inspector__panel--files">
      <div class="inspector__panel-head">
        <div>
          <h3>Modified files</h3>
          <p>${files.length} file${files.length === 1 ? '' : 's'} touched in this session.</p>
        </div>
      </div>
      ${files.length
        ? `<ul class="inspector__files">${files.map(f => `<li><span class="inspector__file-icon" aria-hidden="true"></span><code>${esc(f)}</code></li>`).join('')}</ul>`
        : '<p class="agent-detail__empty">No files modified yet.</p>'}
    </section>`
}

function renderControlTab(agent: Agent): string {
  const inactive = isInactive(agent.status)
  const dis = inactive ? ' disabled' : ''
  return `
    <section class="inspector__panel inspector__panel--control">
      <div class="inspector__panel-head">
        <div>
          <h3>Control</h3>
          <p>Send instructions or terminate the tmux session.</p>
        </div>
      </div>
      <div class="inspector__control" data-agent-id="${esc(agent.id)}" data-agent-name="${esc(agent.name)}">
        <textarea class="agent-controls__input" rows="6" placeholder="Send input to ${esc(agent.name)}…"${dis}></textarea>
        <div class="agent-controls__row">
          <label><input type="checkbox" class="agent-controls__enter" checked> Send Enter</label>
          <button class="agent-control-send" data-id="${esc(agent.id)}"${dis}>Send</button>
          <button class="agent-control-stop" data-id="${esc(agent.id)}"${dis}>Stop session</button>
        </div>
        ${inactive ? '<p class="agent-detail__empty">This session is no longer active.</p>' : ''}
      </div>
    </section>`
}

// ── Topology graph (dynamic, alive) ──────────────────────────────────────────

function deriveNodeActivity(node: TopologyNode, agent: Agent): string {
  if (node.detail) return truncate(node.detail, 56)
  if (node.kind === 'agent') {
    const last = agent.logs.length ? agent.logs[agent.logs.length - 1] : undefined
    if (last) return truncate(last.message, 56)
    if (agent.task) return truncate(agent.task, 56)
    return 'Awaiting activity'
  }
  if (typeof node.count === 'number' && node.count > 0) {
    return `${node.count} signal${node.count === 1 ? '' : 's'}`
  }
  if (node.kind === 'workstream') return 'Standing by'
  if (node.kind === 'tool')       return 'Idle'
  if (node.kind === 'file')       return 'Touched'
  return 'Awaiting'
}

function renderTopologyGraph(agent: Agent): string {
  const topology = agent.topology
  if (!topology || topology.nodes.length === 0) {
    return `
      <div class="topology-canvas topology-canvas--empty">
        <div class="topology-canvas__placeholder">
          <span class="agent-pulse" aria-hidden="true"></span>
          Topology will appear once Hermes emits tool activity.
        </div>
      </div>`
  }

  const root = topology.nodes.find(n => n.kind === 'agent') ?? topology.nodes[0]
  const workstreams = topology.nodes.filter(n => n.kind === 'workstream')
  const observed = topology.nodes.filter(n => n.kind === 'tool' || n.kind === 'file' || n.kind === 'event').slice(0, 18)

  const edgesByTarget = new Map<string, TopologyEdge[]>()
  for (const e of topology.edges) {
    const list = edgesByTarget.get(e.to) ?? []
    list.push(e)
    edgesByTarget.set(e.to, list)
  }

  const renderNode = (node: TopologyNode): string => {
    const live = node.status === 'running'
    const observedClass = node.observed ? ' t-node--observed' : ' t-node--inferred'
    const linked = edgesByTarget.has(node.id) ? ' t-node--linked' : ''
    const liveLabel = live ? 'LIVE' : (node.status === 'idle' || node.status === 'waiting' ? 'IDLE' : node.status.toUpperCase())
    const activity = deriveNodeActivity(node, agent)
    const counter = typeof node.count === 'number'
      ? `<span class="t-node__counter" title="signals"><span class="t-node__counter-dot" aria-hidden="true"></span>${node.count}</span>`
      : ''

    return `
      <div class="t-node t-node--${node.kind} t-node--${node.status}${observedClass}${linked}" data-node-id="${esc(node.id)}">
        <div class="t-node__top">
          <span class="t-node__kind">${esc(node.kind)}</span>
          <span class="t-node__live${live ? '' : ' t-node__live--idle'}">
            ${live ? '<span class="t-node__dot" aria-hidden="true"></span>' : ''}${liveLabel}
          </span>
        </div>
        <strong class="t-node__label" title="${esc(node.label)}">${esc(node.label)}</strong>
        <small class="t-node__activity">${esc(activity)}</small>
        <div class="t-node__foot">
          <span class="t-node__badge">${node.observed ? 'observed' : 'inferred'}</span>
          ${counter}
        </div>
      </div>`
  }

  return `
    <div class="topology-canvas" aria-label="Agent topology graph">
      <div class="topology-canvas__board">
        <div class="topology-canvas__beam" aria-hidden="true"></div>
        <div class="topology-canvas__grid">
          <div class="topology-tier topology-tier--root">
            <span class="topology-tier__label">Agent</span>
            <div class="topology-tier__body">
              ${root ? renderNode(root) : ''}
            </div>
          </div>
          <div class="topology-tier topology-tier--workstreams">
            <span class="topology-tier__label">Workstreams</span>
            <div class="topology-tier__body">
              ${workstreams.length
                ? workstreams.map(renderNode).join('')
                : '<p class="topology-tier__empty">No inferred workstreams yet.</p>'}
            </div>
          </div>
          <div class="topology-tier topology-tier--observed">
            <span class="topology-tier__label">Tools · Files · Events</span>
            <div class="topology-tier__body">
              ${observed.length
                ? observed.map(renderNode).join('')
                : '<p class="topology-tier__empty">No observed activity yet.</p>'}
            </div>
          </div>
        </div>
      </div>
    </div>`
}

function shouldIgnoreCardOpen(target: HTMLElement): boolean {
  return Boolean(target.closest('.agent-controls, button, input, textarea, select, details, summary, a'))
}

function openAgentDetail(agentId: string, tab?: TabId): void {
  if (!agentId) return
  selectedAgentId = agentId
  if (tab) selectedTab = tab
  render()
}

function closeAgentDetail(): void {
  if (!selectedAgentId) return
  selectedAgentId = null
  render()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Launch form ───────────────────────────────────────────────────────────────

interface LaunchResponse {
  sessionName?: string
  message?: string
  warning?: string
  error?: string
}

document.querySelector<HTMLFormElement>('#launch-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const task    = document.querySelector<HTMLInputElement>('#launch-task')?.value.trim() ?? ''
  const nameVal = document.querySelector<HTMLInputElement>('#launch-name')?.value.trim()
  const cwdVal  = document.querySelector<HTMLInputElement>('#launch-cwd')?.value.trim()
  const statusEl = document.querySelector<HTMLParagraphElement>('#launch-status')
  const btn      = document.querySelector<HTMLButtonElement>('.launch-form__btn')

  if (!statusEl || !btn) return

  statusEl.textContent = 'Launching…'
  statusEl.className = 'launch-form__status launch-form__status--pending'
  btn.disabled = true

  try {
    const res = await fetch(`${API_BASE}/api/agents/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        name: nameVal || undefined,
        cwd:  cwdVal  || undefined,
      }),
      signal: AbortSignal.timeout(12_000),
    })
    const data = await res.json() as LaunchResponse
    if (res.ok) {
      const warn = data.warning ? ` — ${data.warning}` : ''
      statusEl.textContent = `✓ ${data.message ?? 'Launched'}${warn}`
      statusEl.className = 'launch-form__status launch-form__status--ok'
    } else {
      statusEl.textContent = `✗ ${data.error ?? 'Launch failed'}`
      statusEl.className = 'launch-form__status launch-form__status--error'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error'
    statusEl.textContent = `✗ ${msg}`
    statusEl.className = 'launch-form__status launch-form__status--error'
  } finally {
    btn.disabled = false
  }
})

// ── Click delegation ─────────────────────────────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement

  if (target.closest('#agent-detail-backdrop, .agent-detail__close, .inspector__close')) {
    closeAgentDetail()
    return
  }

  const tabBtn = target.closest<HTMLButtonElement>('.inspector__tab')
  if (tabBtn) {
    const tab = tabBtn.dataset['tab'] as TabId | undefined
    if (tab && tab !== selectedTab) {
      selectedTab = tab
      renderAgentDetail()
    }
    return
  }

  const tickerLine = target.closest<HTMLButtonElement>('.event-ticker__line')
  if (tickerLine) {
    const id = tickerLine.dataset['agentId'] ?? ''
    if (id) openAgentDetail(id, 'activity')
    return
  }

  const ctlBtn = target.closest<HTMLButtonElement>('button.agent-control-send, button.agent-control-stop')
  if (ctlBtn) {
    if (ctlBtn.disabled) return

    const card = ctlBtn.closest<HTMLElement>('[data-agent-id]')
    if (!card) return
    const agentId = card.dataset['agentId'] ?? ''

    if (ctlBtn.classList.contains('agent-control-send')) {
      const textarea = card.querySelector<HTMLTextAreaElement>('.agent-controls__input')
      const enterCb  = card.querySelector<HTMLInputElement>('.agent-controls__enter')
      const text = textarea?.value ?? ''
      if (!text.trim()) return

      ctlBtn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, enter: enterCb?.checked ?? true }),
        signal: AbortSignal.timeout(5000),
      })
        .then(res => { if (res.ok && textarea) textarea.value = '' })
        .catch(() => { /* network error — user can retry */ })
        .finally(() => { ctlBtn.disabled = false })

    } else if (ctlBtn.classList.contains('agent-control-stop')) {
      const agentName = card.dataset['agentName'] ?? agentId
      if (!confirm(`Stop "${agentName}"?\n\nThis will kill the tmux session.`)) return

      ctlBtn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
        .catch(() => { /* network error */ })
        .finally(() => { ctlBtn.disabled = false })
    }
    return
  }

  const card = target.closest<HTMLElement>('#agent-grid [data-agent-id]')
  if (card && !shouldIgnoreCardOpen(target)) {
    openAgentDetail(card.dataset['agentId'] ?? '')
  }
})

document.querySelector<HTMLDivElement>('#agent-grid')?.addEventListener('keydown', (e: KeyboardEvent) => {
  const target = e.target as HTMLElement
  const card = target.closest<HTMLElement>('[data-agent-id]')
  if (!card || shouldIgnoreCardOpen(target)) return
  if (e.key !== 'Enter' && e.key !== ' ') return

  e.preventDefault()
  openAgentDetail(card.dataset['agentId'] ?? '')
})

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeAgentDetail()
})

document.addEventListener('change', (e: Event) => {
  const target = e.target as HTMLElement
  if (target.id === 'activity-scope' && target instanceof HTMLSelectElement) {
    activityScope = target.value === 'all' ? 'all' : 'this'
    renderAgentDetail()
  }
})

// ── Init ─────────────────────────────────────────────────────────────────────

agents = makeDemoAgents()
render()
connect()

// Keep "time ago" / duration tickers fresh while the inspector is open.
setInterval(() => {
  if (selectedAgentId) renderAgentDetail()
}, 5000)
