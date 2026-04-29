import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ClaudeControlMode = 'normal' | 'economy' | 'strict'

export interface ClaudeControlState {
  mode: ClaudeControlMode
  paused: boolean
  maxTurnsCap: number
  minStartIntervalSeconds: number
  updatedAt: string
}

export type ClaudeRuntimeStatus = 'ready' | 'cooling' | 'paused'

export interface ClaudeRuntimeState {
  status: ClaudeRuntimeStatus
  lastStartAt: string | null
  nextAllowedAt: string | null
  cooldownRemainingSeconds: number
}

export interface ClaudeControlAuditEntry {
  timestamp: string
  mode: ClaudeControlMode
  paused: boolean
  maxTurnsCap: number
  minStartIntervalSeconds: number
  changes: Array<'mode' | 'paused'>
}

export interface ClaudeControlPatch {
  mode?: unknown
  paused?: unknown
}

const CONTROL_FILE = process.env['AGENTDECK_CLAUDE_CONTROL_FILE'] ?? '/root/.hermes/claude-control.env'
const STATE_FILE = process.env['AGENTDECK_CLAUDE_STATE_FILE'] ?? '/tmp/hermes-claude-code-last-start'
const AUDIT_FILE = process.env['AGENTDECK_CLAUDE_AUDIT_FILE'] ?? '/root/.hermes/claude-control.audit.jsonl'

const MODE_SETTINGS: Record<ClaudeControlMode, { maxTurnsCap: number; minStartIntervalSeconds: number }> = {
  normal:  { maxTurnsCap: 10, minStartIntervalSeconds: 60 },
  economy: { maxTurnsCap: 5,  minStartIntervalSeconds: 120 },
  strict:  { maxTurnsCap: 3,  minStartIntervalSeconds: 300 },
}

function isMode(value: unknown): value is ClaudeControlMode {
  return value === 'normal' || value === 'economy' || value === 'strict'
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Z0-9_]+)=([A-Za-z0-9_.:-]+)$/.exec(trimmed)
    if (!match) continue
    env[match[1] ?? ''] = match[2] ?? ''
  }
  return env
}

export function controlStateForMode(mode: ClaudeControlMode, now = new Date()): ClaudeControlState {
  return {
    mode,
    paused: false,
    ...MODE_SETTINGS[mode],
    updatedAt: now.toISOString(),
  }
}

export function defaultClaudeControl(now = new Date()): ClaudeControlState {
  return controlStateForMode('normal', now)
}

export function formatClaudeControlEnv(state: ClaudeControlState): string {
  return [
    '# AgentDeck Claude Code control state — safe scalar values only.',
    `HERMES_CLAUDE_CONTROL_MODE=${state.mode}`,
    `HERMES_CLAUDE_PAUSED=${state.paused ? '1' : '0'}`,
    `HERMES_CLAUDE_MAX_TURNS_CAP=${state.maxTurnsCap}`,
    `HERMES_CLAUDE_MIN_START_INTERVAL_SECONDS=${state.minStartIntervalSeconds}`,
    `HERMES_CLAUDE_CONTROL_UPDATED_AT=${state.updatedAt}`,
    '',
  ].join('\n')
}

export async function readClaudeControl(path = CONTROL_FILE, now = new Date()): Promise<ClaudeControlState> {
  const fallback = defaultClaudeControl(now)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return fallback
  }

  const env = parseEnv(raw)
  const mode = isMode(env['HERMES_CLAUDE_CONTROL_MODE']) ? env['HERMES_CLAUDE_CONTROL_MODE'] : fallback.mode
  const settings = MODE_SETTINGS[mode]
  return {
    mode,
    paused: parseBool(env['HERMES_CLAUDE_PAUSED'], fallback.paused),
    maxTurnsCap: parsePositiveInt(env['HERMES_CLAUDE_MAX_TURNS_CAP'], settings.maxTurnsCap),
    minStartIntervalSeconds: parsePositiveInt(
      env['HERMES_CLAUDE_MIN_START_INTERVAL_SECONDS'],
      settings.minStartIntervalSeconds,
    ),
    updatedAt: env['HERMES_CLAUDE_CONTROL_UPDATED_AT'] ?? fallback.updatedAt,
  }
}

