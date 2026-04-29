import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const main = readFileSync(join(here, 'main.ts'), 'utf8')
const html = readFileSync(join(here, '..', 'index.html'), 'utf8')

assert.match(main, /type Locale\s*=\s*'fr'\s*\|\s*'en'/, 'UI should define explicit French and English locales')
assert.match(main, /const translations:\s*Record<Locale,\s*Record<string,\s*string>>/, 'UI should keep labels in a typed translation dictionary')
assert.match(main, /function setLocale\(next:\s*Locale\):\s*void/, 'UI should expose one locale switch path')
assert.match(main, /function tr\(key:\s*string\):\s*string/, 'UI should render labels through a translation helper')
assert.match(html, /id="language-switch"/, 'topbar should include a language switcher')
assert.match(main, /localStorage\.setItem\('agentdeck-locale'/, 'language choice should persist locally')

const requiredKeys = [
  'hero.eyebrow',
  'hero.title',
  'hero.subtitle',
  'nav.now',
  'nav.system',
  'nav.history',
  'topbar.language',
  'topology.title',
  'topology.observed',
  'topology.inferred',
  'topology.workstreams',
  'topology.observedTier',
  'activity.title',
  'files.title',
  'control.title',
  'claude.rateLimitNote',
]

for (const locale of ['fr', 'en']) {
  const block = main.match(new RegExp(`${locale}:\\s*\\{([\\s\\S]*?)\\n  \\}`, 'm'))
  assert.ok(block, `missing ${locale} translation block`)
  for (const key of requiredKeys) {
    assert.match(block[1], new RegExp(`['"]${key}['"]\\s*:`), `missing ${locale}.${key}`)
  }
}

console.log('i18n source tests passed')
