import './styles.css'
import type { Agent, AgentStatus, LogEntry, Topology, TopologyEdge, TopologyNode } from './types/agent'

// ── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_AGENTDECK_API_URL ?? ''
const CONNECT_RETRY_MS = 15_000
const SSE_RETRY_MS = 10_000
const CLOCK_RENDER_MS = 15_000

// ── State ────────────────────────────────────────────────────────────────────

type LogStreamEntry = { agentId: string; agentName: string; entry: LogEntry }
type TabId = 'topology' | 'activity' | 'files' | 'control'
type DashboardView = 'now' | 'system' | 'history'

let agents: Agent[] = []
let liveLogs: LogStreamEntry[] = []
let claudeTelemetry: ClaudeTelemetry | null = null
let claudeControl: ClaudeControl | null = null
let mode: 'live' | 'demo' | 'reconnecting' = 'demo'
let selectedAgentId: string | null = null
let selectedTab: TabId = 'topology'
let activityScope: 'this' | 'all' = 'this'
let dashboardView: DashboardView = 'now'

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

interface ClaudeTelemetryEvent {
  timestamp: string
  type: 'start' | 'wait' | 'blocked'
  printMode?: boolean
  cap?: number
  cappedOrAdded?: boolean
  argc?: number
  waitSeconds?: number
  reason?: string
  mode?: string
}

interface ClaudeTelemetry {
  source: string
  updatedAt: string
  launches1h: number
  waits1h: number
  capped1h: number
  totalWaitSeconds1h: number
  pressure: 'calm' | 'elevated' | 'high'
  recentEvents: ClaudeTelemetryEvent[]
}

interface ClaudeControl {
  mode: 'normal' | 'economy' | 'strict'
  paused: boolean
  maxTurnsCap: number
  minStartIntervalSeconds: number
  updatedAt: string
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

async function fetchClaudeTelemetry(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/claude/telemetry`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { telemetry: ClaudeTelemetry }
    claudeTelemetry = data.telemetry
  } catch {
    claudeTelemetry = null
  }
}

async function fetchClaudeControl(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/claude/control`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { control: ClaudeControl }
    claudeControl = data.control
  } catch {
    claudeControl = null
  }
}

async function updateClaudeControl(patch: Partial<Pick<ClaudeControl, 'mode' | 'paused'>>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/claude/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { control: ClaudeControl }
  claudeControl = data.control
}

