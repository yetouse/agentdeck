import { request } from 'node:http'
import type { Agent, AgentEvent, AgentStatus, LogEntry } from './types.js'

const HERMES_URL = 'http://127.0.0.1:9119/api/status'
const POLL_MS = 5_000
const FETCH_TIMEOUT_MS = 4_000

function iso(): string {
  return new Date().toISOString()
}

// Safe public subset of Hermes status — no keys, tokens, or config values.
export interface SafeHermesStatus {
  reachable: boolean
  gateway_running: boolean | null
  gateway_state: string | null
  active_sessions: number | null
  polled_at: string
}

let latestSafeStatus: SafeHermesStatus = {
  reachable: false,
  gateway_running: null,
  gateway_state: null,
  active_sessions: null,
  polled_at: iso(),
}

export function getLatestHermesStatus(): SafeHermesStatus {
  return latestSafeStatus
}

function fetchHermesStatus(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const req = request(HERMES_URL, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume()
        reject(new Error(`Hermes returned HTTP ${res.statusCode}`))
        return
      }
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('Invalid JSON from Hermes dashboard'))
        }
      })
      res.on('error', (e: Error) => reject(e))
    })
    req.setTimeout(FETCH_TIMEOUT_MS, () => { req.destroy(new Error('timeout')) })
    req.on('error', (e: Error) => reject(e))
    req.end()
  })
}

function isSafeStateString(val: string): boolean {
  return val.length <= 64 && /^[-a-zA-Z0-9_.:/\s]+$/.test(val)
}

function sanitizeStateValue(val: unknown): string {
  if (typeof val === 'string' && isSafeStateString(val)) return val
  if (typeof val === 'boolean') return String(val)
  return '[state]'
}

