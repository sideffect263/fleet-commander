#!/usr/bin/env node
// approvals.mjs — turn remote phone-approval on/off.   node approvals.mjs on|off
import { readConfig, writeConfig } from './lib/config.mjs'

const arg = (process.argv[2] || '').toLowerCase()
const cfg = readConfig()
const tools = cfg.approvals?.tools || ['Bash']

if (arg !== 'on' && arg !== 'off') {
  console.log(`Remote approvals are ${cfg.approvals?.enabled ? 'ON' : 'OFF'} (gated tools: ${tools.join(', ')}).`)
  console.log('Usage: node approvals.mjs on|off')
  process.exit(0)
}

if (!cfg.deviceToken) {
  console.error('Not paired yet — run /fleet-link first.')
  process.exit(1)
}

writeConfig({
  baseUrl: cfg.baseUrl,
  deviceToken: cfg.deviceToken,
  accountId: cfg.accountId,
  approvals: { enabled: arg === 'on', tools },
})

console.log(`✓ Remote approvals ${arg === 'on' ? 'ENABLED' : 'disabled'}.`)
if (arg === 'on') {
  console.log(`  ${tools.join(', ')} actions will now wait for approval on your phone before running.`)
  console.log('  Turn off anytime with: /fleet-approvals off')
}
