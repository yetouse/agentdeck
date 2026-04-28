import './styles.css'
import type { Agent, AgentStatus, LogEntry } from './types/agent'

// ── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_AGENTDECK_API_URL ?? 'http://127.0.0.1:4000'

// ── State ────────────────────────────────────────────────────────────────────

let agents: Agent[] = []
let liveLogs: Array<{ agentId: string; agentName: string; entry: LogEntry }> = []
let mode: 'live' | 'demo' | 'reconnecting' = 'demo'

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

// ── Render ───────────────────────────────────────────────────────────────────

function render(): void {
  const grid      = document.querySelector<HTMLDivElement>('#agent-grid')
  const count     = document.querySelector<HTMLSpanElement>('#agent-count')
  const statusBar = document.querySelector<HTMLDivElement>('#status-bar')
  const logFeed   = document.querySelector<HTMLDivElement>('#log-feed')
  const filter    = document.querySelector<HTMLSelectElement>('#log-filter')
  if (!grid || !count || !statusBar || !logFeed || !filter) return

  count.textContent = String(agents.length)

  const running = agents.filter(a => a.status === 'running').length
  const waiting = agents.filter(a => a.status === 'waiting').length
  const errors  = agents.filter(a => a.status === 'error').length
  const connBadge =
    mode === 'live'         ? '<span class="conn-badge conn-badge--live">● live</span>' :
    mode === 'reconnecting' ? '<span class="conn-badge conn-badge--offline">● reconnecting…</span>' :
                              '<span class="conn-badge conn-badge--demo">○ demo</span>'
  statusBar.innerHTML =
    `${connBadge}` +
    `<span><strong>${running}</strong> running</span>` +
    (waiting ? `<span><strong>${waiting}</strong> waiting</span>` : '') +
    (errors  ? `<span><strong>${errors}</strong> error${errors > 1 ? 's' : ''}</span>` : '')

  grid.innerHTML = agents.map(renderAgentCard).join('')

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
}

function renderAgentCard(agent: Agent): string {
  const modified = agent.metrics.filesModified.length
    ? agent.metrics.filesModified.map(f => `<li>${esc(f)}</li>`).join('')
    : '<li>No file changes yet</li>'

  return `
    <article class="agent-card agent-card--${agent.status}">
      <div class="agent-card__header">
        <h3>${esc(agent.name)}</h3>
        <span class="status status--${agent.status}">${agent.status}</span>
      </div>
      <p class="agent-card__task">${esc(agent.task)}</p>
      <dl class="metrics">
        <div><dt>Tokens</dt><dd>${agent.metrics.tokensUsed.toLocaleString()}</dd></div>
        <div><dt>Tools</dt><dd>${agent.metrics.toolCallsCount}</dd></div>
        <div><dt>Files</dt><dd>${agent.metrics.filesModified.length}</dd></div>
      </dl>
      <details>
        <summary>Modified files</summary>
        <ul>${modified}</ul>
      </details>
    </article>
  `
}

function renderLogLine({ agentName, entry }: { agentId: string; agentName: string; entry: LogEntry }): string {
  return `
    <div class="log-line log-line--${entry.level}">
      <time>${entry.timestamp.toLocaleTimeString()}</time>
      <span class="log-line__agent">${esc(agentName)}</span>
      <span class="log-line__level">${entry.level}</span>
      <span>${esc(entry.message)}</span>
    </div>
  `
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

// ── Init ─────────────────────────────────────────────────────────────────────

document.querySelector('#log-filter')?.addEventListener('change', render)

agents = makeDemoAgents()
render()
connect()
