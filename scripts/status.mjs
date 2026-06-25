#!/usr/bin/env node
// status.mjs — show whether this Mac is paired and the backend reachable.

import { readConfig, CONFIG_PATH } from './lib/config.mjs'

const cfg = readConfig()

console.log('Fleet Commander — link status\n')
console.log(`  config:  ${CONFIG_PATH}`)
console.log(`  backend: ${cfg.baseUrl}`)
console.log(`  paired:  ${cfg.deviceToken ? 'yes' : 'no'}`)
if (cfg.accountId) console.log(`  account: ${cfg.accountId}`)

try {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 2000)
  const res = await fetch(`${cfg.baseUrl}/health`, { signal: ctl.signal })
  clearTimeout(t)
  console.log(`  health:  ${res.ok ? 'reachable ✓' : `HTTP ${res.status}`}`)
} catch (err) {
  console.log(`  health:  unreachable (${err.message})`)
}

if (!cfg.deviceToken) {
  console.log('\nNot paired yet. Open the iPhone app, then run:')
  console.log('  /fleet-link FLEET-XXXXXX')
}