async function connect(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/agents`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { agents: WireAgent[] }
    agents = data.agents.map(fromWireAgent)
    await Promise.all([fetchClaudeTelemetry(), fetchClaudeControl()])
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
    setTimeout(connect, CONNECT_RETRY_MS)
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
    setTimeout(connect, SSE_RETRY_MS)
  }
}

function pushLog(agentId: string, agentName: string, entry: LogEntry): void {
  liveLogs.push({ agentId, agentName, entry })
  if (liveLogs.length > 500) liveLogs = liveLogs.slice(-500)
}

function logSignature(agentId: string, entry: LogEntry): string {
  return `${agentId}|${entry.timestamp.getTime()}|${entry.level}|${entry.message}`
}

function redactPreviewText(raw: string): string {
  return raw
    .replace(/(?:Bearer|Authorization|api[_-]?key|password|passwd|secret|token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[REDACTED]')
}

function safeJSONPreview(value: unknown, max = 160): string {
  let s: string
  try { s = JSON.stringify(value) ?? '' }
  catch { return '[unserializable]' }
  s = redactPreviewText(s)
  if (s.length <= max) return s
  return s.slice(0, Math.max(1, max - 1)) + '…'
}

function applyEvent(ev: WireEvent): void {
  switch (ev.type) {
    case 'agent:registered': {
      const agent = fromWireAgent(ev.agent)
      const i = agents.findIndex(a => a.id === agent.id)
      const prevSigs = i >= 0
        ? new Set(agents[i]!.logs.map(e => logSignature(agent.id, e)))
        : new Set<string>()
      if (i >= 0) agents[i] = agent
      else agents.push(agent)
      // Hermes broadcasts updated snapshots rather than per-line agent:log events,
      // so diff against the previous snapshot and surface new entries in liveLogs.
      for (const entry of agent.logs) {
        if (!prevSigs.has(logSignature(agent.id, entry))) {
          pushLog(agent.id, agent.name, entry)
        }
      }
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
        message: `${ev.tool}(${safeJSONPreview(ev.input)})`,
        source: 'tool:call',
      })
      break
    }
    case 'tool:result': {
      const agent = agents.find(a => a.id === ev.agentId)
      pushLog(ev.agentId, agent?.name ?? ev.agentId, {
        timestamp: new Date(),
        level: 'debug',
        message: `  ↳ ${ev.tool} → ${safeJSONPreview(ev.output)}`,
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

// ── Agent classification ─────────────────────────────────────────────────────

const SYSTEM_AGENT_IDS = new Set([
  'hermes-gateway',
  'hermes-dashboard',
  'hermes-sessions',
  'hermes-error',
])

const TMUX_SENTINEL_IDS = new Set([
  'tmux:no-sessions',
  'tmux:error',
])

const RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 1000
const ACTIVITY_NOW_WINDOW_MS = 30 * 60 * 1000

function isSystemAgent(agent: Agent): boolean {
  if (SYSTEM_AGENT_IDS.has(agent.id)) return true
  if (TMUX_SENTINEL_IDS.has(agent.id)) return true
  return false
}

function isProjectAgent(agent: Agent): boolean {
  if (isSystemAgent(agent)) return false
  if (agent.id === 'hermes-development') return true
  if (agent.id.startsWith('hermes-session-') || agent.id.startsWith('hermes-session:')) return true
  if (agent.id.startsWith('tmux:')) return true
  // Anything not classified as system is treated as project work by default.
  return true
}

function isRecentlyActive(agent: Agent): boolean {
  if (agent.status === 'running' || agent.status === 'waiting') return true
  return Date.now() - agent.updatedAt.getTime() < RECENT_ACTIVITY_WINDOW_MS
}

function latestAgentSignal(agent: Agent): LogEntry | undefined {
  return agent.logs.length ? agent.logs[agent.logs.length - 1] : undefined
}

function recentAgentSignals(agent: Agent, max = 4): LogEntry[] {
  return agent.logs.slice(-max).reverse()
}

function hasFreshDevelopmentSignal(agent: Agent): boolean {
  if (!isProjectAgent(agent)) return false
  const latest = latestAgentSignal(agent)
  if (!latest) return agent.status === 'running'
  return agent.status === 'running' && Date.now() - latest.timestamp.getTime() < 2 * 60 * 1000
}

function visibleAgents(view: DashboardView): Agent[] {
  switch (view) {
    case 'now':
      return agents
        .filter(a => isProjectAgent(a) && isRecentlyActive(a))
        .sort(byActivityDesc)
    case 'system':
      return agents
        .filter(isSystemAgent)
        .sort((a, b) => a.name.localeCompare(b.name))
    case 'history':
      return agents
        .filter(a => !isSystemAgent(a) && !(isProjectAgent(a) && isRecentlyActive(a)))
        .sort(byActivityDesc)
  }
}

function byActivityDesc(a: Agent, b: Agent): number {
  // Running first, then most recently updated
  const aRun = a.status === 'running' ? 1 : 0
  const bRun = b.status === 'running' ? 1 : 0
  if (aRun !== bRun) return bRun - aRun
  return b.updatedAt.getTime() - a.updatedAt.getTime()
}

// ── Activity merge ───────────────────────────────────────────────────────────

function mergedRecentActivity(): LogStreamEntry[] {
  if (mode === 'demo') return visibleLogStream().slice().reverse()

  const seen = new Set<string>()
  const all: LogStreamEntry[] = []

  for (const agent of agents) {
    if (!agent.logs.length) continue
    // Take the tail of agent.logs to bound work on large snapshots.
    const tail = agent.logs.length > 60 ? agent.logs.slice(-60) : agent.logs
    for (const entry of tail) {
      const key = logSignature(agent.id, entry)
      if (seen.has(key)) continue
      seen.add(key)
      all.push({ agentId: agent.id, agentName: agent.name, entry })
    }
  }

  for (const log of liveLogs) {
    const key = logSignature(log.agentId, log.entry)
    if (seen.has(key)) continue
    seen.add(key)
    all.push(log)
  }

  return all.sort((a, b) => b.entry.timestamp.getTime() - a.entry.timestamp.getTime())
}

function getActivityNowLogs(agents: Agent[]): LogStreamEntry[] {
  const cutoff = Date.now() - ACTIVITY_NOW_WINDOW_MS
  return mergedRecentActivity()
    .filter(l => {
      const agent = agents.find(a => a.id === l.agentId)
      return (!agent || isProjectAgent(agent)) && l.entry.timestamp.getTime() >= cutoff
    })
    .sort((a, b) => b.entry.timestamp.getTime() - a.entry.timestamp.getTime())
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

  const waiting = agents.filter(a => a.status === 'waiting').length
  const errors  = agents.filter(a => a.status === 'error').length

  const nowAgents     = visibleAgents('now')
  const systemAgents  = visibleAgents('system')
  const historyAgents = visibleAgents('history')
  const activeRunning = nowAgents.filter(a => a.status === 'running').length
  const recentSignals = getActivityNowLogs(agents).length

  const heroActive  = document.querySelector<HTMLElement>('#hero-active')
  const heroSystem  = document.querySelector<HTMLElement>('#hero-system')
  const heroSignals = document.querySelector<HTMLElement>('#hero-signals')
  if (heroActive)  heroActive.textContent  = String(nowAgents.length || activeRunning)
  if (heroSystem)  heroSystem.textContent  = String(systemAgents.length)
  if (heroSignals) heroSignals.textContent = String(recentSignals)

  const connBadge =
    mode === 'live'         ? '<span class="conn-badge conn-badge--live">● live</span>' :
    mode === 'reconnecting' ? '<span class="conn-badge conn-badge--offline">● reconnecting…</span>' :
                              '<span class="conn-badge conn-badge--demo">○ demo</span>'

  statusBar.innerHTML =
    connBadge +
    (waiting ? `<span class="status-count"><strong>${waiting}</strong> waiting</span>` : '') +
    (errors  ? `<span class="status-count status-count--error"><strong>${errors}</strong> error${errors > 1 ? 's' : ''}</span>` : '')

  // Dashboard nav state and counts
  const navCounts: Record<DashboardView, number> = {
    now: nowAgents.length,
    system: systemAgents.length,
    history: historyAgents.length,
  }
  for (const view of ['now', 'system', 'history'] as const) {
    const btn = document.querySelector<HTMLButtonElement>(`#dashboard-view-${view}`)
    if (!btn) continue
    btn.classList.toggle('dashboard-nav__btn--active', dashboardView === view)
    btn.setAttribute('aria-selected', dashboardView === view ? 'true' : 'false')
    const c = btn.querySelector<HTMLElement>('em')
    if (c) c.textContent = String(navCounts[view])
  }

  const visible = visibleAgents(dashboardView)
  count.textContent = String(visible.length)

  const saved = preserveInputs()
  grid.innerHTML = visible.length
    ? visible.map(renderAgentCard).join('')
    : `<p class="agent-grid__empty">${esc(emptyDashboardMessage(dashboardView))}</p>`
  restoreInputs(saved)

  renderActivityNow()
  renderClaudePressure()
  renderEventTicker()

  if (selectedAgentId && !agents.some(a => a.id === selectedAgentId)) {
    selectedAgentId = null
  }
  renderAgentDetail()
}

