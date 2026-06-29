#!/usr/bin/env node
// forwarder.mjs — wired to every coding-agent hook.
//
// Claude Code wires it via hooks/hooks.json; Codex CLI wires it via
// codex/hooks.json (see README "Codex" section). Both agents emit the SAME
// hook stdin shape (session_id, cwd, hook_event_name, tool_name, tool_input,
// transcript_path) so this one script serves both.
//
// On each hook it: reads the event JSON on stdin, attaches the latest assistant
// token usage from the transcript tail, and POSTs a compact envelope to the
// cloud's /v1/ingest. On "quiet" events (Stop/SessionEnd), and no more than once
// per throttle window, it also recomputes 5h/week stats and POSTs /v1/stats.
//
// The `agent` it reports comes from FLEET_AGENT (default 'claude'); the Codex
// install path sets FLEET_AGENT=codex. The backend validates it against
// claude|codex|gemini|cursor|aider and uses it to skin the ship.
//
// Hard rules: never block the agent. If unpaired, offline, or slow, it exits
// quietly and fast. Pure Node builtins — no npm install for the user.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  readConfig, USAGE_CACHE_PATH, STATS_THROTTLE_PATH,
  readAuthState, writeAuthState, clearDeviceLink, DAEMON_PID_PATH,
} from './lib/config.mjs'
import { latestAssistantUsage, computeStats } from './lib/transcript.mjs'
import { writeLease, removeLease } from './lib/leases.mjs'

// Absolute backstop: whatever happens, this process dies fast.
const HARD_EXIT_MS = 2500
const hardTimer = setTimeout(() => process.exit(0), HARD_EXIT_MS)
hardTimer.unref?.()

const STATS_THROTTLE_MS = 45_000
const FETCH_TIMEOUT_MS = 1200

// How many consecutive auth rejections (401/403) from the backend before we
// decide the fleet is dead and unlink this Mac. >1 so a single backend hiccup
// can't drop a healthy pairing; the backend only 401s when the token genuinely
// no longer resolves to an account, so 3 in a row is a confident "it's gone".
const AUTH_STRIKE_LIMIT = 3

// Which coding agent is this hook firing for. Claude's install path leaves it
// unset (→ 'claude'); the Codex install path sets FLEET_AGENT=codex. Backend
// re-validates against claude|codex|gemini|cursor|aider.
const AGENT = process.env.FLEET_AGENT || 'claude'

function done() { clearTimeout(hardTimer); process.exit(0) }

// §4.C host liveness ---------------------------------------------------------
// Is the per-machine heartbeat daemon already running?
function daemonAlive() {
  try {
    if (!existsSync(DAEMON_PID_PATH)) return false
    const pid = Number(readFileSync(DAEMON_PID_PATH, 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch (e) { return e?.code === 'EPERM' }
}

// Spawn the per-machine heartbeat daemon if it isn't already running. Detached +
// unref'd so it outlives this short-lived hook; the daemon self-singletons via the
// pidfile, so even a spawn race converges to one daemon. Never throws.
function ensureDaemon() {
  if (process.env.FLEET_NO_DAEMON) return // escape hatch (tests / opt-out)
  if (daemonAlive()) return
  try {
    const script = fileURLToPath(new URL('./fleet-daemon.mjs', import.meta.url))
    spawn(process.execPath, [script], { detached: true, stdio: 'ignore' }).unref()
  } catch { /* best-effort — liveness is a bonus, never a blocker */ }
}

// Returns the HTTP status, or 0 when the request never completed (offline /
// timeout / DNS). 0 is "transient" — it must NOT count toward an auth strike,
// since a flaky network is not the same as a revoked token.
async function postJson(url, token, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    return res.status
  } catch { /* offline / slow — ignore, never block Claude Code */ return 0 } finally {
    clearTimeout(t)
  }
}

// React to the backend's verdict on our device token. 401/403 means the token
// no longer resolves to an account (fleet deleted or link revoked) — count a
// strike, and once we hit the limit, unlink so the Mac stops sending. Any 2xx
// clears the strike count. Other statuses (transient 0, 4xx body errors, 5xx)
// are left alone — they aren't statements about the token's validity.
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

function statsDue() {
  try {
    const { at } = JSON.parse(readFileSync(STATS_THROTTLE_PATH, 'utf8'))
    if (Date.now() - at < STATS_THROTTLE_MS) return false
  } catch { /* no file yet → due */ }
  try { writeFileSync(STATS_THROTTLE_PATH, JSON.stringify({ at: Date.now() })) } catch {}
  return true
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
  })
}

async function main() {
  const cfg = readConfig()
  if (!cfg.deviceToken) return done() // not paired yet — nothing to do.

  const raw = await readStdin()
  let hook
  try { hook = JSON.parse(raw) } catch { return done() }

  const name = hook.hook_event_name || hook.hookEventName
  const sessionId = hook.session_id || hook.sessionId
  if (!name || !sessionId) return done()

  // Latest message usage → context %. Best-effort; tool events carry the freshest.
  let usage = null
  try { usage = await latestAssistantUsage(hook.transcript_path || hook.transcriptPath) } catch {}

  const status = await postJson(`${cfg.baseUrl}/v1/ingest`, cfg.deviceToken, {
    name,
    sessionId,
    agent: AGENT,
    // Privacy: send only the project folder name, never the full path (which
    // would leak the username + client/project directory names to the cloud).
    // Applies to Codex too — same A.1 basename stripping.
    cwd: hook.cwd ? basename(hook.cwd) : undefined,
    toolName: hook.tool_name || hook.toolName,
    timestamp: new Date().toISOString(),
    usage: usage || undefined,
  })

  // Self-unlink when the backend says this token is dead. If that happened,
  // the token is gone now — skip the stats post below.
  reactToAuth(status)
  if (status === 401 || status === 403) return done()

  // Usage stats intentionally NOT posted: the 5h/week % was cost ÷ an arbitrary
  // hardcoded budget (meaningless for a subscription), and there's no reliable
  // way to measure real rate-limit consumption from a transcript. Removed.

  // §4.C host liveness: keep this session's lease current + make sure the
  // per-machine heartbeat daemon is running. Instant (one file write + a detached
  // spawn) and best-effort — it must never delay or block the agent (3s hook budget).
  try {
    if (name === 'SessionEnd') removeLease(sessionId)
    else writeLease(sessionId, { transcript: hook.transcript_path || hook.transcriptPath || '', agent: AGENT, at: Date.now() })
    ensureDaemon()
  } catch { /* never block the agent */ }

  done()
}

main().catch(() => done())
