import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlStateForMode,
  formatClaudeControlEnv,
  readClaudeControl,
  readClaudeRuntime,
  summarizeClaudeRuntime,
  updateClaudeControl,
} from './claudeControl.js'

const now = new Date('2026-04-28T20:00:00.000Z')

assert.deepEqual(controlStateForMode('normal', now), {
  mode: 'normal',
  paused: false,
  maxTurnsCap: 10,
  minStartIntervalSeconds: 60,
  updatedAt: now.toISOString(),
})

assert.deepEqual(controlStateForMode('economy', now), {
  mode: 'economy',
  paused: false,
  maxTurnsCap: 5,
  minStartIntervalSeconds: 120,
  updatedAt: now.toISOString(),
})

assert.deepEqual(controlStateForMode('strict', now), {
  mode: 'strict',
  paused: false,
  maxTurnsCap: 3,
  minStartIntervalSeconds: 300,
  updatedAt: now.toISOString(),
})

const env = formatClaudeControlEnv({
  mode: 'strict',
  paused: true,
  maxTurnsCap: 3,
  minStartIntervalSeconds: 300,
  updatedAt: now.toISOString(),
})
assert.match(env, /HERMES_CLAUDE_CONTROL_MODE=strict/)
assert.match(env, /HERMES_CLAUDE_PAUSED=1/)
assert.match(env, /HERMES_CLAUDE_MAX_TURNS_CAP=3/)
assert.match(env, /HERMES_CLAUDE_MIN_START_INTERVAL_SECONDS=300/)
assert.doesNotMatch(env, /secret|token|password|prompt|argv/i)

assert.deepEqual(summarizeClaudeRuntime(
  { mode: 'economy', paused: false, maxTurnsCap: 5, minStartIntervalSeconds: 120, updatedAt: now.toISOString() },
  1_772_000_340,
  new Date(1_772_000_400_000),
), {
  status: 'cooling',
  lastStartAt: '2026-02-25T06:19:00.000Z',
  nextAllowedAt: '2026-02-25T06:21:00.000Z',
  cooldownRemainingSeconds: 60,
})

assert.deepEqual(summarizeClaudeRuntime(
  { mode: 'strict', paused: true, maxTurnsCap: 3, minStartIntervalSeconds: 300, updatedAt: now.toISOString() },
  null,
  now,
), {
  status: 'paused',
  lastStartAt: null,
  nextAllowedAt: null,
  cooldownRemainingSeconds: 0,
})

assert.deepEqual(summarizeClaudeRuntime(
  { mode: 'economy', paused: false, maxTurnsCap: 5, minStartIntervalSeconds: 120, updatedAt: now.toISOString() },
  1_772_000_000,
  new Date(1_772_000_400_000),
), {
  status: 'ready',
  lastStartAt: '2026-02-25T06:13:20.000Z',
  nextAllowedAt: '2026-02-25T06:15:20.000Z',
  cooldownRemainingSeconds: 0,
})

const dir = await mkdtemp(join(tmpdir(), 'agentdeck-claude-control-'))
try {
  const file = join(dir, 'claude-control.env')
  const saved = await updateClaudeControl({ mode: 'economy', paused: true }, file, now)
  assert.equal(saved.mode, 'economy')
  assert.equal(saved.paused, true)
  assert.equal(saved.maxTurnsCap, 5)
  assert.equal(saved.minStartIntervalSeconds, 120)

  const raw = await readFile(file, 'utf8')
  assert.match(raw, /HERMES_CLAUDE_PAUSED=1/)
  assert.match(raw, /HERMES_CLAUDE_CONTROL_UPDATED_AT=2026-04-28T20:00:00.000Z/)

  const read = await readClaudeControl(file)
  assert.equal(read.mode, 'economy')
  assert.equal(read.paused, true)
  assert.equal(read.maxTurnsCap, 5)
  assert.equal(read.minStartIntervalSeconds, 120)

  const stateFile = join(dir, 'last-start')
  await writeFile(stateFile, '1772000340\n', 'utf8')
  const runtime = await readClaudeRuntime(read, stateFile, new Date(1_772_000_400_000))
  assert.equal(runtime.status, 'paused')
  assert.equal(runtime.lastStartAt, '2026-02-25T06:19:00.000Z')
  assert.equal(runtime.cooldownRemainingSeconds, 60)

  const resumed = await updateClaudeControl({ paused: false }, file, now)
  assert.equal(resumed.mode, 'economy')
  assert.equal(resumed.paused, false)
} finally {
  await rm(dir, { recursive: true, force: true })
}

await assert.rejects(
  () => updateClaudeControl({ mode: 'turbo' }, join(tmpdir(), 'unused.env'), now),
  /Invalid Claude control mode/,
)

console.log('claudeControl tests passed')
