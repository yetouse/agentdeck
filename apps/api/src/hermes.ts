import { request } from 'node:http'
import { openSync, closeSync, readSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, AgentEvent, AgentStatus, LogEntry, Topology, TopologyEdge, TopologyNode } from './types.js'

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
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>
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
      if (!m) return null
      const line: JsonlLine = { role: m[1] }
      if (line.role === 'assistant') {
        const tool_calls: NonNullable<JsonlLine['tool_calls']> = []
        const seen = new Set<string>()
        const nameRe = /"function"\s*:\s*\{[^{}]*"name"\s*:\s*"([a-zA-Z0-9_:-]{1,48})"/g
        let nameMatch: RegExpExecArray | null
        while ((nameMatch = nameRe.exec(trimmed)) !== null && tool_calls.length < 24) {
          const name = safeToolName(nameMatch[1])
          if (name && !seen.has(name)) {
            seen.add(name)
            tool_calls.push({ function: { name } })
          }
        }
        if (tool_calls.length > 0) line.tool_calls = tool_calls
      }
      return line
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

function normalizeSessions(raw: unknown): Record<string, SessionMeta> | null {
  const out: Record<string, SessionMeta> = {}

  const add = (candidate: unknown, fallbackId?: string): void => {
    if (typeof candidate !== 'object' || candidate === null) return
    const meta = candidate as SessionMeta
    const sessionId = typeof meta.session_id === 'string' && meta.session_id
      ? meta.session_id
      : fallbackId
    if (!sessionId) return
    out[sessionId] = { ...meta, session_id: sessionId }
  }

  if (Array.isArray(raw)) {
    raw.forEach(item => add(item))
  } else if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>
    const nested = obj['sessions']
    if (Array.isArray(nested)) {
      nested.forEach(item => add(item))
    } else if (typeof nested === 'object' && nested !== null) {
      for (const [id, item] of Object.entries(nested as Record<string, unknown>)) add(item, id)
    } else {
      for (const [id, item] of Object.entries(obj)) add(item, id)
    }
  }

  return Object.keys(out).length > 0 ? out : null
}

function readSessionsJson(): Record<string, SessionMeta> | null {
  try {
    const text = readFileSync(SESSIONS_JSON, 'utf8')
    return normalizeSessions(JSON.parse(text) as unknown)
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

const DEV_ACTIVITY_WINDOW_MS = 30 * 60 * 1000
const MAX_DEV_LOGS = 12
const MAX_DEV_FILES = 8
const AGENTDECK_ROOT = '/root/github/agentdeck/'

function safeToolName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const safe = raw.replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 48)
  return safe || null
}

function isSafeDevPath(path: string): boolean {
  const lower = path.toLowerCase()
  if (!path || path.length > 180) return false
  if (lower.includes('..')) return false
  if (/(^|\/)\.(env|npmrc|pypirc|netrc)(\.|$)/i.test(path)) return false
  if (/htpasswd|credential|password|passwd|secret|token|auth\.json|cookie|private[_-]?key/i.test(path)) return false
  return /^(apps|packages|src|docs|scripts|tests|\.github)\//.test(path)
    || /^(package(-lock)?\.json|tsconfig\.json|README\.md|LICENSE)$/.test(path)
}

