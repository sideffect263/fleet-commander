#!/usr/bin/env node
// ask-human.mjs — turn the ask_human MCP tool on/off.   node ask-human.mjs on|off
//
// When OFF (default), the ask_human MCP server advertises NO tool (0 per-turn
// schema tokens) and releases its resident node process. When ON, the agent gets
// the ask_human tool: it can pause and get a free-text answer from your phone.
//
// Writes the FULL config, preserving BOTH the approvals AND askHuman blocks — so
// flipping one toggle never drops the other (see the round-trip test).
import { readConfig, writeConfig } from './lib/config.mjs'

const arg = (process.argv[2] || '').toLowerCase()
const cfg = readConfig()

if (arg !== 'on' && arg !== 'off') {
  console.log(`ask_human is ${cfg.askHuman?.enabled ? 'ON' : 'OFF'}.`)
  console.log('Usage: node ask-human.mjs on|off')
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
  approvals: cfg.approvals, // preserve the other toggle
  askHuman: { enabled: arg === 'on' },
})

console.log(`✓ ask_human ${arg === 'on' ? 'ENABLED' : 'disabled'}.`)
console.log('  Takes effect on the next agent turn (restart the session if it lingers).')
