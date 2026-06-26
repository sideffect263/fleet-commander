// config.mjs — where the plugin keeps its pairing state on the user's machine.
//
//   ~/.fleet-commander/config.json   { baseUrl, deviceToken, accountId }
//
// baseUrl can be overridden by the FLEET_CLOUD_URL env var (handy for pointing
// at a local backend during development).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_DIR = join(homedir(), '.fleet-commander')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
export const USAGE_CACHE_PATH = join(CONFIG_DIR, 'usage-cache.json')
export const STATS_THROTTLE_PATH = join(CONFIG_DIR, 'last-stats.json')
// Tracks consecutive auth rejections from the backend so a dead/deleted fleet
// gets unlinked automatically (see forwarder.mjs). Also remembers the last
// auto-unlink so /fleet-status can explain it.
export const AUTH_STATE_PATH = join(CONFIG_DIR, 'auth-state.json')

// Production backend (Cloudflare Worker). A custom domain can map here later.
const DEFAULT_BASE_URL = 'https://fleet-commander-backend.arielxx263.workers.dev'

export function readConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch {}
  return {
    baseUrl: process.env.FLEET_CLOUD_URL || file.baseUrl || DEFAULT_BASE_URL,
    deviceToken: file.deviceToken || null,
    accountId: file.accountId || null,
    // Remote approvals are OFF by default — the approval hook is a no-op unless
    // explicitly enabled (so it never blocks normal work).
    approvals: file.approvals || { enabled: false, tools: ['Bash'] },
  }
}

export function writeConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, CONFIG_PATH)
}

// --- auth state: consecutive-auth-failure tracking + auto-unlink ------------

export function readAuthState() {
  try { return JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf8')) } catch { return { strikes: 0 } }
}

export function writeAuthState(state) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2))
  } catch { /* best-effort — never block the agent */ }
}

/**
 * Forget this Mac's pairing because the backend no longer accepts it (the fleet
 * was deleted on the phone, or the link was revoked). Keeps baseUrl so the next
 * /fleet-link talks to the same backend, drops deviceToken + accountId so the
 * forwarder goes quiet, and records why so /fleet-status can explain it.
 */
export function clearDeviceLink(reason) {
  const prev = readConfig()
  writeConfig({ baseUrl: prev.baseUrl }) // readConfig refills the rest with defaults
  writeAuthState({ strikes: 0, unlinkedAt: new Date().toISOString(), reason })
}
