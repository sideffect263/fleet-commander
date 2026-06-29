#!/usr/bin/env node
// fleet-daemon.mjs — ONE per machine. Sends a host-liveness heartbeat every ~45s.
//
// WHY a daemon: Claude Code hooks only fire on tool boundaries, so from the event
// stream alone the backend can't tell "a long build is still running" from "the
// machine went to sleep" from "the session is wedged." This loop pings /v1/heartbeat
// INDEPENDENTLY of hooks, carrying the sessions that still look alive (recent
// transcript write or hook — see leases.classifyLeases). The backend uses it to:
//   • keep a long silent-but-alive build on the map (instead of pruning at 5 min),
//   • flag a session OFFLINE when its whole machine goes dark — rather than falsely
//     calling it "stuck" and paging you.
//
// LIFECYCLE: the forwarder spawns this (detached) whenever it isn't already running
// (singleton via daemon.pid). Each tick it re-reads config (so an unlink stops it),
// beats the host EVEN WITH ZERO active sessions (so one idle session isn't mistaken
// for the machine going offline), GCs dead leases, and exits once nothing has been
// alive for a short grace period — the next session's first hook respawns it.
//
// Hard rule, like the rest of the plugin: pure Node, no deps, never in the way.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { readConfig, DAEMON_PID_PATH, CONFIG_DIR } from './lib/config.mjs'
import { readLeases, removeLease, classifyLeases, mtimeMs } from './lib/leases.mjs'

const INTERVAL_MS = 45_000
const FETCH_TIMEOUT_MS = 2_000
// Exit after this many consecutive ticks with no live sessions AND no leases left —
// keeps the host "alive" briefly after the last session ends, then lets the daemon
// die so it isn't a permanent background process on an idle machine.
const IDLE_TICKS_BEFORE_EXIT = 3
// The machine name the user sees on their own phone (their own host — never a path).
const HOST = (hostname() || 'machine').replace(/\.local$/i, '').slice(0, 100)

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// --- singleton: if another daemon already owns the pidfile, bow out ----------
try {
  mkdirSync(CONFIG_DIR, { recursive: true })
  if (existsSync(DAEMON_PID_PATH)) {
    const existing = Number(readFileSync(DAEMON_PID_PATH, 'utf8'))
    if (existing && existing !== process.pid && pidAlive(existing)) process.exit(0)
  }
  writeFileSync(DAEMON_PID_PATH, String(process.pid))
} catch { /* best-effort */ }

function cleanup() {
  try {
    if (existsSync(DAEMON_PID_PATH) && Number(readFileSync(DAEMON_PID_PATH, 'utf8')) === process.pid) {
      unlinkSync(DAEMON_PID_PATH)
    }
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

async function beat(baseUrl, token, sessions) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    await fetch(`${baseUrl}/v1/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ host: HOST, sessions }),
      signal: ctl.signal,
    })
  } catch { /* offline / slow — the next beat tries again */ } finally { clearTimeout(t) }
}

let emptyTicks = 0
let stopped = false

async function tick() {
  if (stopped) return
  const cfg = readConfig()
  if (!cfg.deviceToken) { stopped = true; cleanup(); process.exit(0) } // unlinked → stop

  const now = Date.now()
  const { live, expired } = classifyLeases(readLeases(), { now, mtimeOf: mtimeMs })
  for (const sid of expired) removeLease(sid) // GC leases for long-dead sessions

  // Always beat the HOST (machine is alive), with whatever sessions are live.
  await beat(cfg.baseUrl, cfg.deviceToken, live)

  if (live.length === 0) {
    if (++emptyTicks >= IDLE_TICKS_BEFORE_EXIT && readLeases().length === 0) {
      stopped = true; cleanup(); process.exit(0)
    }
  } else {
    emptyTicks = 0
  }
}

// First beat immediately so a new session shows alive fast, then on the interval.
// Do NOT unref the timer — it's what keeps the daemon running.
tick()
setInterval(tick, INTERVAL_MS)
