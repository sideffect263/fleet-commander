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

// Overridable for tests; defaults keep the hook safely under the 120s hook budget.
const POLL_INTERVAL_MS = Number(process.env.FLEET_APPROVAL_POLL_MS) || 1500
const SELF_TIMEOUT_MS = Number(process.env.FLEET_APPROVAL_TIMEOUT_MS) || 110_000  // hooks.json sets this hook's timeout to 120s
const FETCH_TIMEOUT_MS = 4000

// Tools that `acceptEdits` mode auto-accepts (file edits). Under acceptEdits these
// run with NO local prompt, so a gated one is effectively "unattended"; other gated
// tools (e.g. Bash) still get a local prompt under acceptEdits.
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// Would this gated tool proceed with NO local permission prompt to fall back to?
// bypassPermissions (--dangerously-skip-permissions) auto-accepts everything;
// acceptEdits only the edit tools. (Verified against the Claude Code docs: a
// PreToolUse `deny` is still honored in bypass mode, and `permission_mode` is passed
// in the hook stdin — so we can both DETECT this and still gate when asked to.)
function isUnattended(mode, toolName) {
  if (mode === 'bypassPermissions') return true
  if (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName)) return true
  return false
}

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

  // Bypass / auto-accept sessions. In bypassPermissions there is NO local prompt to
  // fall back to, so our normal "defer on no answer" (exit 0, below) would let the
  // tool run anyway — meaning we'd have paged your phone for an approval we don't
  // actually enforce, then run it regardless. That is the source of the bypass-mode
  // push flood AND the "it ran without my approval" surprise. So by default an
  // unattended session is OBSERVE-ONLY: no approval POST, no page. Opt back into real
  // gating with `approvals.gateBypassSessions: true` — then a no-answer DENIES
  // instead of deferring (a PreToolUse deny is honored even in bypass mode).
  const permissionMode = hook.permission_mode || hook.permissionMode || 'default'
  const unattended = isUnattended(permissionMode, toolName)
  const gateBypass = cfg.approvals?.gateBypassSessions === true
  if (unattended && !gateBypass) process.exit(0)

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
  if (!created?.approvalId) {
    // Backend unreachable / rejected the POST. A hard-gated unattended session has
    // NO local prompt to fall back to, so fail CLOSED (deny) rather than let the tool
    // run ungated; every other session defers to the normal local prompt.
    if (unattended && gateBypass) { deny('Backend unreachable — blocked (gated unattended session)'); process.exit(0) }
    process.exit(0) // backend unreachable → defer to the normal local prompt
  }

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
  // No decision in time. A hard-gated unattended session has NO local prompt to fall
  // back to, so DENY it (a PreToolUse deny is honored even in bypass mode); every
  // other session defers to Claude Code's normal local permission prompt.
  if (unattended && gateBypass) { deny('No approval received in time — blocked (gated unattended session)'); process.exit(0) }
  process.exit(0) // deferred → normal local prompt
}

main().catch(() => process.exit(0))