// Produces a safe "platform: state" summary from raw status, omitting any
// values that look like tokens or credentials.
function platformSummary(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const platforms = r['gateway_platforms'] ?? r['platform_states']
  if (typeof platforms !== 'object' || platforms === null) return null
  const parts: string[] = []
  for (const [name, val] of Object.entries(platforms as Record<string, unknown>)) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
    if (typeof val === 'string') {
      parts.push(`${safeName}: ${sanitizeStateValue(val)}`)
    } else if (typeof val === 'object' && val !== null) {
      const v = val as Record<string, unknown>
      const raw_state = typeof v['state'] === 'string' ? v['state']
        : typeof v['status'] === 'string' ? v['status'] : null
      parts.push(`${safeName}: ${raw_state !== null ? sanitizeStateValue(raw_state) : '[state]'}`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : null
}

function extractSafeStatus(raw: unknown): SafeHermesStatus {
  const polled_at = iso()
  if (typeof raw !== 'object' || raw === null) {
    return { reachable: true, gateway_running: null, gateway_state: null, active_sessions: null, polled_at }
  }
  const r = raw as Record<string, unknown>
  const gateway_state_raw = typeof r['gateway_state'] === 'string' ? r['gateway_state'] : null
  return {
    reachable: true,
    gateway_running: typeof r['gateway_running'] === 'boolean' ? r['gateway_running'] : null,
    gateway_state: gateway_state_raw !== null && isSafeStateString(gateway_state_raw) ? gateway_state_raw : null,
    active_sessions: typeof r['active_sessions'] === 'number' ? r['active_sessions'] : null,
    polled_at,
  }
}

function inferGatewayStatus(safe: SafeHermesStatus): AgentStatus {
  if (!safe.reachable) return 'error'
  if (safe.gateway_running === false) return 'done'
  const gwState = safe.gateway_state?.toLowerCase() ?? ''
  if (gwState === 'error' || gwState === 'failed' || gwState === 'crashed') return 'error'
  if (safe.gateway_running === true) return 'running'
  return 'waiting'
}

/**
 * Poll Hermes dashboard at http://127.0.0.1:9119/api/status every 5 s and
 * expose each subsystem as an AgentDeck Agent. Returns a cleanup function.
 */
export function startHermesConnector(
  state: Map<string, Agent>,
  broadcast: (event: AgentEvent) => void,
): () => void {
  const GATEWAY_ID   = 'hermes-gateway'
  const DASHBOARD_ID = 'hermes-dashboard'
  const SESSIONS_ID  = 'hermes-sessions'
  const ERROR_ID     = 'hermes-error'

  function registerAgent(id: string, name: string, status: AgentStatus, task: string): Agent {
    const agent: Agent = {
      id, name, status, task,
      startedAt: iso(), updatedAt: iso(),
      logs: [],
      metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
    }
    state.set(id, agent)
    broadcast({ type: 'agent:registered', agent })
    return agent
  }

  function ensureAgent(id: string, name: string, status: AgentStatus, task: string): Agent {
    return state.get(id) ?? registerAgent(id, name, status, task)
  }

  function addLog(agent: Agent, level: LogEntry['level'], message: string): void {
    const entry: LogEntry = { timestamp: iso(), level, message, source: 'hermes-connector' }
    agent.logs.push(entry)
    if (agent.logs.length > 200) agent.logs = agent.logs.slice(-200)
    agent.updatedAt = iso()
    broadcast({ type: 'agent:log', agentId: agent.id, entry })
  }

  function setStatus(agent: Agent, status: AgentStatus): void {
    if (agent.status !== status) {
      agent.status = status
      agent.updatedAt = iso()
      broadcast({ type: 'agent:status', agentId: agent.id, status })
    }
  }

  async function poll(): Promise<void> {
    let raw: unknown
    try {
      raw = await fetchHermesStatus()
    } catch (err: unknown) {
      latestSafeStatus = {
        reachable: false, gateway_running: null, gateway_state: null,
        active_sessions: null, polled_at: iso(),
      }
      for (const id of [GATEWAY_ID, DASHBOARD_ID, SESSIONS_ID]) {
        const agent = state.get(id)
        if (agent) setStatus(agent, 'error')
      }
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120)
      if (!state.has(ERROR_ID)) {
        const errorAgent = registerAgent(
          ERROR_ID, 'Hermes (unreachable)', 'error',
          'Hermes dashboard at 127.0.0.1:9119 is not responding',
        )
        addLog(errorAgent, 'error', `Cannot reach Hermes dashboard: ${msg}`)
      } else {
        addLog(state.get(ERROR_ID)!, 'warn', `Poll failed: ${msg}`)
      }
      return
    }

    // Reachable — retire error sentinel if it was shown.
    const errorAgent = state.get(ERROR_ID)
    if (errorAgent) {
      setStatus(errorAgent, 'done')
      addLog(errorAgent, 'info', 'Hermes dashboard is now reachable')
    }

    const safe = extractSafeStatus(raw)
    latestSafeStatus = safe

    // ── hermes-gateway ────────────────────────────────────────────────────────
    const gatewayStatus = inferGatewayStatus(safe)
    const gatewayTask = safe.gateway_state
      ? `Gateway ${safe.gateway_state}${safe.gateway_running ? ' · platform connected' : ''}`
      : 'Hermes gateway'
    const gateway = ensureAgent(GATEWAY_ID, 'Hermes Gateway', gatewayStatus, gatewayTask)
    setStatus(gateway, gatewayStatus)
    if (gateway.task !== gatewayTask) { gateway.task = gatewayTask; gateway.updatedAt = iso() }

    const platLog = platformSummary(raw)
    if (platLog) {
      addLog(gateway, 'info', `Platform states: ${platLog}`)
    } else {
      addLog(gateway, 'debug',
        `gateway_running=${safe.gateway_running}, state=${safe.gateway_state ?? 'unknown'}`)
    }

    // ── hermes-dashboard ──────────────────────────────────────────────────────
    const dashboard = ensureAgent(DASHBOARD_ID, 'Hermes Dashboard', 'running',
      'Web dashboard on 127.0.0.1:9119')
    setStatus(dashboard, 'running')
    addLog(dashboard, 'debug', `Status polled OK at ${safe.polled_at}`)

    // ── hermes-sessions ───────────────────────────────────────────────────────
    const sessionCount = safe.active_sessions ?? 0
    const sessionsStatus: AgentStatus = sessionCount > 0 ? 'running' : 'waiting'
    const sessionsTask = `Active sessions: ${sessionCount}`
    const sessions = ensureAgent(SESSIONS_ID, 'Hermes Sessions', sessionsStatus, sessionsTask)
    setStatus(sessions, sessionsStatus)
    sessions.metrics.filesModified = [`active sessions: ${sessionCount}`]
    if (sessions.task !== sessionsTask) { sessions.task = sessionsTask; sessions.updatedAt = iso() }
    addLog(sessions, 'info', `${sessionCount} active session${sessionCount !== 1 ? 's' : ''}`)
  }

  void poll()
  const handle = setInterval(() => { void poll() }, POLL_MS)
  return () => { clearInterval(handle) }
}
