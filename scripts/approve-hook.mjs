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
// Decision protocol (verified against BOTH Claude Code AND Codex CLI hook docs —
// they are byte-identical for PreToolUse, so one script serves both agents):
//   allow → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
//   deny  → {...,"permissionDecision":"deny","permissionDecisionReason":"..."}
//   defer → exit 0 with no stdout (normal prompt)
//
// The `agent` reported on the approval comes from FLEET_AGENT (default 'claude';
// the Codex install path sets FLEET_AGENT=codex) so the phone can skin/route it.
//
// NOTE: both agents ALLOW a tool if the hook is killed by its `timeout`. So we
// self-time-out (SELF_TIMEOUT_MS) safely below the hook timeout and defer.

import { basename } from 'node:path'
import { readConfig, isSessionToolAllowed, allowToolForSession } from './lib/config.mjs'
import { isDangerousCommand } from './lib/danger.mjs'

const POLL_INTERVAL_MS = 1500
const SELF_TIMEOUT_MS = 110_000      // hooks.json sets this hook's timeout to 120s
const FETCH_TIMEOUT_MS = 4000

// 'claude' by default; Codex install path sets FLEET_AGENT=codex. Backend
// validates against claude|codex|gemini|cursor|aider.
const AGENT = process.env.FLEET_AGENT || 'claude'

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

  const sessionId = hook.session_id || hook.sessionId
  const input = hook.tool_input || hook.toolInput

  // Defense-in-depth (authoritative, local): an irreversible command (rm -rf,
  // force-push, reset --hard, DROP TABLE, mkfs …) can NEVER ride a blanket "allow
  // for the session" grant. The app hides that control for these commands, but
  // that gate is client-side; here — where we see the real, untruncated command —
  // we enforce it, so a forged backend response or bypassed app can't whitelist
  // a destructive command. Dangerous commands always require explicit, per-command
  // approval.
  const dangerous = isDangerousCommand(toolName, input)

  // Scoped approvals: if you already approved this tool "for the session" from
  // your phone, allow it straight away without paging you again — UNLESS this
  // specific command is irreversible, which always re-pages.
  if (!dangerous && isSessionToolAllowed(sessionId, toolName)) { allow('Allowed for this session'); process.exit(0) }

  const auth = { authorization: `Bearer ${cfg.deviceToken}`, 'content-type': 'application/json' }
  const created = await fetchJson(`${cfg.baseUrl}/v1/approvals`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      sessionId,
      agent: AGENT,
      toolName,
      summary: summarize(toolName, input),
      cwd: hook.cwd ? basename(hook.cwd) : undefined, // basename only (privacy) — Codex too
    }),
  })
  if (!created?.approvalId) process.exit(0) // backend unreachable → defer

  const id = created.approvalId
  const deadline = Date.now() + SELF_TIMEOUT_MS
  while (Date.now() < deadline) {
    const s = await fetchJson(`${cfg.baseUrl}/v1/approvals/${id}`, { headers: auth })
    if (s?.status === 'allow') {
      // scope=session → remember it so we stop asking for this tool this session,
      // but NEVER persist a session grant for an irreversible command (even if the
      // backend says scope='session') — approve it once and keep paging next time.
      if (s.scope === 'session' && !dangerous) {
        allowToolForSession(sessionId, toolName)
        allow('Allowed for this session from your phone')
      } else if (s.scope === 'session' && dangerous) {
        allow('Approved once (irreversible — not whitelisted for the session)')
      } else {
        allow('Approved from your phone')
      }
      process.exit(0)
    }
    if (s?.status === 'deny') { deny('Denied from your phone'); process.exit(0) }
    await sleep(POLL_INTERVAL_MS)
  }
  process.exit(0) // no decision in time → defer to the normal local prompt
}

main().catch(() => process.exit(0))
