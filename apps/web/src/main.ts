import './styles.css'
import type { Agent, AgentStatus, LogEntry } from './types/agent'

// ── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_AGENTDECK_API_URL ?? ''

// ── State ────────────────────────────────────────────────────────────────────

let agents: Agent[] = []
let liveLogs: Array<{ agentId: string; agentName: string; entry: LogEntry }> = []
let mode: 'live' | 'demo' | 'reconnecting' = 'demo'
let selectedAgentId: string | null = null

// ── Wire types (ISO strings from JSON) ───────────────────────────────────────

interface WireLogEntry {
  timestamp: string
  level: LogEntry['level']
  message: string
  source?: string
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

function fromWireAgent(w: WireAgent): Agent {
  return {
    ...w,
    startedAt: w.startedAt ? new Date(w.startedAt) : null,
    updatedAt: new Date(w.updatedAt),
    logs: w.logs.map(fromWireEntry),
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
  const logFeed   = document.querySelector<HTMLDivElement>('#log-feed')
  const filter    = document.querySelector<HTMLSelectElement>('#log-filter')
  if (!grid || !count || !statusBar || !logFeed || !filter) return

  const running = agents.filter(a => a.status === 'running').length
  const waiting = agents.filter(a => a.status === 'waiting').length
  const errors  = agents.filter(a => a.status === 'error').length
  const totalTokens = agents.reduce((s, a) => s + a.metrics.tokensUsed, 0)

  count.textContent = String(agents.length)

  // Hero metrics
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

  const prev = filter.value
  filter.innerHTML = '<option value="all">All agents</option>' +
    agents.map(a => `<option value="${esc(a.id)}"${a.id === prev ? ' selected' : ''}>${esc(a.name)}</option>`).join('')

  const now = new Date()
  const source: Array<{ agentId: string; agentName: string; entry: LogEntry }> =
    mode === 'live' || mode === 'reconnecting'
      ? liveLogs
      : DEMO_LOGS.map(d => ({ ...d, entry: { ...d.entry, timestamp: now } }))

  const visible = filter.value === 'all'
    ? source
    : source.filter(l => l.agentId === filter.value)

  const atBottom = logFeed.scrollHeight - logFeed.scrollTop <= logFeed.clientHeight + 40
  logFeed.innerHTML = visible.slice(-200).map(renderLogLine).join('')
  if (atBottom) logFeed.scrollTop = logFeed.scrollHeight

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

  const controls = mode === 'live' && agent.id.startsWith('tmux:')
    ? renderAgentControls(agent)
    : ''

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
  const inactive = agent.status === 'done' || agent.status === 'error'
  const dis = inactive ? ' disabled' : ''
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

function renderLogLine({ agentName, entry }: { agentId: string; agentName: string; entry: LogEntry }): string {
  const time = entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return `
    <div class="log-line log-line--${entry.level}">
      <time>${time}</time>
      <span class="log-line__agent">${esc(agentName)}</span>
      <span class="log-line__level">${entry.level}</span>
      <span class="log-line__msg">${esc(entry.message)}</span>
    </div>
  `
}

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

  const durationMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : agent.metrics.durationMs
  const logs = getAgentLogsForDetail(agent)
  const files = agent.metrics.filesModified.length
    ? agent.metrics.filesModified.map(f => `<li>${esc(f)}</li>`).join('')
    : '<li>No modified files yet</li>'
  const controls = mode === 'live' && agent.id.startsWith('tmux:') ? renderAgentControls(agent) : ''

  shell.classList.add('agent-detail-shell--open')
  shell.setAttribute('aria-hidden', 'false')
  content.innerHTML = `
    <div class="agent-detail__header">
      <div>
        <span class="agent-detail__eyebrow">Agent inspector</span>
        <h2 id="agent-detail-title">${esc(agent.name)}</h2>
      </div>
      <button class="agent-detail__close" type="button" aria-label="Close agent detail">×</button>
    </div>

    <div class="agent-detail__status-row">
      <span class="status status--${agent.status}">${agent.status === 'running' ? '<span class="agent-pulse" aria-hidden="true"></span>' : ''}${agent.status}</span>
      <code>${esc(agent.id)}</code>
    </div>

    <section class="agent-detail__section">
      <h3>Mission</h3>
      <p class="agent-detail__task">${esc(agent.task)}</p>
    </section>

    <section class="agent-detail__metrics">
      <div><span>Duration</span><strong>${durationMs > 0 ? formatDuration(durationMs) : '—'}</strong></div>
      <div><span>Updated</span><strong>${timeAgo(agent.updatedAt)}</strong></div>
      <div><span>Tokens</span><strong>${fmtTokens(agent.metrics.tokensUsed)}</strong></div>
      <div><span>Tools</span><strong>${agent.metrics.toolCallsCount}</strong></div>
      <div><span>Files</span><strong>${agent.metrics.filesModified.length}</strong></div>
      <div><span>Mode</span><strong>${mode}</strong></div>
    </section>

    ${controls ? `<section class="agent-detail__section agent-detail__controls"><h3>Control</h3>${controls}</section>` : ''}

    <section class="agent-detail__section agent-detail__logs-section">
      <h3>Recent logs</h3>
      <div class="agent-detail__logs">
        ${logs.length ? logs.slice(-80).map(entry => renderDetailLogLine(entry)).join('') : '<p class="agent-detail__empty">No logs captured yet.</p>'}
      </div>
    </section>

    <section class="agent-detail__section">
      <h3>Modified files</h3>
      <ul class="agent-detail__files">${files}</ul>
    </section>
  `
}

function getAgentLogsForDetail(agent: Agent): LogEntry[] {
  if (agent.logs.length > 0) return agent.logs
  if (mode === 'demo') {
    const now = new Date()
    return DEMO_LOGS
      .filter(d => d.agentId === agent.id)
      .map(d => ({ ...d.entry, timestamp: now }))
  }
  return []
}

function renderDetailLogLine(entry: LogEntry): string {
  const time = entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return `
    <div class="agent-detail-log agent-detail-log--${entry.level}">
      <time>${time}</time>
      <span>${entry.level}</span>
      <p>${esc(entry.message)}</p>
    </div>
  `
}

function shouldIgnoreCardOpen(target: HTMLElement): boolean {
  return Boolean(target.closest('.agent-controls, button, input, textarea, select, details, summary, a'))
}

function openAgentDetail(agentId: string): void {
  if (!agentId) return
  selectedAgentId = agentId
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

// ── Agent controls + inspector ───────────────────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement

  if (target.closest('#agent-detail-backdrop, .agent-detail__close')) {
    closeAgentDetail()
    return
  }

  const btn = target.closest<HTMLButtonElement>('button.agent-control-send, button.agent-control-stop')
  if (btn) {
    if (btn.disabled) return

    const card = btn.closest<HTMLElement>('[data-agent-id]')
    if (!card) return
    const agentId = card.dataset['agentId'] ?? ''

    if (btn.classList.contains('agent-control-send')) {
      const textarea = card.querySelector<HTMLTextAreaElement>('.agent-controls__input')
      const enterCb  = card.querySelector<HTMLInputElement>('.agent-controls__enter')
      const text = textarea?.value ?? ''
      if (!text.trim()) return

      btn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, enter: enterCb?.checked ?? true }),
        signal: AbortSignal.timeout(5000),
      })
        .then(res => { if (res.ok && textarea) textarea.value = '' })
        .catch(() => { /* network error — user can retry */ })
        .finally(() => { btn.disabled = false })

    } else if (btn.classList.contains('agent-control-stop')) {
      const agentName = card.dataset['agentName'] ?? agentId
      if (!confirm(`Stop "${agentName}"?\n\nThis will kill the tmux session.`)) return

      btn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
        .catch(() => { /* network error */ })
        .finally(() => { btn.disabled = false })
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

// ── Init ─────────────────────────────────────────────────────────────────────

document.querySelector('#log-filter')?.addEventListener('change', render)

agents = makeDemoAgents()
render()
connect()
