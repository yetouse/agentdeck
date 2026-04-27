import './styles.css'
import type { Agent, AgentStatus, LogEntry } from './types/agent'

const agents: Agent[] = [
  makeAgent('claude-dev', 'Claude Dev', 'running', 'Implement the tmux session bridge'),
  makeAgent('reviewer', 'Review Agent', 'waiting', 'Waiting for the next diff to review'),
  makeAgent('tests', 'Test Runner', 'done', 'Run typecheck and smoke tests'),
]

const sampleLogs: Array<{ agentId: string; entry: LogEntry }> = [
  log('claude-dev', 'info', 'Session attached to tmux pane claude-dev:0.0'),
  log('claude-dev', 'debug', 'Read apps/web/src/types/agent.ts'),
  log('claude-dev', 'info', 'Planning bridge event schema'),
  log('tests', 'info', 'npm run typecheck completed successfully'),
  log('reviewer', 'warn', 'No active diff yet — standing by'),
]

function makeAgent(id: string, name: string, status: AgentStatus, task: string): Agent {
  return {
    id,
    name,
    status,
    task,
    startedAt: status === 'waiting' ? null : new Date(Date.now() - 1000 * 60 * 18),
    updatedAt: new Date(),
    logs: [],
    metrics: {
      tokensUsed: id === 'claude-dev' ? 18420 : id === 'tests' ? 1420 : 0,
      toolCallsCount: id === 'claude-dev' ? 27 : id === 'tests' ? 5 : 0,
      filesModified: id === 'claude-dev' ? ['apps/web/src/main.ts', 'docs/architecture.md'] : [],
      durationMs: id === 'reviewer' ? 0 : 1000 * 60 * 18,
    },
  }
}

function log(agentId: string, level: LogEntry['level'], message: string) {
  return { agentId, entry: { timestamp: new Date(), level, message, source: agentId } }
}

function render() {
  const grid = document.querySelector<HTMLDivElement>('#agent-grid')
  const count = document.querySelector<HTMLSpanElement>('#agent-count')
  const statusBar = document.querySelector<HTMLDivElement>('#status-bar')
  const logFeed = document.querySelector<HTMLDivElement>('#log-feed')
  const filter = document.querySelector<HTMLSelectElement>('#log-filter')

  if (!grid || !count || !statusBar || !logFeed || !filter) return

  count.textContent = String(agents.length)
  statusBar.innerHTML = `
    <span><strong>${agents.filter((a) => a.status === 'running').length}</strong> running</span>
    <span><strong>${agents.filter((a) => a.status === 'waiting').length}</strong> waiting</span>
    <span><strong>${agents.filter((a) => a.status === 'done').length}</strong> done</span>
  `

  filter.innerHTML = '<option value="all">All agents</option>' + agents
    .map((agent) => `<option value="${agent.id}">${agent.name}</option>`)
    .join('')

  grid.innerHTML = agents.map(renderAgentCard).join('')
  logFeed.innerHTML = sampleLogs.map(renderLogLine).join('')

  filter.addEventListener('change', () => {
    const agentId = filter.value
    logFeed.innerHTML = sampleLogs
      .filter((item) => agentId === 'all' || item.agentId === agentId)
      .map(renderLogLine)
      .join('')
  })
}

function renderAgentCard(agent: Agent) {
  const modified = agent.metrics.filesModified.length
    ? agent.metrics.filesModified.map((file) => `<li>${file}</li>`).join('')
    : '<li>No file changes yet</li>'

  return `
    <article class="agent-card agent-card--${agent.status}">
      <div class="agent-card__header">
        <h3>${agent.name}</h3>
        <span class="status status--${agent.status}">${agent.status}</span>
      </div>
      <p class="agent-card__task">${agent.task}</p>
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

function renderLogLine({ agentId, entry }: { agentId: string; entry: LogEntry }) {
  return `
    <div class="log-line log-line--${entry.level}">
      <time>${entry.timestamp.toLocaleTimeString()}</time>
      <span class="log-line__agent">${agentId}</span>
      <span class="log-line__level">${entry.level}</span>
      <span>${entry.message}</span>
    </div>
  `
}

render()
