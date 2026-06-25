#!/usr/bin/env node
// forwarder.mjs — wired to every Claude Code hook by hooks/hooks.json.
//
// On each hook it: reads the event JSON on stdin, attaches the latest assistant
// token usage from the transcript tail, and POSTs a compact envelope to the
// cloud's /v1/ingest. On "quiet" events (Stop/SessionEnd), and no more than once
// per throttle window, it also recomputes 5h/week stats and POSTs /v1/stats.
//
// Hard rules: never block Claude Code. If unpaired, offline, or slow, it exits
// quietly and fast. Pure Node builtins — no npm install for the user.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readConfig, USAGE_CACHE_PATH, STATS_THROTTLE_PATH } from './lib/config.mjs'
import { latestAssistantUsage, computeStats } from './lib/transcript.mjs'

// Absolute backstop: whatever happens, this process dies fast.
const HARD_EXIT_MS = 2500
const hardTimer = setTimeout(() => process.exit(0), HARD_EXIT_MS)
hardTimer.unref?.()

const STATS_THROTTLE_MS = 45_000
const FETCH_TIMEOUT_MS = 1200

function done() { clearTimeout(hardTimer); process.exit(0) }

async function postJson(url, token, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } catch { /* offline / slow — ignore, never block Claude Code */ } finally {
    clearTimeout(t)
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

  await postJson(`${cfg.baseUrl}/v1/ingest`, cfg.deviceToken, {
    name,
    sessionId,
    // Privacy: send only the project folder name, never the full path (which
    // would leak the username + client/project directory names to the cloud).
    cwd: hook.cwd ? basename(hook.cwd) : undefined,
    toolName: hook.tool_name || hook.toolName,
    timestamp: new Date().toISOString(),
    usage: usage || undefined,
  })

  // Refresh budget stats at quiet moments, throttled.
  if ((name === 'Stop' || name === 'SessionEnd' || name === 'PostToolUse') && statsDue()) {
    try {
      const stats = await computeStats(USAGE_CACHE_PATH)
      await postJson(`${cfg.baseUrl}/v1/stats`, cfg.deviceToken, stats)
    } catch { /* stats are best-effort */ }
  }

  done()
}

main().catch(() => done())
