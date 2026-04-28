import * as assert from 'node:assert/strict'
import { parseClaudeThrottleLine, summarizeClaudeTelemetry } from './claudeTelemetry.js'

const start = parseClaudeThrottleLine('2026-04-28T17:39:58+00:00 start print_mode=1 cap=10 capped_or_added=1 argc=8')
assert.deepEqual(start, {
  timestamp: '2026-04-28T17:39:58+00:00',
  type: 'start',
  printMode: true,
  cap: 10,
  cappedOrAdded: true,
  argc: 8,
})

const wait = parseClaudeThrottleLine('2026-04-28T17:40:12+00:00 wait=44s reason=min_start_interval')
assert.deepEqual(wait, {
  timestamp: '2026-04-28T17:40:12+00:00',
  type: 'wait',
  waitSeconds: 44,
  reason: 'min_start_interval',
})

assert.equal(parseClaudeThrottleLine('not a throttle line'), null)

const summary = summarizeClaudeTelemetry([
  start,
  wait,
  parseClaudeThrottleLine('2026-04-28T17:41:30+00:00 start print_mode=0 cap=10 capped_or_added=0 argc=1'),
].filter(event => event !== null), new Date('2026-04-28T17:42:00+00:00'))

assert.equal(summary.launches1h, 2)
assert.equal(summary.waits1h, 1)
assert.equal(summary.capped1h, 1)
assert.equal(summary.pressure, 'calm')
assert.equal(summary.recentEvents.length, 3)
console.log('claudeTelemetry tests passed')
