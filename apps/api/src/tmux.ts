import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent, AgentEvent, AgentStatus, LogEntry } from './types.js'

const execFileAsync = promisify(execFile)

// Shells that indicate the pane is sitting at an interactive prompt.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'csh', 'tcsh', 'ksh'])

const EXEC_TIMEOUT_MS = 5_000

function iso(): string {
  return new Date().toISOString()
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9:._-]/g, '_')
}

function makeAgentId(session: string, window: string, pane: string): string {
  return sanitizeId(`tmux:${session}:${window}.${pane}`)
}

interface PaneInfo {
  session:    string
  window:     string
  pane:       string
  command:    string
  title:      string
  paneActive: boolean
}

function inferStatus(command: string): AgentStatus {
  return SHELL_COMMANDS.has(command) ? 'idle' : 'running'
}

async function listPanes(): Promise<PaneInfo[]> {
  const format = [
    '#{session_name}',
    '#{window_index}',
    '#{pane_index}',
    '#{pane_current_command}',
    '#{pane_title}',
    '#{pane_active}',
  ].join('\t')

  const { stdout } = await execFileAsync(
    'tmux', ['list-panes', '-a', '-F', format],
    { timeout: EXEC_TIMEOUT_MS },
  )

  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t')
    return {
      session:    parts[0] ?? '',
      window:     parts[1] ?? '',
      pane:       parts[2] ?? '',
      command:    parts[3] ?? '',
      title:      parts[4] ?? '',
      paneActive: parts[5] === '1',
    }
  })
}

async function capturePane(session: string, window: string, pane: string): Promise<string[]> {
  try {
    const target = `${session}:${window}.${pane}`
    const { stdout } = await execFileAsync(
      'tmux', ['capture-pane', '-p', '-t', target, '-S', '-'],
      { timeout: EXEC_TIMEOUT_MS },
    )
    return stdout.split('\n')
  } catch {
    return []
  }
}

function inferLogLevel(line: string): LogEntry['level'] {
  const lower = line.toLowerCase()
  if (lower.includes('error') || lower.includes('err:') || lower.includes('fatal')) return 'error'
  if (lower.includes('warn') || lower.includes('warning')) return 'warn'
  if (lower.includes('debug') || lower.includes('verbose')) return 'debug'
  return 'info'
}

function emptyAgent(id: string, name: string, status: AgentStatus, task: string): Agent {
  return {
    id, name, status, task,
    startedAt: null, updatedAt: iso(), logs: [],
    metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
  }
}

/**
 * Start polling tmux every 2 s and expose each pane as an Agent.
 * Returns a cleanup function that stops the polling interval.
 */
export function startTmuxConnector(
  state: Map<string, Agent>,
  broadcast: (event: AgentEvent) => void,
): () => void {
  // Tracks how many non-empty output lines we have already emitted per agent.
  const seenLineCount = new Map<string, number>()

  async function poll(): Promise<void> {
    let panes: PaneInfo[]

    try {
      panes = await listPanes()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const errorId = 'tmux:error'
      const now = iso()

      // If tmux disappears (for example when the last session closes), do not
      // leave old panes looking active in the UI.
      for (const [id, agent] of state) {
        if (
          id.startsWith('tmux:') &&
          id !== errorId &&
          id !== 'tmux:no-sessions' &&
          agent.status !== 'done'
        ) {
          agent.status = 'done'
          agent.updatedAt = now
          broadcast({ type: 'agent:status', agentId: id, status: 'done' })
        }
      }

      const noServer = message.toLowerCase().includes('no server running')
      const sentinelId = noServer ? 'tmux:no-sessions' : 'tmux:error'

      if (noServer) state.delete('tmux:error')

      if (!state.has(sentinelId)) {
        const agent = noServer
          ? emptyAgent(
              sentinelId,
              'tmux (no sessions)',
              'idle',
              'No active tmux sessions found. Start a tmux session to observe it here.',
            )
          : emptyAgent(
              sentinelId,
              'tmux (unavailable)',
              'error',
              'tmux is not available or returned an error. Install tmux and start a session.',
            )
        agent.logs.push({
          timestamp: now,
          level: noServer ? 'info' : 'error',
          message: noServer ? 'No tmux server is currently running.' : message,
          source: 'tmux-connector',
        })
        state.set(sentinelId, agent)
        broadcast({ type: 'agent:registered', agent })
      }
      return
    }

    // A successful tmux command means any previous error sentinel is stale.
    state.delete('tmux:error')

    if (panes.length === 0) {
      const placeholderId = 'tmux:no-sessions'
      if (!state.has(placeholderId)) {
        const agent = emptyAgent(
          placeholderId,
          'tmux (no sessions)',
          'idle',
          'No active tmux sessions found. Start a tmux session to observe it here.',
        )
        state.set(placeholderId, agent)
        broadcast({ type: 'agent:registered', agent })
      }
      return
    }

    // Real panes are present — remove placeholder sentinels.
    state.delete('tmux:no-sessions')

    const activeIds = new Set<string>()

    for (const paneInfo of panes) {
      const agentId = makeAgentId(paneInfo.session, paneInfo.window, paneInfo.pane)
      activeIds.add(agentId)

      const status = inferStatus(paneInfo.command)
      const now = iso()

      if (!state.has(agentId)) {
        const agent: Agent = {
          id: agentId,
          name: `${paneInfo.session}:${paneInfo.window}.${paneInfo.pane}`,
          status,
          task: paneInfo.title || paneInfo.command || 'tmux pane',
          startedAt: now,
          updatedAt: now,
          logs: [],
          metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
        }
        state.set(agentId, agent)
        broadcast({ type: 'agent:registered', agent })
      } else {
        const existing = state.get(agentId)!
        if (existing.status !== status && existing.status !== 'done') {
          existing.status = status
          existing.updatedAt = now
          broadcast({ type: 'agent:status', agentId, status })
        }
      }

      // Capture full scrollback and emit only lines we have not seen yet.
      const lines = await capturePane(paneInfo.session, paneInfo.window, paneInfo.pane)
      const nonEmpty = lines.filter(l => l.trim().length > 0)
      const seen = seenLineCount.get(agentId) ?? 0

      if (nonEmpty.length < seen) {
        // History was cleared (e.g. `clear` command) — reset cursor, do not re-emit.
        seenLineCount.set(agentId, nonEmpty.length)
      } else {
        const newLines = nonEmpty.slice(seen)
        if (newLines.length > 0) {
          seenLineCount.set(agentId, seen + newLines.length)
          const agent = state.get(agentId)!
          for (const line of newLines) {
            const entry: LogEntry = {
              timestamp: iso(),
              level: inferLogLevel(line),
              message: line,
              source: paneInfo.command,
            }
            agent.logs.push(entry)
            broadcast({ type: 'agent:log', agentId, entry })
          }
          agent.updatedAt = iso()
        }
      }
    }

    // Panes that vanished since last poll → mark done.
    for (const [id, agent] of state) {
      if (
        id.startsWith('tmux:') &&
        !activeIds.has(id) &&
        id !== 'tmux:no-sessions' &&
        id !== 'tmux:error'
      ) {
        if (agent.status !== 'done') {
          agent.status = 'done'
          agent.updatedAt = iso()
          broadcast({ type: 'agent:status', agentId: id, status: 'done' })
        }
      }
    }
  }

  void poll()
  const handle = setInterval(() => { void poll() }, 2_000)

  return () => { clearInterval(handle) }
}
