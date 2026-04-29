import * as assert from 'node:assert/strict'
import { formatBuildLabel, getBuildInfo } from './buildInfo.js'

const info = getBuildInfo('0.2.0', 'abc1234')

assert.equal(info.name, 'AgentDeck')
assert.equal(info.version, '0.2.0')
assert.equal(info.commit, 'abc1234')
assert.equal(info.label, 'v0.2.0 · abc1234')
assert.doesNotMatch(JSON.stringify(info), /secret|token|password|prompt|argv|bearer|authorization/i)

assert.equal(formatBuildLabel('0.2.0', null), 'v0.2.0')
assert.equal(formatBuildLabel('0.2.0', 'abcdef123456'), 'v0.2.0 · abcdef1')

console.log('buildInfo tests passed')
