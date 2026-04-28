import { request } from 'node:http'
import { openSync, closeSync, readSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentEvent, AgentStatus, LogEntry } from './types.js'

const HERMES_URL = 'http://127.0.0.1:9119/api/status'
const POLL_MS = 5_000
const FETCH_TIMEOUT_MS = 4_000
const SESSIONS_JSON = '/root/.hermes/sessions/sessions.json'
const SESSIONS_DIR = '/root/.hermes/sessions'
const TAIL_BYTES = 16_384
const MAX_SESSION_LOGS = 12

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

// ── Hermes session file helpers ───────────────────────────────────────────────

// Strip control chars, redact credential-like patterns, truncate.
function sanitizeText(raw: string, maxLen = 220): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const s0 = raw.slice(0, 4_000)
  if (s0.trimStart().startsWith('[CONTEXT COMPACTION')) return '[context compacted]'
  let s = s0
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/(?:Bearer|Authorization|api[_-]?key|password|passwd|secret|token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[REDACTED]')
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…'
  return s.trim()
}

interface JsonlLine {
  role?: string
  content?: unknown
  tool_calls?: Array<{ function?: { name?: string } }>
  timestamp?: string
}

interface SessionMeta {
  session_id: string
  display_name?: string
  platform?: string
  chat_type?: string
  last_prompt_tokens?: unknown
  total_tokens?: unknown
  suspended?: unknown
  resume_pending?: unknown
  created_at?: string
  updated_at?: string
}

function readFileTail(filePath: string): string {
  try {
    const { size } = statSync(filePath)
    if (size === 0) return ''
    if (size <= TAIL_BYTES) return readFileSync(filePath, 'utf8')
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(TAIL_BYTES)
      readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function parseJsonlLine(line: string): JsonlLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    if (trimmed.length > 40_000) {
      const m = /"role"\s*:\s*"([^"]+)"/.exec(trimmed)
      return m ? { role: m[1] } : null
    }
    const obj = JSON.parse(trimmed) as unknown
    if (typeof obj !== 'object' || obj === null) return null
    return obj as JsonlLine
  } catch {
    return null
  }
}

function readSessionTailLines(sessionId: string): JsonlLine[] {
  const tail = readFileTail(join(SESSIONS_DIR, `${sessionId}.jsonl`))
  if (!tail) return []
  const nl = tail.indexOf('\n')
  const usable = nl >= 0 ? tail.slice(nl + 1) : tail
  const result: JsonlLine[] = []
  for (const line of usable.split('\n')) {
    const parsed = parseJsonlLine(line)
    if (parsed) result.push(parsed)
  }
  return result
}

function extractSessionTask(entries: JsonlLine[], platform: string): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.role !== 'user') continue
    const c = typeof e.content === 'string' ? e.content : ''
    if (!c || c.trimStart().startsWith('[CONTEXT COMPACTION')) continue
    const sanitized = sanitizeText(c, 180)
    if (sanitized && sanitized !== '[context compacted]') return sanitized
  }
  return `Active Hermes ${platform} session`
}

function buildSessionLogs(entries: JsonlLine[], ts: string): LogEntry[] {
  const logs: LogEntry[] = []
  for (const e of entries) {
    if (logs.length >= MAX_SESSION_LOGS) break
    const timestamp = typeof e.timestamp === 'string' ? e.timestamp : ts

    if (e.role === 'user') {
      const c = typeof e.content === 'string' ? e.content : ''
      if (!c || c.trimStart().startsWith('[CONTEXT COMPACTION')) continue
      const msg = sanitizeText(c, 140)
      if (msg && msg !== '[context compacted]') {
        logs.push({ timestamp, level: 'info', message: `User: ${msg}`, source: 'hermes-session' })
      }
    } else if (e.role === 'assistant' && Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
      const names = e.tool_calls
        .map(tc => (tc.function?.name ?? '').slice(0, 40))
        .filter(n => n.length > 0)
        .slice(0, 6)
        .join(', ')
      if (names) {
        logs.push({ timestamp, level: 'info', message: `Tools: ${names}`, source: 'hermes-session' })
      }
    } else if (e.role === 'assistant' && typeof e.content === 'string' && e.content.length > 0) {
      if (e.content.trimStart().startsWith('[CONTEXT COMPACTION')) continue
      const msg = sanitizeText(e.content, 140)
      if (msg && msg !== '[context compacted]') {
        logs.push({ timestamp, level: 'debug', message: `Response: ${msg}`, source: 'hermes-session' })
      }
    } else if (e.role === 'tool' && typeof e.content === 'string' && e.content.length > 0) {
      const msg = sanitizeText(e.content, 100)
      if (msg) {
        logs.push({ timestamp, level: 'debug', message: `Result: ${msg}`, source: 'hermes-session' })
      }
    }
  }
  return logs
}

function countToolCalls(entries: JsonlLine[]): number {
  return entries.reduce((sum, e) => {
    if (e.role === 'assistant' && Array.isArray(e.tool_calls)) return sum + e.tool_calls.length
    return sum
  }, 0)
}

function getFileMtime(filePath: string): number {
  try { return statSync(filePath).mtimeMs } catch { return 0 }
}

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
}

function safeName(raw: string): string {
  return raw.replace(/[^\w .@-]/g, '').slice(0, 40).trim()
}

function readSessionsJson(): Record<string, SessionMeta> | null {
  try {
    const text = readFileSync(SESSIONS_JSON, 'utf8')
    const obj = JSON.parse(text) as unknown
    if (typeof obj !== 'object' || obj === null) return null
    return obj as Record<string, SessionMeta>
  } catch {
    return null
  }
}

