#!/usr/bin/env node
// link.mjs — pair this machine with the phone that's showing a code.
//
//   node link.mjs FLEET-XXXXXX
//
// Claims the code at the backend, then saves the returned deviceToken to
// ~/.fleet-commander/config.json so the forwarder can start sending events.
// The claim + persist logic lives in lib/install-common.mjs (linkFleet) so the
// unified `fleet setup` CLI shares it.

import { linkFleet } from './lib/install-common.mjs'

const code = (process.argv[2] || '').trim()
if (!code) {
  console.error('Usage: node link.mjs FLEET-XXXXXX  (the code shown in the iPhone app)')
  process.exit(1)
}

const r = await linkFleet(code)
if (!r.ok) {
  console.error(`✗ Pairing failed: ${r.message}`)
  process.exit(1)
}
console.log(`✓ Paired! This machine is now linked to your Fleet Commander phone.`)
console.log(`  account: ${r.accountId}`)
console.log(`  backend: ${r.baseUrl}`)
console.log(`\nYour next coding-agent actions will appear as ships on your phone.`)