function normalizeDevPath(raw: string): string | null {
  let path = raw.trim().replace(/["'`),;]+$/g, '')
  if (path.startsWith(AGENTDECK_ROOT)) path = path.slice(AGENTDECK_ROOT.length)
  path = path.replace(/^\.\//, '')
  return isSafeDevPath(path) ? path : null
}

function collectPathsFromText(text: string, out: Set<string>): void {
  const patterns = [
    /\/root\/github\/agentdeck\/[A-Za-z0-9._\/-]+/g,
    /(?:apps|packages|src|docs|scripts|tests|\.github)\/[A-Za-z0-9._\/-]+/g,
    /\b(?:package(?:-lock)?\.json|tsconfig\.json|README\.md|LICENSE)\b/g,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const safe = normalizeDevPath(match[0])
      if (safe) out.add(safe)
      if (out.size >= MAX_DEV_FILES) return
    }
  }
}

function collectPathsFromValue(value: unknown, out: Set<string>): void {
  if (out.size >= MAX_DEV_FILES) return
  if (typeof value === 'string') {
    collectPathsFromText(value, out)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromValue(item, out)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) collectPathsFromValue(item, out)
  }
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

// ── Topology inference ────────────────────────────────────────────────────────

type Workstream =
  | 'coordination'
  | 'investigation'
  | 'implementation'
  | 'verification'
  | 'deployment'
  | 'release'
  | 'observed-tools'

const WORKSTREAM_LABEL: Record<Workstream, string> = {
  coordination:    'Coordination',
  investigation:   'Investigation',
  implementation:  'Implementation',
  verification:    'Verification',
  deployment:      'Deployment',
  release:         'Git / Release',
  'observed-tools':'Observed Tools',
}

const SAFE_VERB = /^[a-z][a-z0-9_-]{0,24}$/i

// Pull just the leading command verb from a terminal-style string. Refuses
// anything containing shell metacharacters that could leak content.
function extractCommandVerb(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Take only the first token; the rest may contain secrets/paths.
  const head = trimmed.split(/\s+/, 1)[0] ?? ''
  // Strip optional leading "sudo "
  const verb = head === 'sudo' ? (trimmed.split(/\s+/, 2)[1] ?? '') : head
  return SAFE_VERB.test(verb) ? verb.toLowerCase() : null
}

function extractTerminalSecondary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const tokens = raw.trim().split(/\s+/)
  // For commands like `npm run typecheck`, peek at the script verb.
  if (tokens.length >= 3 && tokens[0] === 'npm' && tokens[1] === 'run') {
    const t = tokens[2] ?? ''
    return SAFE_VERB.test(t) ? t.toLowerCase() : null
  }
  if (tokens.length >= 2 && tokens[0] === 'git') {
    const t = tokens[1] ?? ''
    return SAFE_VERB.test(t) ? t.toLowerCase() : null
  }
  return null
}

function classifyToolName(name: string): Workstream {
  const n = name.toLowerCase()
  if (n === 'todo' || n === 'todowrite' || n === 'clarify' || n === 'send_message' || n === 'cronjob' || n === 'cron') return 'coordination'
  if (n === 'read_file' || n === 'read' || n === 'search_files' || n === 'grep' || n === 'glob' || n === 'session_search' || n === 'browser_console') return 'investigation'
  if (n === 'patch' || n === 'edit' || n === 'write_file' || n === 'write' || n === 'claude') return 'implementation'
  if (n === 'vision') return 'verification'
  if (n.startsWith('browser_')) return 'verification'
  return 'observed-tools'
}

function classifyTerminalCommand(verb: string, secondary: string | null, fullText: string): Workstream {
  const t = fullText.toLowerCase()
  if (verb === 'git') {
    if (secondary === 'commit' || secondary === 'push' || secondary === 'tag') return 'release'
    return 'release'
  }
  if (verb === 'npm' || verb === 'pnpm' || verb === 'yarn') {
    if (secondary === 'typecheck' || secondary === 'build' || secondary === 'test' || secondary === 'audit' || secondary === 'lint') return 'verification'
    return 'implementation'
  }
  if (verb === 'rsync' || verb === 'scp' || verb === 'systemctl' || verb === 'nginx' || verb === 'certbot') return 'deployment'
  if (verb === 'curl' && (t.includes('smoke') || t.includes('/health') || t.includes('://'))) return 'deployment'
  if (verb === 'tsc') return 'verification'
  return 'implementation'
}

interface ToolObservation {
  name: string                  // safe canonical tool name
  workstream: Workstream
  count: number
}

interface TopologyAccumulator {
  toolByName: Map<string, ToolObservation>
  workstreamCounts: Map<Workstream, number>
  files: Set<string>
  toolCallTotal: number
}

function newTopologyAccumulator(): TopologyAccumulator {
  return {
    toolByName: new Map(),
    workstreamCounts: new Map(),
    files: new Set(),
    toolCallTotal: 0,
  }
}

function recordWorkstream(acc: TopologyAccumulator, ws: Workstream): void {
  acc.workstreamCounts.set(ws, (acc.workstreamCounts.get(ws) ?? 0) + 1)
}

function recordTool(acc: TopologyAccumulator, name: string, ws: Workstream): void {
  const existing = acc.toolByName.get(name)
  if (existing) {
    existing.count += 1
  } else {
    acc.toolByName.set(name, { name, workstream: ws, count: 1 })
  }
  recordWorkstream(acc, ws)
  acc.toolCallTotal += 1
}

function ingestEntries(entries: JsonlLine[], acc: TopologyAccumulator): void {
  for (const e of entries) {
    if (e.role === 'user' && typeof e.content === 'string') {
      const c = e.content
      if (c && !c.trimStart().startsWith('[CONTEXT COMPACTION')) {
        // Any visible user prompt is a safe coordination signal. It gives the
        // graph a truthful root/workstream even before tool calls arrive.
        recordWorkstream(acc, 'coordination')
      }
      continue
    }
    if (e.role !== 'assistant' || !Array.isArray(e.tool_calls)) continue
    for (const tc of e.tool_calls) {
      const safe = safeToolName(tc.function?.name)
      if (!safe) continue
      const args = parseToolArguments(tc.function?.arguments)
      collectPathsFromValue(args, acc.files)

      let ws = classifyToolName(safe)
      if (safe === 'terminal' || safe === 'bash' || safe === 'shell') {
        const cmdRaw = extractCommandText(args)
        const verb = extractCommandVerb(cmdRaw)
        if (verb) {
          const secondary = extractTerminalSecondary(cmdRaw)
          ws = classifyTerminalCommand(verb, secondary, cmdRaw ?? '')
          // Use the verb as a more meaningful tool label.
          recordTool(acc, verb, ws)
          continue
        }
      }
      recordTool(acc, safe, ws)
    }
  }
}

function extractCommandText(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const a = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'shell', 'input']) {
    const v = a[key]
    if (typeof v === 'string') return v
  }
  return ''
}

