#!/usr/bin/env node
// link.mjs — pair this Mac with the phone that's showing a code.
//
//   node link.mjs FLEET-XXXXXX
//
// Claims the code at the backend, then saves the returned deviceToken to
// ~/.fleet-commander/config.json so the forwarder can start sending events.

import { readConfig, writeConfig } from './lib/config.mjs'

const code = (process.argv[2] || '').trim().toUpperCase()
if (!code) {
  console.error('Usage: node link.mjs FLEET-XXXXXX  (the code shown in the iPhone app)')
  process.exit(1)
}

const cfg = readConfig()

try {
  const res = await fetch(`${cfg.baseUrl}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const why = {
      unknown_code: 'that code is not recognized — re-check it in the app',
      already_claimed: 'that code was already used — tap "new code" in the app',
      expired: 'that code expired — generate a fresh one in the app',
      missing_code: 'no code provided',
      too_many_attempts: 'too many attempts — wait a minute and try again',
    }[data.error] || data.error || `HTTP ${res.status}`
    console.error(`✗ Pairing failed: ${why}`)
    process.exit(1)
  }
  writeConfig({ baseUrl: cfg.baseUrl, deviceToken: data.deviceToken, accountId: data.accountId })
  console.log(`✓ Paired! This Mac is now linked to your Fleet Commander phone.`)
  console.log(`  account: ${data.accountId}`)
  console.log(`  backend: ${cfg.baseUrl}`)
  console.log(`\nYour next Claude Code actions will appear as ships on your phone.`)
} catch (err) {
  console.error(`✗ Could not reach the backend at ${cfg.baseUrl}: ${err.message}`)
  console.error(`  (set FLEET_CLOUD_URL to point at a different backend.)`)
  process.exit(1)
}
