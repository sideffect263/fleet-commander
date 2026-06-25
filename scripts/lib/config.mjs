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