function buildTopologyFromAccumulator(
  rootId: string,
  rootLabel: string,
  rootStatus: AgentStatus,
  acc: TopologyAccumulator,
  fileLimit: number,
): Topology {
  const nodes: TopologyNode[] = []
  const edges: TopologyEdge[] = []

  nodes.push({
    id: rootId,
    label: rootLabel,
    kind: 'agent',
    status: rootStatus,
    observed: true,
    count: acc.toolCallTotal,
  })

  // Workstreams (inferred). Order by descending count, stable label tiebreak.
  const wsEntries = Array.from(acc.workstreamCounts.entries())
    .sort((a, b) => b[1] - a[1] || WORKSTREAM_LABEL[a[0]].localeCompare(WORKSTREAM_LABEL[b[0]]))

  for (const [ws, count] of wsEntries) {
    const wsId = `ws:${ws}`
    nodes.push({
      id: wsId,
      label: WORKSTREAM_LABEL[ws],
      kind: 'workstream',
      status: rootStatus === 'running' ? 'running' : 'idle',
      observed: false,
      count,
    })
    edges.push({ from: rootId, to: wsId })
  }

  // Tools per workstream (observed). Dedup by canonical name.
  const toolList = Array.from(acc.toolByName.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  for (const tool of toolList) {
    const wsId = `ws:${tool.workstream}`
    if (!nodes.some(n => n.id === wsId)) continue
    const toolId = `tool:${tool.workstream}:${tool.name}`
    nodes.push({
      id: toolId,
      label: tool.name,
      kind: 'tool',
      status: 'idle',
      observed: true,
      count: tool.count,
    })
    edges.push({ from: wsId, to: toolId })
  }

  // Files (observed). Limit to keep the graph readable.
  const fileList = Array.from(acc.files).slice(0, fileLimit)
  if (fileList.length > 0) {
    // Anchor files to the most relevant workstream when possible, else to root.
    const anchorWs: Workstream | null =
      acc.workstreamCounts.has('implementation') ? 'implementation'
      : acc.workstreamCounts.has('investigation') ? 'investigation'
      : null
    const anchorId = anchorWs ? `ws:${anchorWs}` : rootId
    for (const path of fileList) {
      const fileId = `file:${path}`
      nodes.push({
        id: fileId,
        label: path,
        kind: 'file',
        status: 'idle',
        observed: true,
      })
      edges.push({ from: anchorId, to: fileId })
    }
  }

  return { nodes, edges, updatedAt: iso() }
}

function buildSessionTopology(
  sessionId: string,
  sessionName: string,
  sessionStatus: AgentStatus,
  platform: string,
  entries: JsonlLine[],
): Topology {
  const acc = newTopologyAccumulator()
  ingestEntries(entries, acc)
  if (acc.workstreamCounts.size === 0) recordWorkstream(acc, 'coordination')

  const rootId = `hermes-session-${safeId(sessionId)}`
  const topology = buildTopologyFromAccumulator(rootId, sessionName, sessionStatus, acc, 6)

  // Decorate root with platform detail without leaking secrets.
  const root = topology.nodes[0]
  if (root) root.detail = `platform: ${platform}`

  return topology
}

function buildSimpleStatusTopology(rootId: string, rootLabel: string, status: AgentStatus, eventLabel: string): Topology {
  return {
    nodes: [
      { id: rootId, label: rootLabel, kind: 'agent', status, observed: true },
      { id: `${rootId}:status`, label: eventLabel, kind: 'event', status, observed: true },
    ],
    edges: [{ from: rootId, to: `${rootId}:status` }],
    updatedAt: iso(),
  }
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
        agent.topology = buildSessionTopology(meta.session_id, agentName, sessionStatus, platform, entries)
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
          existing.topology = buildSessionTopology(meta.session_id, existing.name, sessionStatus, platform, entries)
          existing.updatedAt = typeof meta.updated_at === 'string' ? meta.updated_at : iso()
          sessionMtimes.set(meta.session_id, currentMtime)
          broadcast({ type: 'agent:registered', agent: existing })
        }
      }
    }

    // Retire stale hermes-session-* agents no longer in sessions.json
    for (const [id, agent] of Array.from(state.entries())) {
      if (id.startsWith('hermes-session-') && !activeAgentIds.has(id)) {
        setStatus(agent, 'done')
        addLog(agent, 'info', 'Session ended or expired')
        // Remove mtime tracking for this session
        const sessionId = id.slice('hermes-session-'.length)
        sessionMtimes.delete(sessionId)
      }
    }
  }

  // Aggregate a safe "what is Hermes doing for development?" cockpit card.
  function syncDevelopmentAgent(): void {
    const DEV_ID = 'hermes-development'
    const sessionsData = readSessionsJson()
    const metas = sessionsData ? Object.values(sessionsData) : []
    const files = new Set<string>()
    const logs: LogEntry[] = []
    let latestMission = ''
    let latestMissionTs = ''
    let recentToolCalls = 0
    let recentActivity = false
    let startedAt: string | null = null
    const acc = newTopologyAccumulator()

    const pushDevLog = (timestamp: string, level: LogEntry['level'], message: string): void => {
      logs.push({ timestamp, level, message: sanitizeText(message, 180), source: 'hermes-development' })
    }

    for (const meta of metas) {
      if (typeof meta.session_id !== 'string' || !meta.session_id) continue
      const jsonlPath = join(SESSIONS_DIR, `${meta.session_id}.jsonl`)
      const mtime = getFileMtime(jsonlPath)
      if (mtime > 0 && Date.now() - mtime <= DEV_ACTIVITY_WINDOW_MS) recentActivity = true
      if (!startedAt || (typeof meta.created_at === 'string' && meta.created_at < startedAt)) {
        startedAt = typeof meta.created_at === 'string' ? meta.created_at : startedAt
      }

      const entries = readSessionTailLines(meta.session_id)
      const platform = typeof meta.platform === 'string' ? safeName(meta.platform) : 'unknown'
      const mission = extractSessionTask(entries, platform)
      const missionTs = entries.filter(e => e.role === 'user' && typeof e.timestamp === 'string').at(-1)?.timestamp
        ?? meta.updated_at
        ?? iso()
      if (mission && (!latestMissionTs || missionTs > latestMissionTs)) {
        latestMission = mission
        latestMissionTs = missionTs
      }

      ingestEntries(entries, acc)

      for (const e of entries) {
        const timestamp = typeof e.timestamp === 'string' ? e.timestamp : meta.updated_at ?? iso()
        if (e.role === 'user' && typeof e.content === 'string') {
          const missionLine = sanitizeText(e.content, 120)
          if (missionLine && missionLine !== '[context compacted]') pushDevLog(timestamp, 'info', `Mission: ${missionLine}`)
        }

        if (e.role === 'assistant' && Array.isArray(e.tool_calls)) {
          recentToolCalls += e.tool_calls.length
          const toolNames: string[] = []
          for (const tc of e.tool_calls) {
            const name = safeToolName(tc.function?.name)
            if (name) toolNames.push(name)
            const args = parseToolArguments(tc.function?.arguments)
            collectPathsFromValue(args, files)
          }
          if (toolNames.length > 0) pushDevLog(timestamp, 'debug', `Tool: ${toolNames.slice(0, 5).join(', ')}`)
        }
      }
    }

    if (acc.workstreamCounts.size === 0 && metas.length > 0) {
      recordWorkstream(acc, 'coordination')
    }

    for (const path of Array.from(files)) acc.files.add(path)

    const task = latestMission || 'Watching Hermes development activity'
    const status: AgentStatus = metas.length > 0 && recentActivity ? 'running' : metas.length > 0 ? 'waiting' : 'idle'
    const dev = ensureAgent(DEV_ID, 'Hermes Development', status, task)
    setStatus(dev, status)
    dev.task = task
    dev.startedAt = startedAt ?? dev.startedAt
    dev.updatedAt = latestMissionTs || iso()
    dev.logs = logs.slice(-MAX_DEV_LOGS)
    dev.metrics.toolCallsCount = recentToolCalls
    dev.metrics.filesModified = Array.from(files).slice(0, MAX_DEV_FILES)
    dev.metrics.tokensUsed = metas.reduce((sum, meta) => {
      const tokens = typeof meta.last_prompt_tokens === 'number' ? meta.last_prompt_tokens
        : typeof meta.total_tokens === 'number' ? meta.total_tokens : 0
      return sum + Math.max(0, tokens)
    }, 0)
    dev.metrics.durationMs = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0
    dev.topology = buildTopologyFromAccumulator(DEV_ID, 'Hermes Development', status, acc, MAX_DEV_FILES)
    broadcast({ type: 'agent:registered', agent: dev })
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
      syncDevelopmentAgent()
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
    gateway.topology = buildSimpleStatusTopology(
      GATEWAY_ID,
      'Hermes Gateway',
      gatewayStatus,
      safe.gateway_state ? `state: ${safe.gateway_state}` : 'state: unknown',
    )

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
    dashboard.topology = buildSimpleStatusTopology(
      DASHBOARD_ID, 'Hermes Dashboard', 'running', `polled: ${safe.polled_at.slice(11, 19)}`,
    )

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
    sessions.topology = buildSimpleStatusTopology(
      SESSIONS_ID, 'Hermes Sessions', sessionsStatus, `active: ${sessionCount}`,
    )

    // ── per-session agents and aggregate development view from local files ─────
    syncSessionAgents()
    syncDevelopmentAgent()
  }

  void poll()
  const handle = setInterval(() => { void poll() }, POLL_MS)
  return () => { clearInterval(handle) }
}
