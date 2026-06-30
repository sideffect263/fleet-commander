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
// Per-session "allow this tool for the rest of the session" grants, set when you
// approve from the phone with scope=session. Lets the approval hook stop asking
// for that tool in that session (kills approve-every-Bash fatigue).
export const SESSION_ALLOWS_PATH = join(CONFIG_DIR, 'session-allows.json')
// §4.C host liveness. The forwarder writes a per-session "lease" here on each hook
// (which sessions exist + where each transcript lives); the fleet-daemon reads them
// to decide which sessions are still alive and beats /v1/heartbeat. daemon.pid makes
// the per-machine beat loop a singleton.
export const SESSIONS_DIR = join(CONFIG_DIR, 'sessions')
export const DAEMON_PID_PATH = join(CONFIG_DIR, 'daemon.pid')
// Stable, user-owned copy of the hook runtime. Non-marketplace agents (Codex,
// Cursor) point their hooks.json at THIS dir, never the plugin's own install dir
// — under npx/marketplace the plugin lives in an ephemeral, content-hashed cache
// that changes every version, which would leave the baked path dangling. `fleet
// setup` / install-codex copy the runtime here and bake this path.
export const SCRIPTS_DIR = join(CONFIG_DIR, 'scripts')

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

// --- session-scoped approval grants ----------------------------------------
// File shape: { "<sessionId>": { tools: { "<toolName>": true }, ts: <epochMs> } }
// Pruned by age so the file stays small (a session rarely outlives a day).

const SESSION_ALLOW_TTL_MS = 24 * 60 * 60 * 1000

function readSessionAllows() {
  try { return JSON.parse(readFileSync(SESSION_ALLOWS_PATH, 'utf8')) } catch { return {} }
}

/** Has this (session, tool) been approved "for the session" already? */
export function isSessionToolAllowed(sessionId, toolName) {
  if (!sessionId || !toolName) return false
  const rec = readSessionAllows()[sessionId]
  return !!(rec && rec.tools && rec.tools[toolName])
}

/** Record an "allow this tool for the rest of the session" grant (best-effort). */
export function allowToolForSession(sessionId, toolName) {
  if (!sessionId || !toolName) return
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const all = readSessionAllows()
    const now = Date.now()
    for (const [sid, rec] of Object.entries(all)) {
      if (!rec || (now - (rec.ts || 0)) > SESSION_ALLOW_TTL_MS) delete all[sid]
    }
    const rec = all[sessionId] || { tools: {}, ts: now }
    rec.tools[toolName] = true
    rec.ts = now
    all[sessionId] = rec
    const tmp = `${SESSION_ALLOWS_PATH}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(all))
    renameSync(tmp, SESSION_ALLOWS_PATH)
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
