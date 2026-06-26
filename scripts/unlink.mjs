#!/usr/bin/env node
// unlink.mjs — manually forget this Mac's pairing.
//
//   node unlink.mjs
//
// Drops the deviceToken + accountId from ~/.fleet-commander/config.json so the
// forwarder stops sending. Keeps baseUrl so the next /fleet-link reaches the
// same backend. (The forwarder also unlinks itself automatically when the
// backend rejects a dead/deleted fleet — this is the manual escape hatch.)

import { readConfig, clearDeviceLink } from './lib/config.mjs'

const cfg = readConfig()

if (!cfg.deviceToken) {
  console.log('Already unlinked — this Mac is not paired to any fleet.')
  process.exit(0)
}

clearDeviceLink('unlinked manually via /fleet-unlink')
console.log('✓ Unlinked. This Mac will no longer send anything to the backend.')
console.log('  To pair again later: /fleet-link FLEET-XXXXXX')
