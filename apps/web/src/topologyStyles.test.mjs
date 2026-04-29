import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'styles.css'), 'utf8')

const mobile768 = css.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}\s*\n@media \(max-width: 480px\)/)
assert.ok(mobile768, 'expected a max-width: 768px responsive block')

const mobileCss = mobile768[1]
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = mobileCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `expected mobile CSS rule for ${selector}`)
  return match[1]
}

assert.match(rule('.inspector__panel-head'), /flex-direction:\s*column;/, 'mobile topology header should stack metadata and legend')
assert.match(rule('.topology-canvas'), /min-height:\s*auto;/, 'mobile topology canvas should not force a 34rem viewport')
assert.match(rule('.topology-canvas'), /overflow:\s*visible;/, 'mobile topology should avoid a nested horizontal scroller')
assert.match(rule('.topology-canvas__grid'), /grid-template-columns:\s*1fr;/, 'mobile topology tiers should become one readable column')
assert.match(rule('.topology-tier + .topology-tier .t-node--linked::before'), /width:\s*2px;/, 'mobile topology links should become vertical connectors')
assert.match(rule('.t-node'), /overflow:\s*visible;/, 'mobile topology nodes should allow vertical connectors to remain visible')
assert.match(rule('.t-node__label'), /white-space:\s*normal;/, 'mobile topology node labels should wrap instead of truncating')
assert.match(rule('.t-node__activity'), /white-space:\s*normal;/, 'mobile topology node activity should wrap instead of truncating')

console.log('topologyStyles tests passed')
