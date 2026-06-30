#!/usr/bin/env node
// fleet-run.mjs — run Claude Code so you can answer its questions FROM YOUR PHONE.
//
//   fleet-run [...any normal `claude` args]
//
// This is a thin PTY wrapper around `claude`. It runs the real Claude Code TUI
// exactly as if you'd typed `claude` yourself — same keys, same colors, same
// everything. The one extra thing it does: in the background it polls the Fleet
// Commander backend for a free-text reply you sent from the iPhone/Watch app and,
// when one arrives, types it into the session for you (text + Enter). It's the
// mirror image of remote approvals — instead of the phone answering a yes/no, the
// phone answers a question (or sends any message) into the live session.
//
// HOW THE SESSION ID IS RESOLVED (so the phone targets the right ship):
//   We generate a UUID up front and launch `claude --session-id <uuid>`. Claude
//   Code uses that exact UUID as its session_id, and the forwarder hooks report
//   the same id — so the ship the phone sees is "claude:<uuid>", and that's the
//   key we poll for replies on. No guessing, no transcript scraping. If you pass
//   your own `--session-id`/`--resume`/`-r`, we respect it and skip injecting one
//   (see below) — reply targeting then only works if the resolved id matches.
//
// GRACEFUL DEGRADATION (keeps the plugin dependency-free for everyone else):
//   node-pty is a NATIVE module and is NOT a hard dependency of this plugin. If
//   it isn't installed (or fails to load), fleet-run prints a one-line hint and
//   simply runs `claude` normally — you lose only the phone-reply injection, not
//   Claude Code itself. Install it with:  npm i node-pty
//
// Hard rule, same as the rest of the plugin: never get in Claude Code's way.

import { spawn as childSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { readConfig } from './lib/config.mjs'

const POLL_INTERVAL_MS = 2000
const FETCH_TIMEOUT_MS = 4000

// Args we forward verbatim to `claude`.
const passthrough = process.argv.slice(2)

// If the user is already managing the session id themselves (explicit
// --session-id, or resuming a session), don't fight them: respect their choice
// and don't inject our own. Reply targeting still works whenever the resolved
// ship id matches what the phone shows.
const userManagesSession = passthrough.some(
  (a) => a === '--session-id' || a === '--resume' || a === '-r' || a === '-c' || a === '--continue',
)

// Generate the session id we'll force on Claude Code (unless the user owns it),
// so we know in advance the ship id the phone will target: "claude:<uuid>".
const sessionUuid = randomUUID()
const claudeArgs = userManagesSession
  ? passthrough
  : ['--session-id', sessionUuid, ...passthrough]

// The ship id the backend/app key replies on. Matches projection.mjs shipIdFor().
const shipSessionId = `claude:${sessionUuid}`

const cfg = readConfig()

// fleet-run is the LEGACY phone-reply path: it types your phone's reply into a live
// Claude TUI through a PTY — brittle, native-module-dependent (node-pty), Claude-only.
// The PREFERRED path is now the `ask_human` MCP tool: dependency-free, cross-agent,
// works headless — the agent CALLS it and blocks for your phone's answer. fleet-run
// is kept for the niche "push an UNSOLICITED message into a running session" case.
// Make the reply status LOUD so nobody is left guessing whether it's working.
function banner(enabled, detail) {
  const bar = '─'.repeat(66)
  const head = enabled
    ? `  📡 Phone replies ENABLED (legacy fleet-run) — ${detail}`
    : `  ⚠️  Phone replies DISABLED — ${detail}`
  process.stderr.write(`\n${bar}\n${head}\n     Prefer the ask_human MCP tool: the agent asks, you answer from your phone.\n${bar}\n\n`)
}

// Try to load node-pty. Missing/broken native build → graceful fallback.
async function loadPty() {
  try {
    const mod = await import('node-pty')
    return mod.default || mod
  } catch {
    return null
  }
}

// Plain pass-through: just become `claude`. Used when node-pty is unavailable,
// so users who never run fleet-run are never forced to install a native module.
function execPlain() {
  const child = childSpawn('claude', claudeArgs, { stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
  child.on('error', (err) => {
    console.error(`fleet-run: could not start claude — ${err.message}`)
    process.exit(1)
  })
}

async function fetchReply(token) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(`${cfg.baseUrl}/v1/sessions/${encodeURIComponent(shipSessionId)}/reply`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctl.signal,
    })
    if (!r.ok) return null
    const data = await r.json().catch(() => null)
    return data?.reply || null
  } catch { return null } finally { clearTimeout(t) }
}

async function main() {
  if (!cfg.deviceToken) {
    banner(false, 'this Mac isn\'t paired (run `fleet setup` / /fleet-link).')
    return execPlain()
  }
  if (userManagesSession) {
    banner(false, 'you supplied your own --session-id/--resume, so reply targeting is off.')
    return execPlain()
  }
  const pty = await loadPty()
  if (!pty) {
    banner(false, 'node-pty (a native module) isn\'t installed. `npm i node-pty` to enable — or just use ask_human.')
    return execPlain()
  }

  const shell = 'claude'
  const term = process.env.TERM || 'xterm-256color'
  const child = pty.spawn(shell, claudeArgs, {
    name: term,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  })

  // --- mirror PTY <-> this terminal (raw mode so the TUI works normally) ----
  const stdin = process.stdin
  const wasRaw = stdin.isTTY ? stdin.isRaw : false
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.resume()

  child.onData((d) => process.stdout.write(d))
  const onStdin = (d) => child.write(d.toString('utf8'))
  stdin.on('data', onStdin)

  const onResize = () => {
    try { child.resize(process.stdout.columns || 80, process.stdout.rows || 30) } catch {}
  }
  process.stdout.on('resize', onResize)

  // --- background reply poller ----------------------------------------------
  // Only poll if we're paired AND we own the session id. If the user is managing
  // the session id themselves, our generated id is unused — there'd be no
  // matching ship — so skip polling rather than target a phantom session.
  let polling = false
  let pollTimer = null
  if (cfg.deviceToken && !userManagesSession) {
    banner(true, `ship ${shipSessionId}`)
    polling = true
    const tick = async () => {
      if (!polling) return
      const reply = await fetchReply(cfg.deviceToken)
      if (reply && typeof reply.text === 'string' && reply.text.length) {
        // Inject as if typed: the text, then Enter (\r) to submit. We do NOT
        // echo or log the text beyond writing it into the session.
        try { child.write(reply.text); child.write('\r') } catch {}
      }
      if (polling) pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  // --- teardown -------------------------------------------------------------
  const cleanup = () => {
    polling = false
    if (pollTimer) clearTimeout(pollTimer)
    stdin.removeListener('data', onStdin)
    process.stdout.removeListener('resize', onResize)
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw) } catch {} }
    stdin.pause()
  }

  child.onExit(({ exitCode, signal }) => {
    cleanup()
    process.exit(signal ? 1 : (exitCode ?? 0))
  })

  // Forward Ctrl-C etc. to the child rather than killing the wrapper outright,
  // so Claude Code handles them as it normally would.
  process.on('SIGINT', () => { try { child.write('\x03') } catch {} })
  process.on('SIGTERM', () => { try { child.kill() } catch {}; cleanup() })
}

main().catch((err) => {
  console.error(`fleet-run: ${err?.message || err} — falling back to plain claude`)
  execPlain()
})
