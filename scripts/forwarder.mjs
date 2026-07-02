#!/usr/bin/env node
// forwarder.mjs — wired to every coding-agent hook.
//
// Claude Code wires it via hooks/hooks.json; Codex CLI wires it via
// codex/hooks.json (see README "Codex" section). Both agents emit the SAME
// hook stdin shape (session_id, cwd, hook_event_name, tool_name, tool_input,
// transcript_path) so this one script serves both.
//
// On each hook it: reads the event JSON on stdin, attaches the latest assistant
// token usage from the transcript tail, and ENQUEUES a compact envelope to a
// durable local outbox — then returns immediately. It does NO awaited network
// call: the already-running fleet-daemon drains the outbox to /v1/ingest on its
// beat, so a slow/hung backend can never block the agent on a tool boundary.
// Auth-strike reaction + self-unlink also moved to the daemon (it drains + owns
// delivery now). See lib/outbox.mjs and fleet-daemon.mjs.
//
// The `agent` it reports comes from FLEET_AGENT (default 'claude'); the Codex
// install path sets FLEET_AGENT=codex. The backend validates it against
// claude|codex|gemini|cursor|aider and uses it to skin the ship.
//
// Hard rules: never block the agent. If unpaired, offline, or slow, it exits
// quietly and fast. Pure Node builtins — no npm install for the user.

import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  readConfig, DAEMON_PID_PATH,
} from './lib/config.mjs'
import { latestAssistantUsage } from './lib/transcript.mjs'
import { writeLease, removeLease } from './lib/leases.mjs'
import { toolDetail } from './lib/detail.mjs'
import { enqueueEvent } from './lib/outbox.mjs'

// Absolute backstop: whatever happens, this process dies fast.
const HARD_EXIT_MS = 2500
const hardTimer = setTimeout(() => process.exit(0), HARD_EXIT_MS)
hardTimer.unref?.()

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

  // A short, basename-safe descriptor of WHAT the tool is doing ("auth.ts",
  // "npm test") — only on PreToolUse, when the tool starts. Privacy: never a full
  // path / command / file contents — see lib/detail.mjs.
  const detail = name === 'PreToolUse'
    ? toolDetail(hook.tool_name || hook.toolName, hook.tool_input || hook.toolInput)
    : undefined

  // Fire-and-forget: append the event to the durable local outbox and return.
  // NO awaited network call in the hook path — the fleet-daemon drains this to
  // /v1/ingest on its beat (and owns the 3-strike auth reaction / self-unlink).
  // Best-effort by construction: enqueueEvent never throws.
  enqueueEvent({
    name,
    sessionId,
    agent: AGENT,
    // Privacy: send only the project folder name, never the full path (which
    // would leak the username + client/project directory names to the cloud).
    // Applies to Codex too — same A.1 basename stripping.
    cwd: hook.cwd ? basename(hook.cwd) : undefined,
    toolName: hook.tool_name || hook.toolName,
    detail,
    // The session's current permission mode (default|acceptEdits|bypassPermissions|…),
    // passed by Claude Code in every hook. Lets the app badge sessions running
    // UNATTENDED (auto-accept / bypass) so a session acting without prompts is visible
    // rather than silent. Not code/content — just the mode label.
    permissionMode: hook.permission_mode || hook.permissionMode || undefined,
    timestamp: new Date().toISOString(),
    usage: usage || undefined,
  })

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