function emptyDashboardMessage(view: DashboardView): string {
  switch (view) {
    case 'now':     return 'No active project work right now. Ask Hermes to continue development to populate this view.'
    case 'system':  return 'No system processes registered.'
    case 'history': return 'No idle or completed agents yet.'
  }
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

  const recentSignals = recentAgentSignals(agent)
  const latestSection = recentSignals.length > 0
    ? `<div class="agent-card__latest">
        <span>Live trail</span>
        <ol class="agent-card__trail">
          ${recentSignals.map(entry => `
            <li class="agent-card__trail-line agent-card__trail-line--${entry.level}">
              <time>${entry.timestamp.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              <span>${esc(truncate(entry.message, 120))}</span>
            </li>`).join('')}
        </ol>
      </div>`
    : ''

  const activeSignalClass = hasFreshDevelopmentSignal(agent) ? ' agent-card--activity-signal' : ''

  return `
    <article class="agent-card agent-card--${agent.status}${selectedAgentId === agent.id ? ' agent-card--selected' : ''}${activeSignalClass}" data-agent-id="${esc(agent.id)}" data-agent-name="${esc(agent.name)}" role="button" tabindex="0" aria-label="Open details for ${esc(agent.name)}">
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
      ${latestSection}
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

// ── Claude Code pressure ─────────────────────────────────────────────────────

function pressureLabel(pressure: ClaudeTelemetry['pressure']): string {
  switch (pressure) {
    case 'calm':     return 'calme'
    case 'elevated': return 'élevée'
    case 'high':     return 'haute'
  }
}

function renderClaudeEvent(event: ClaudeTelemetryEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const body = event.type === 'wait'
    ? `attente ${event.waitSeconds ?? 0}s · ${event.reason ?? 'cooldown'}`
    : event.type === 'blocked'
      ? `bloqué · ${event.mode ?? 'pause'} · ${event.reason ?? 'agentdeck_pause'}`
      : `lancement · cap ${event.cap ?? '—'}${event.cappedOrAdded ? ' · cap appliqué' : ''}`
  return `<li><time>${time}</time><span>${esc(body)}</span></li>`
}

function claudeModeLabel(modeName: ClaudeControl['mode']): string {
  switch (modeName) {
    case 'normal':  return 'Normal'
    case 'economy': return 'Économie'
    case 'strict':  return 'Strict'
  }
}

function renderClaudeControls(): string {
  if (!claudeControl) {
    return '<p class="claude-pressure__note">Contrôle Claude Code indisponible.</p>'
  }

  const c = claudeControl
  const modes: ClaudeControl['mode'][] = ['normal', 'economy', 'strict']
  return `
    <div class="claude-control" aria-label="Contrôle Claude Code">
      <div class="claude-control__summary">
        <span>Mode ${claudeModeLabel(c.mode)}</span>
        <span>max-turns ≤ ${c.maxTurnsCap}</span>
        <span>pause min. ${formatDuration(c.minStartIntervalSeconds * 1000)}</span>
        <span>${c.paused ? 'lancements suspendus' : 'lancements autorisés'}</span>
      </div>
      <div class="claude-control__actions">
        ${modes.map(m => `
          <button type="button" class="claude-control__btn${m === c.mode ? ' claude-control__btn--active' : ''}" data-claude-mode="${m}" ${m === c.mode ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${claudeModeLabel(m)}</button>`).join('')}
        <button type="button" class="claude-control__btn claude-control__btn--pause${c.paused ? ' claude-control__btn--active' : ''}" data-claude-paused="${c.paused ? '0' : '1'}">${c.paused ? 'Reprendre' : 'Pause IA'}</button>
      </div>
    </div>`
}

function renderClaudePressure(): void {
  const panel = document.querySelector<HTMLDivElement>('#claude-pressure')
  if (!panel) return

  if (!claudeTelemetry) {
    panel.innerHTML = `
      <div class="claude-pressure__head">
        <div><span class="claude-pressure__eyebrow">Claude Code</span><strong>Pression inconnue</strong></div>
        <span class="pressure-pill pressure-pill--unknown">hors ligne</span>
      </div>
      ${renderClaudeControls()}
      <p class="claude-pressure__note">La télémétrie locale du throttle n’est pas encore disponible.</p>`
    return
  }

  const t = claudeTelemetry
  const events = t.recentEvents.slice(0, 4)
  const statusText = claudeControl?.paused ? 'Lancements en pause' : `Pression ${pressureLabel(t.pressure)}`
  panel.innerHTML = `
    <div class="claude-pressure__head">
      <div>
        <span class="claude-pressure__eyebrow">Claude Code</span>
        <strong>${statusText}</strong>
      </div>
      <span class="pressure-pill pressure-pill--${claudeControl?.paused ? 'unknown' : t.pressure}">${claudeControl?.paused ? 'paused' : t.pressure}</span>
    </div>
    ${renderClaudeControls()}
    <dl class="claude-pressure__metrics">
      <div><dt>Lancements 1h</dt><dd>${t.launches1h}</dd></div>
      <div><dt>Attentes</dt><dd>${t.waits1h}</dd></div>
      <div><dt>Caps appliqués</dt><dd>${t.capped1h}</dd></div>
      <div><dt>Cooldown</dt><dd>${formatDuration(t.totalWaitSeconds1h * 1000)}</dd></div>
    </dl>
    ${events.length ? `<ol class="claude-pressure__events">${events.map(renderClaudeEvent).join('')}</ol>` : '<p class="claude-pressure__note">Aucun lancement récent observé.</p>'}
    <p class="claude-pressure__note">Mis à jour ${timeAgo(new Date(t.updatedAt))} · source locale sanitisée</p>`
}

// ── Activity Now (primary live signals strip) ────────────────────────────────

function renderActivityNow(): void {
  const feed = document.querySelector<HTMLDivElement>('#activity-now-feed')
  if (!feed) return

  const recent = getActivityNowLogs(agents).slice(0, 8)

  if (recent.length === 0) {
    feed.innerHTML = `
      <div class="activity-now__head">
        <span class="activity-now__label">Activity Now</span>
        <span class="activity-now__hint">Waiting for a fresh signal — ask Hermes to continue and live activity will appear here.</span>
      </div>`
    return
  }

  feed.innerHTML = `
    <div class="activity-now__head">
      <span class="activity-now__label">
        <span class="activity-now__dot" aria-hidden="true"></span>
        Activity Now
      </span>
      <span class="activity-now__hint">${recent.length} recent signal${recent.length === 1 ? '' : 's'} · open an agent for the full event stream</span>
    </div>
    <ul class="activity-now__list" role="log" aria-live="polite">
      ${recent.map(renderActivityNowLine).join('')}
    </ul>`
}

function renderActivityNowLine(l: LogStreamEntry): string {
  const time = l.entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return `
    <li>
      <button type="button" class="activity-now__item activity-now__item--${l.entry.level}" data-agent-id="${esc(l.agentId)}">
        <span class="activity-now__time">${time}</span>
        <span class="activity-now__agent">${esc(l.agentName)}</span>
        <span class="activity-now__msg">${esc(truncate(l.entry.message, 160))}</span>
      </button>
    </li>`
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

  const activityItem = target.closest<HTMLButtonElement>('.activity-now__item')
  if (activityItem) {
    const id = activityItem.dataset['agentId'] ?? ''
    if (id) openAgentDetail(id, 'activity')
    return
  }

  const navBtn = target.closest<HTMLButtonElement>('.dashboard-nav__btn')
  if (navBtn) {
    const view = navBtn.dataset['view'] as DashboardView | undefined
    if (view && view !== dashboardView) {
      dashboardView = view
      render()
    }
    return
  }

  const claudeModeBtn = target.closest<HTMLButtonElement>('button[data-claude-mode]')
  if (claudeModeBtn) {
    const nextMode = claudeModeBtn.dataset['claudeMode'] as ClaudeControl['mode'] | undefined
    if (!nextMode || claudeModeBtn.disabled) return
    claudeModeBtn.disabled = true
    updateClaudeControl({ mode: nextMode })
      .then(renderClaudePressure)
      .catch(() => { /* keep current safe state */ })
      .finally(() => { claudeModeBtn.disabled = false })
    return
  }

  const claudePauseBtn = target.closest<HTMLButtonElement>('button[data-claude-paused]')
  if (claudePauseBtn) {
    if (claudePauseBtn.disabled) return
    const paused = claudePauseBtn.dataset['claudePaused'] === '1'
    claudePauseBtn.disabled = true
    updateClaudeControl({ paused })
      .then(renderClaudePressure)
      .catch(() => { /* keep current safe state */ })
      .finally(() => { claudePauseBtn.disabled = false })
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

// Keep "time ago" / duration tickers and local Claude pressure fresh.
setInterval(() => {
  if (mode === 'live') {
    Promise.all([fetchClaudeTelemetry(), fetchClaudeControl()])
      .then(renderClaudePressure)
      .catch(() => { /* already handled in fetch helpers */ })
  }
  if (selectedAgentId) renderAgentDetail()
}, CLOCK_RENDER_MS)
