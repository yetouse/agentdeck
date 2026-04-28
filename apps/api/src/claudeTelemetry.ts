import { readFile } from 'node:fs/promises'

export type ClaudePressure = 'calm' | 'elevated' | 'high'

export interface ClaudeStartEvent {
  timestamp: string
  type: 'start'
  printMode: boolean
  cap: number
  cappedOrAdded: boolean
  argc: number
}

export interface ClaudeWaitEvent {
  timestamp: string
  type: 'wait'
  waitSeconds: number
  reason: string
}

export type ClaudeThrottleEvent = ClaudeStartEvent | ClaudeWaitEvent

export interface ClaudeTelemetrySummary {
  source: string
  updatedAt: string
  launches1h: number
  waits1h: number
  capped1h: number
  totalWaitSeconds1h: number
  pressure: ClaudePressure
  recentEvents: ClaudeThrottleEvent[]
}

const DEFAULT_LOG_PATH = '/root/.hermes/logs/claude-throttle.log'
const ONE_HOUR_MS = 60 * 60 * 1000
const MAX_LINES = 300
const MAX_RECENT_EVENTS = 12

function numericField(line: string, name: string): number | null {
  const match = line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)s?(?:\\s|$)`))
  return match ? Number(match[1]) : null
}

function textField(line: string, name: string): string | null {
  const match = line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?:\\s|$)`))
  return match ? match[1]! : null
}

export function parseClaudeThrottleLine(line: string): ClaudeThrottleEvent | null {
  const trimmed = line.trim()
  const match = trimmed.match(/^(\S+)\s+(.+)$/)
  if (!match) return null

  const timestamp = match[1]!
  const rest = match[2]!
  if (Number.isNaN(Date.parse(timestamp))) return null

  if (rest.startsWith('start ')) {
    const printMode = numericField(rest, 'print_mode')
    const cap = numericField(rest, 'cap')
    const cappedOrAdded = numericField(rest, 'capped_or_added')
    const argc = numericField(rest, 'argc')
    if (printMode === null || cap === null || cappedOrAdded === null || argc === null) return null
    return {
      timestamp,
      type: 'start',
      printMode: printMode === 1,
      cap,
      cappedOrAdded: cappedOrAdded === 1,
      argc,
    }
  }

  if (rest.startsWith('wait=')) {
    const waitSeconds = numericField(rest, 'wait')
    const reason = textField(rest, 'reason')
    if (waitSeconds === null || reason === null) return null
    return { timestamp, type: 'wait', waitSeconds, reason }
  }

  return null
}

export function summarizeClaudeTelemetry(events: ClaudeThrottleEvent[], now = new Date()): Omit<ClaudeTelemetrySummary, 'source' | 'updatedAt'> {
  const cutoff = now.getTime() - ONE_HOUR_MS
  const events1h = events.filter(event => Date.parse(event.timestamp) >= cutoff)
  const starts1h = events1h.filter((event): event is ClaudeStartEvent => event.type === 'start')
  const waits1h = events1h.filter((event): event is ClaudeWaitEvent => event.type === 'wait')
  const capped1h = starts1h.filter(event => event.cappedOrAdded).length
  const totalWaitSeconds1h = waits1h.reduce((sum, event) => sum + event.waitSeconds, 0)

  let pressure: ClaudePressure = 'calm'
  if (starts1h.length >= 8 || waits1h.length >= 4 || totalWaitSeconds1h >= 300) pressure = 'elevated'
  if (starts1h.length >= 14 || waits1h.length >= 8 || totalWaitSeconds1h >= 900) pressure = 'high'

  return {
    launches1h: starts1h.length,
    waits1h: waits1h.length,
    capped1h,
    totalWaitSeconds1h,
    pressure,
    recentEvents: events.slice(-MAX_RECENT_EVENTS).reverse(),
  }
}

export async function readClaudeTelemetry(logPath = process.env['AGENTDECK_CLAUDE_THROTTLE_LOG'] ?? DEFAULT_LOG_PATH): Promise<ClaudeTelemetrySummary> {
  const updatedAt = new Date().toISOString()
  let raw = ''
  try {
    raw = await readFile(logPath, 'utf8')
  } catch {
    return {
      source: 'unavailable',
      updatedAt,
      launches1h: 0,
      waits1h: 0,
      capped1h: 0,
      totalWaitSeconds1h: 0,
      pressure: 'calm',
      recentEvents: [],
    }
  }

  const events = raw
    .split('\n')
    .slice(-MAX_LINES)
    .map(parseClaudeThrottleLine)
    .filter((event): event is ClaudeThrottleEvent => event !== null)

  return {
    source: 'claude-throttle-log',
    updatedAt,
    ...summarizeClaudeTelemetry(events),
  }
}
