// leases.mjs — per-session "liveness lease" files + the daemon's pure liveness rule.
//
// The forwarder writes/refreshes a lease on every hook: which sessions exist on
// this machine, and where each one's transcript lives. The fleet-daemon reads them
// every ~45s and reports the sessions that still look ALIVE (recent transcript
// write OR recent hook) to /v1/heartbeat. Splitting the *rule* (classifyLeases,
// pure) from the *IO* keeps the rule unit-testable without touching the filesystem.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from './config.mjs'

// A session counts as alive while its last sign of life (the NEWER of: transcript
// mtime, last hook time) is within this window — so a long build/test that emits no
// hooks for minutes still beats, but an ended / idle / hung-then-abandoned session
// stops beating (and its ship leaves the map). Kept in step with the backend's
// KEEPALIVE_MAX_MS (projection.mjs) so producer and consumer agree on "alive".
export const SESSION_IDLE_MAX_MS = 20 * 60 * 1000
// Past this, the lease file itself is garbage-collected — the session is long gone
// and never sent SessionEnd (terminal closed, claude crashed, kill -9).
export const LEASE_EXPIRE_MS = 30 * 60 * 1000

const safeName = (sid) => String(sid).replace(/[^A-Za-z0-9._-]/g, '_')
const leasePath = (sid) => join(SESSIONS_DIR, `${safeName(sid)}.json`)

/**
 * Pure: split leases into the sessions to BEAT (live) vs the dead leases to delete
 * (expired). `mtimeOf(path)` returns a transcript's mtime in epoch ms (0 if gone),
 * injected so the rule is testable without the filesystem.
 */
export function classifyLeases(leases, { now, mtimeOf }) {
  const live = []
  const expired = []
  for (const L of leases) {
    if (!L || !L.sessionId) continue
    const tMtime = L.transcript ? (mtimeOf(L.transcript) || 0) : 0
    const lastSign = Math.max(tMtime, L.at || 0)
    const age = now - lastSign
    if (age <= SESSION_IDLE_MAX_MS) live.push(L.sessionId)
    else if (age > LEASE_EXPIRE_MS) expired.push(L.sessionId)
    // SESSION_IDLE_MAX < age <= LEASE_EXPIRE: silent (don't beat), but keep the
    // lease a while longer in case the session resumes before we GC it.
  }
  return { live, expired }
}

// --- filesystem IO (best-effort; callers never throw on these) ---------------

/** Write/refresh a session's lease (atomic rename). */
export function writeLease(sessionId, { transcript, host, agent, at } = {}) {
  if (!sessionId) return
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const path = leasePath(sessionId)
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({
      sessionId: String(sessionId),
      transcript: transcript || '',
      host: host || '',
      agent: agent || 'claude',
      at: at || Date.now(),
    }))
    renameSync(tmp, path)
  } catch { /* never block the agent */ }
}

/** Remove a session's lease (on SessionEnd, or when the daemon GCs it). */
export function removeLease(sessionId) {
  try { unlinkSync(leasePath(sessionId)) } catch { /* already gone */ }
}

/** Read every lease on this machine (skips unreadable/garbage files). */
export function readLeases() {
  let names = []
  try { names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json')) } catch { return [] }
  const out = []
  for (const n of names) {
    try { out.push(JSON.parse(readFileSync(join(SESSIONS_DIR, n), 'utf8'))) } catch { /* skip */ }
  }
  return out
}

/** A file's mtime in epoch ms, or 0 if it's missing/unreadable. */
export function mtimeMs(path) {
  try { return statSync(path).mtimeMs } catch { return 0 }
}
