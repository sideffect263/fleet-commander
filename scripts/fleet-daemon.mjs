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
import {
  readConfig, DAEMON_PID_PATH, CONFIG_DIR,
  readAuthState, writeAuthState, clearDeviceLink,
} from './lib/config.mjs'
import { readLeases, removeLease, classifyLeases, mtimeMs } from './lib/leases.mjs'
import { drain, outboxSize } from './lib/outbox.mjs'

const INTERVAL_MS = 45_000
const FETCH_TIMEOUT_MS = 2_000
// Exit after this many consecutive ticks with no live sessions AND no leases left —
// keeps the host "alive" briefly after the last session ends, then lets the daemon
// die so it isn't a permanent background process on an idle machine.
const IDLE_TICKS_BEFORE_EXIT = 3
// How many consecutive auth rejections (401/403) while DRAINING before we decide
// the fleet is dead and unlink this Mac. >1 so a single backend hiccup can't drop a
// healthy pairing; the backend only 401s when the token genuinely no longer resolves
// to an account, so 3 in a row is a confident "it's gone". (Moved here from the
// forwarder, which no longer touches the network — the daemon owns delivery now.)
const AUTH_STRIKE_LIMIT = 3
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

// POST one outbox event to /v1/ingest. Returns the HTTP status, or 0 when the
// request never completed (offline / timeout / DNS) — 0 is "transient", it must
// NOT count as an auth strike, since a flaky network is not a revoked token.
async function postIngest(baseUrl, token, ev) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(ev),
      signal: ctl.signal,
    })
    return res.status
  } catch { return 0 } finally { clearTimeout(t) }
}

// React to the backend's verdict on our device token while draining. 401/403 means
// the token no longer resolves to an account (fleet deleted or link revoked) — count
// a strike, and once we hit the limit, unlink so the Mac stops sending. Any 2xx
// clears the strike count. Other statuses (transient 0, 4xx body errors, 5xx) are
// left alone — they aren't statements about the token's validity.
function reactToAuth(status) {
  if (status === 401 || status === 403) {
    const strikes = (readAuthState().strikes || 0) + 1
    if (strikes >= AUTH_STRIKE_LIMIT) {
      clearDeviceLink('the backend rejected this link repeatedly — the fleet was deleted or the link was revoked')
    } else {
      writeAuthState({ strikes })
    }
  } else if (status >= 200 && status < 300) {
    if ((readAuthState().strikes || 0) !== 0) writeAuthState({ strikes: 0 })
  }
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

  // Drain the fire-and-forget outbox the forwarder appends to on every hook.
  // This is where the /v1/ingest POST now happens (off the agent's hot path).
  // reactToAuth threads the last drain status into the 3-strike auto-unlink;
  // if that unlinks us, the next tick's readConfig() has no token and we stop.
  try {
    const { lastStatus } = await drain((ev) => postIngest(cfg.baseUrl, cfg.deviceToken, ev))
    reactToAuth(lastStatus)
  } catch { /* delivery is best-effort — the next beat retries the remainder */ }

  // Never exit while events are still queued: extend the idle guard so the
  // daemon stays alive to drain the outbox even after the last session ends.
  if (live.length === 0) {
    if (++emptyTicks >= IDLE_TICKS_BEFORE_EXIT && readLeases().length === 0 && outboxSize() === 0) {
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