function activeSessionCountFromFiles(): number | null {
  const sessionsData = readSessionsJson()
  if (!sessionsData) return null
  return Object.values(sessionsData)
    .filter(meta => typeof meta.session_id === 'string' && meta.session_id.length > 0)
    .length
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

  // Track jsonl file mtimes per session_id to avoid log spam on every poll.
  const sessionMtimes = new Map<string, number>()

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

  // Sync one AgentDeck agent per active Hermes session from local files.
  function syncSessionAgents(): void {
    const sessionsData = readSessionsJson()
    if (!sessionsData) return

    const activeAgentIds = new Set<string>()

    for (const [, meta] of Object.entries(sessionsData)) {
      if (typeof meta.session_id !== 'string' || !meta.session_id) continue

      const agentId = `hermes-session-${safeId(meta.session_id)}`
      activeAgentIds.add(agentId)

      const platform = typeof meta.platform === 'string' ? safeName(meta.platform) : 'unknown'
      const chatType = typeof meta.chat_type === 'string' ? safeName(meta.chat_type) : ''
      const displayName = typeof meta.display_name === 'string' && meta.display_name
        ? safeName(meta.display_name) : platform
      const agentName = `Hermes Session · ${displayName || platform}`

      const suspended = meta.suspended === true || meta.resume_pending === true
      const sessionStatus: AgentStatus = suspended ? 'waiting' : 'running'

      const tokensUsed = typeof meta.last_prompt_tokens === 'number' && meta.last_prompt_tokens > 0
        ? meta.last_prompt_tokens
        : typeof meta.total_tokens === 'number' ? meta.total_tokens : 0

      const jsonlPath = join(SESSIONS_DIR, `${meta.session_id}.jsonl`)
      const currentMtime = getFileMtime(jsonlPath)
      const prevMtime = sessionMtimes.get(meta.session_id) ?? -1
      const contentChanged = currentMtime !== prevMtime

      const existing = state.get(agentId)

      if (!existing) {
        // First time we see this session — read tail and register
        const entries = readSessionTailLines(meta.session_id)
        const now = iso()
        const task = extractSessionTask(entries, platform)
        const logs = buildSessionLogs(entries, now)
        const toolCallsCount = countToolCalls(entries)

        const agent = registerAgent(agentId, agentName, sessionStatus, task)
        agent.startedAt = typeof meta.created_at === 'string' ? meta.created_at : agent.startedAt
        agent.updatedAt = typeof meta.updated_at === 'string' ? meta.updated_at : now
        agent.metrics.tokensUsed = tokensUsed
        agent.metrics.toolCallsCount = toolCallsCount
        agent.metrics.filesModified = [
          `platform: ${platform}`,
          ...(chatType ? [`chat_type: ${chatType}`] : []),
          `session: ${meta.session_id.slice(0, 24)}`,
          ...(meta.updated_at ? [`updated: ${meta.updated_at.slice(0, 19)}`] : []),
        ]
        agent.logs = logs
        sessionMtimes.set(meta.session_id, currentMtime)
        // Re-broadcast with complete data
        broadcast({ type: 'agent:registered', agent })
      } else {
        // Agent already known — update status, metrics, and logs only if changed
        setStatus(existing, sessionStatus)
        existing.metrics.tokensUsed = tokensUsed

        if (contentChanged) {
          const entries = readSessionTailLines(meta.session_id)
          const now = iso()
          const task = extractSessionTask(entries, platform)
          const newLogs = buildSessionLogs(entries, now)
          const toolCallsCount = countToolCalls(entries)

          existing.task = task
          existing.logs = newLogs  // replace snapshot, no unbounded growth
          existing.metrics.toolCallsCount = toolCallsCount
          existing.metrics.filesModified = [
            `platform: ${platform}`,
            ...(chatType ? [`chat_type: ${chatType}`] : []),
            `session: ${meta.session_id.slice(0, 24)}`,
            ...(meta.updated_at ? [`updated: ${meta.updated_at.slice(0, 19)}`] : []),
          ]
          existing.updatedAt = typeof meta.updated_at === 'string' ? meta.updated_at : iso()
          sessionMtimes.set(meta.session_id, currentMtime)
          broadcast({ type: 'agent:registered', agent: existing })
        }
      }
    }

    // Retire stale hermes-session-* agents no longer in sessions.json
    for (const [id, agent] of state) {
      if (id.startsWith('hermes-session-') && !activeAgentIds.has(id)) {
        setStatus(agent, 'done')
        addLog(agent, 'info', 'Session ended or expired')
        // Remove mtime tracking for this session
        const sessionId = id.slice('hermes-session-'.length)
        sessionMtimes.delete(sessionId)
      }
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
      // Still sync local session files even when dashboard is unreachable
      syncSessionAgents()
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
    const fileSessionCount = activeSessionCountFromFiles()
    const sessionCount = Math.max(safe.active_sessions ?? 0, fileSessionCount ?? 0)
    const sessionsStatus: AgentStatus = sessionCount > 0 ? 'running' : 'waiting'
    const sessionsTask = `Active sessions: ${sessionCount}`
    const sessions = ensureAgent(SESSIONS_ID, 'Hermes Sessions', sessionsStatus, sessionsTask)
    setStatus(sessions, sessionsStatus)
    sessions.metrics.filesModified = [`active sessions: ${sessionCount}`]
    if (sessions.task !== sessionsTask) { sessions.task = sessionsTask; sessions.updatedAt = iso() }
    addLog(sessions, 'info', `${sessionCount} active session${sessionCount !== 1 ? 's' : ''}`)

    // ── per-session agents from local files ───────────────────────────────────
    syncSessionAgents()
  }

  void poll()
  const handle = setInterval(() => { void poll() }, POLL_MS)
  return () => { clearInterval(handle) }
}
