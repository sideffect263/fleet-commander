#!/usr/bin/env node
// status.mjs — show whether this Mac is paired, the backend reachable, and the
// link still accepted. If the backend says the device token is dead (the fleet
// was deleted / the link revoked), this unlinks the Mac on the spot.

import { readConfig, CONFIG_PATH, readAuthState, clearDeviceLink } from './lib/config.mjs'

const cfg = readConfig()
const auth = readAuthState()

console.log('Fleet Commander — link status\n')
console.log(`  config:  ${CONFIG_PATH}`)
console.log(`  backend: ${cfg.baseUrl}`)
console.log(`  paired:  ${cfg.deviceToken ? 'yes' : 'no'}`)
if (cfg.accountId) console.log(`  account: ${cfg.accountId}`)

// Backend reachability (unauthenticated).
try {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 2000)
  const res = await fetch(`${cfg.baseUrl}/health`, { signal: ctl.signal })
  clearTimeout(t)
  console.log(`  health:  ${res.ok ? 'reachable ✓' : `HTTP ${res.status}`}`)
} catch (err) {
  console.log(`  health:  unreachable (${err.message})`)
}

// Liveness of THIS link: probe an authenticated, side-effect-free endpoint.
// 401/403 → the token is dead; clean it up so the forwarder goes quiet.
let unlinkedNow = false
if (cfg.deviceToken) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 2000)
    const res = await fetch(`${cfg.baseUrl}/v1/ping`, {
      headers: { authorization: `Bearer ${cfg.deviceToken}` },
      signal: ctl.signal,
    })
    clearTimeout(t)
    if (res.status === 401 || res.status === 403) {
      clearDeviceLink('link check returned ' + res.status + ' — the fleet was deleted or this link was revoked')
      unlinkedNow = true
      console.log(`  link:    DEAD ✗ — unlinked this Mac (fleet deleted or link revoked)`)
    } else if (res.ok) {
      console.log(`  link:    alive ✓`)
    } else if (res.status === 404) {
      // Backend predates /v1/ping — can't actively verify; fall back to strikes.
      console.log(`  link:    unverified (backend has no /v1/ping yet)`)
    } else {
      console.log(`  link:    HTTP ${res.status}`)
    }
  } catch {
    console.log(`  link:    unverified (backend unreachable)`)
  }
  if (!unlinkedNow && (auth.strikes || 0) > 0) {
    console.log(`  warning: backend has rejected this link ${auth.strikes}× recently — it will auto-unlink on repeated failure`)
  }
}

// Explain a prior auto-unlink so the user isn't confused about why they went dark.
if (!cfg.deviceToken && auth.unlinkedAt && !unlinkedNow) {
  console.log(`\n  last unlink: ${auth.unlinkedAt}`)
  if (auth.reason) console.log(`               ${auth.reason}`)
}

if (!cfg.deviceToken) {
  console.log('\nNot paired. Open the iPhone app, then run:')
  console.log('  /fleet-link FLEET-XXXXXX')
}
