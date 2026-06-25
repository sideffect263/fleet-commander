#!/usr/bin/env node
// approve-hook.mjs — PreToolUse hook for "approve from your phone."
//
// STRICTLY OPT-IN: if approvals are disabled (the default) it exits immediately
// and never blocks anything. When enabled, it asks your phone to approve/deny a
// gated tool action (default: Bash) before Claude Code runs it:
//   1. POST the pending action to the backend.
//   2. Poll for your decision.
//   3. Emit allow / deny — or, on timeout/unreachable, emit nothing (exit 0) so
//      Claude Code falls back to its NORMAL local permission prompt.
//
// Decision protocol (verified against Claude Code hook docs):
//   allow → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
//   deny  → {...,"permissionDecision":"deny","permissionDecisionReason":"..."}
//   defer → exit 0 with no stdout (normal prompt)
//
// NOTE: Claude Code ALLOWS a tool if the hook is killed by its `timeout`. So we
// self-time-out (SELF_TIMEOUT_MS) safely below the hook timeout and defer.

import { basename } from 'node:path'
import { readConfig } from './lib/config.mjs'

const POLL_INTERVAL_MS = 1500
const SELF_TIMEOUT_MS = 110_000      // hooks.json sets this hook's timeout to 120s
const FETCH_TIMEOUT_MS = 4000

function out(obj) { process.stdout.write(JSON.stringify(obj)) }
const allow = (reason) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } })
const deny = (reason) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
  })
}

async function fetchJson(url, opts) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch { return null } finally { clearTimeout(t) }
}

function summarize(toolName, input) {
  if (!input) return toolName
  if (toolName === 'Bash') return String(input.command || '').slice(0, 400)
  if (input.file_path) return `${toolName} ${input.file_path}`
  return toolName
}

async function main() {
  const cfg = readConfig()
  const enabled = cfg.approvals?.enabled || process.env.FLEET_APPROVALS === '1'
  if (!cfg.deviceToken || !enabled) process.exit(0) // opt-in → defer

  const raw = await readStdin()
  let hook
  try { hook = JSON.parse(raw) } catch { process.exit(0) }

  const toolName = hook.tool_name || hook.toolName
  const tools = cfg.approvals?.tools || ['Bash']
  if (!toolName || !tools.includes(toolName)) process.exit(0) // not gated → defer

  const auth = { authorization: `Bearer ${cfg.deviceToken}`, 'content-type': 'application/json' }
  const created = await fetchJson(`${cfg.baseUrl}/v1/approvals`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      sessionId: hook.session_id || hook.sessionId,
      toolName,
      summary: summarize(toolName, hook.tool_input || hook.toolInput),
      cwd: hook.cwd ? basename(hook.cwd) : undefined, // basename only (privacy)
    }),
  })
  if (!created?.approvalId) process.exit(0) // backend unreachable → defer

  const id = created.approvalId
  const deadline = Date.now() + SELF_TIMEOUT_MS
  while (Date.now() < deadline) {
    const s = await fetchJson(`${cfg.baseUrl}/v1/approvals/${id}`, { headers: auth })
    if (s?.status === 'allow') { allow('Approved from your phone'); process.exit(0) }
    if (s?.status === 'deny') { deny('Denied from your phone'); process.exit(0) }
    await sleep(POLL_INTERVAL_MS)
  }
  process.exit(0) // no decision in time → defer to the normal local prompt
}

main().catch(() => process.exit(0))