export async function updateClaudeControl(
  patch: ClaudeControlPatch,
  path = CONTROL_FILE,
  now = new Date(),
  auditPath = AUDIT_FILE,
): Promise<ClaudeControlState> {
  const current = await readClaudeControl(path, now)
  let next: ClaudeControlState = { ...current, updatedAt: now.toISOString() }
  const changes = new Set<'mode' | 'paused'>()

  if (patch.mode !== undefined) {
    if (!isMode(patch.mode)) throw new Error('Invalid Claude control mode')
    if (patch.mode !== current.mode) changes.add('mode')
    next = { ...controlStateForMode(patch.mode, now), paused: current.paused }
  }

  if (patch.paused !== undefined) {
    if (typeof patch.paused !== 'boolean') throw new Error('paused must be a boolean')
    if (patch.paused !== current.paused) changes.add('paused')
    next = { ...next, paused: patch.paused, updatedAt: now.toISOString() }
  }

  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, formatClaudeControlEnv(next), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
  if (changes.size > 0) await appendClaudeControlAudit(next, Array.from(changes), auditPath)
  return next
}

async function appendClaudeControlAudit(
  state: ClaudeControlState,
  changes: Array<'mode' | 'paused'>,
  path = AUDIT_FILE,
): Promise<void> {
  const entry: ClaudeControlAuditEntry = {
    timestamp: state.updatedAt,
    mode: state.mode,
    paused: state.paused,
    maxTurnsCap: state.maxTurnsCap,
    minStartIntervalSeconds: state.minStartIntervalSeconds,
    changes,
  }
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function isAuditEntry(value: unknown): value is ClaudeControlAuditEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Partial<ClaudeControlAuditEntry>
  return typeof entry.timestamp === 'string'
    && isMode(entry.mode)
    && typeof entry.paused === 'boolean'
    && typeof entry.maxTurnsCap === 'number'
    && typeof entry.minStartIntervalSeconds === 'number'
    && Array.isArray(entry.changes)
    && entry.changes.every(change => change === 'mode' || change === 'paused')
}

export async function readClaudeControlAudit(path = AUDIT_FILE, limit = 8): Promise<ClaudeControlAuditEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const entries: ClaudeControlAuditEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isAuditEntry(parsed)) entries.push(parsed)
    } catch {
      continue
    }
  }
  return entries.slice(Math.max(0, entries.length - Math.max(1, limit)))
}

function toIsoFromEpochSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString()
}

export function summarizeClaudeRuntime(
  control: ClaudeControlState,
  lastStartEpochSeconds: number | null,
  now = new Date(),
): ClaudeRuntimeState {
  if (lastStartEpochSeconds === null) {
    return {
      status: control.paused ? 'paused' : 'ready',
      lastStartAt: null,
      nextAllowedAt: null,
      cooldownRemainingSeconds: 0,
    }
  }

  const nextAllowedEpochSeconds = lastStartEpochSeconds + control.minStartIntervalSeconds
  const nowEpochSeconds = Math.floor(now.getTime() / 1000)
  const cooldownRemainingSeconds = Math.max(0, nextAllowedEpochSeconds - nowEpochSeconds)
  return {
    status: control.paused ? 'paused' : cooldownRemainingSeconds > 0 ? 'cooling' : 'ready',
    lastStartAt: toIsoFromEpochSeconds(lastStartEpochSeconds),
    nextAllowedAt: toIsoFromEpochSeconds(nextAllowedEpochSeconds),
    cooldownRemainingSeconds,
  }
}

export async function readClaudeRuntime(
  control: ClaudeControlState,
  path = STATE_FILE,
  now = new Date(),
): Promise<ClaudeRuntimeState> {
  let lastStartEpochSeconds: number | null = null
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    if (/^\d+$/.test(raw)) lastStartEpochSeconds = Number(raw)
  } catch {
    lastStartEpochSeconds = null
  }
  return summarizeClaudeRuntime(control, lastStartEpochSeconds, now)
}
