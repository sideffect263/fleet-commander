// approve-hook.mjs test — proves the scoped-approval hardening end-to-end by
// driving the REAL approve-hook.mjs against a mock backend with a throwaway $HOME.
//
// The security property under test: an irreversible command can never be
// auto-approved by a blanket "allow this tool for the session" grant.
//
//   node test/approve-hook.mjs

import assert from 'node:assert'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hookPath = join(here, '..', 'scripts', 'approve-hook.mjs')
const node = process.execPath

// --- mock backend: records approval POSTs, returns a configurable decision -----
let posts = []
let decision = { status: 'allow', scope: 'session' }
let postStatus = 200 // set !=200 to simulate the backend rejecting/failing the POST
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/approvals') {
      posts.push(JSON.parse(body || '{}'))
      if (postStatus !== 200) { res.statusCode = postStatus; res.end('{}'); return }
      res.end(JSON.stringify({ approvalId: 'ap_1' }))
    } else if (req.method === 'GET' && req.url.startsWith('/v1/approvals/')) {
      res.end(JSON.stringify(decision))
    } else { res.statusCode = 404; res.end('{}') }
  })
})

function runHook(home, hookPayload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [hookPath], {
      env: { ...process.env, HOME: home, FLEET_CLOUD_URL: BASE, ...extraEnv },
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', () => resolve({ out, err }))
    child.stdin.write(JSON.stringify(hookPayload)); child.stdin.end()
  })
}

const sessionAllows = (home) => {
  const p = join(home, '.fleet-commander', 'session-allows.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}
const isWhitelisted = (home, sid, tool) => !!sessionAllows(home)?.[sid]?.tools?.[tool]

function freshHome(tools = ['Bash'], extraApprovals = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fleet-home-'))
  mkdirSync(join(home, '.fleet-commander'), { recursive: true })
  writeFileSync(
    join(home, '.fleet-commander', 'config.json'),
    JSON.stringify({ baseUrl: BASE, deviceToken: 'dev_test', accountId: 'acct_test', approvals: { enabled: true, tools, ...extraApprovals } }),
  )
  return home
}

let PORT, BASE
await new Promise((r) => server.listen(0, '127.0.0.1', () => { PORT = server.address().port; BASE = `http://127.0.0.1:${PORT}`; r() }))

console.log('\nFleet Commander — approve-hook scoped-approval hardening\n')
let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }
const homes = []

try {
  // 1. SAFE command + scope:session → grant IS persisted (normal behavior intact).
  {
    const home = freshHome(); homes.push(home)
    posts = []; decision = { status: 'allow', scope: 'session' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-safe', tool_input: { command: 'ls -la' }, cwd: '/x/y' })
    assert.match(r.out, /"permissionDecision":"allow"/, 'safe command allowed')
    assert.strictEqual(isWhitelisted(home, 'sess-safe', 'Bash'), true, 'safe command IS whitelisted for the session')
    ok('safe command with scope=session is whitelisted (normal scoped-approval works)')
  }

  // 2. DANGEROUS command + scope:session → allowed ONCE, grant NOT persisted.
  {
    const home = freshHome(); homes.push(home)
    posts = []; decision = { status: 'allow', scope: 'session' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-danger', tool_input: { command: 'rm -rf /tmp/build' }, cwd: '/x/y' })
    assert.match(r.out, /"permissionDecision":"allow"/, 'dangerous command still allowed once (user did approve)')
    assert.match(r.out, /not whitelisted for the session/i, 'reason explains it was not whitelisted')
    assert.strictEqual(isWhitelisted(home, 'sess-danger', 'Bash'), false, 'dangerous command is NOT whitelisted despite scope=session')
    ok('dangerous command with scope=session is approved once but NEVER whitelisted')
  }

  // 3. Pre-existing blanket grant must NOT cover a later dangerous command — it
  //    re-pages the phone instead of silently short-circuiting.
  {
    const home = freshHome(); homes.push(home)
    writeFileSync(join(home, '.fleet-commander', 'session-allows.json'),
      JSON.stringify({ 'sess-armed': { tools: { Bash: true }, ts: Date.now() } }))
    posts = []; decision = { status: 'allow', scope: 'once' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-armed', tool_input: { command: 'git push --force origin main' }, cwd: '/x/y' })
    assert.strictEqual(posts.length, 1, 'dangerous command re-pages the phone even though Bash is whitelisted')
    assert.match(r.out, /"permissionDecision":"allow"/, 'allowed after explicit approval')
    ok('pre-existing session whitelist does NOT cover a dangerous command (re-pages)')
  }

  // 4. Pre-existing blanket grant DOES cover a later safe command (no re-page).
  {
    const home = freshHome(); homes.push(home)
    writeFileSync(join(home, '.fleet-commander', 'session-allows.json'),
      JSON.stringify({ 'sess-armed2': { tools: { Bash: true }, ts: Date.now() } }))
    posts = []; decision = { status: 'allow', scope: 'once' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-armed2', tool_input: { command: 'ls' }, cwd: '/x/y' })
    assert.strictEqual(posts.length, 0, 'safe command rides the existing whitelist without paging')
    assert.match(r.out, /Allowed for this session/, 'short-circuit allow message')
    ok('pre-existing session whitelist still covers a safe command (no needless re-page)')
  }

  // 5. BYPASS mode (--dangerously-skip-permissions) → OBSERVE-ONLY by default: no
  //    approval POST, no page. We can't add value paging for a session that will run
  //    the tool regardless of our answer — this is the bypass-mode flood fix.
  {
    const home = freshHome(); homes.push(home)
    posts = []; decision = { status: 'pending' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-bypass', tool_input: { command: 'rm -rf /tmp/x' }, cwd: '/x/y', permission_mode: 'bypassPermissions' })
    assert.strictEqual(posts.length, 0, 'bypass session posts NO approval')
    assert.strictEqual(r.out.trim(), '', 'bypass session emits no decision (defers → the tool runs unattended)')
    ok('bypassPermissions session is observe-only (no POST, no page)')
  }

  // 6. acceptEdits + an edit tool that mode auto-accepts → also observe-only (Claude
  //    Code runs it with no local prompt, so paging can't gate it either).
  {
    const home = freshHome(['Bash', 'Edit']); homes.push(home)
    posts = []; decision = { status: 'pending' }
    const r = await runHook(home, { tool_name: 'Edit', session_id: 'sess-ae', tool_input: { file_path: '/x/y/a.ts' }, cwd: '/x/y', permission_mode: 'acceptEdits' })
    assert.strictEqual(posts.length, 0, 'acceptEdits auto-accepted edit posts NO approval')
    ok('acceptEdits + an auto-accepted edit tool is observe-only')
  }

  // 7. acceptEdits + Bash → STILL pages: acceptEdits does NOT auto-accept Bash, so a
  //    local prompt still exists and gating is meaningful.
  {
    const home = freshHome(); homes.push(home)
    posts = []; decision = { status: 'allow', scope: 'once' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-ae-bash', tool_input: { command: 'npm test' }, cwd: '/x/y', permission_mode: 'acceptEdits' })
    assert.strictEqual(posts.length, 1, 'acceptEdits still pages for Bash (not auto-accepted by that mode)')
    assert.match(r.out, /"permissionDecision":"allow"/, 'allowed after approval')
    ok('acceptEdits + Bash still pages (acceptEdits does not auto-accept Bash)')
  }

  // 8. gateBypassSessions:true → hard-gate a bypass session. It DOES post, and on no
  //    answer it DENIES (there's no local prompt to fall back to; a PreToolUse deny is
  //    honored even in bypass mode). Short timeout via env so the test doesn't wait 110s.
  {
    const home = freshHome(['Bash'], { gateBypassSessions: true }); homes.push(home)
    posts = []; decision = { status: 'pending' }
    const r = await runHook(
      home,
      { tool_name: 'Bash', session_id: 'sess-gate', tool_input: { command: 'rm -rf /tmp/x' }, cwd: '/x/y', permission_mode: 'bypassPermissions' },
      { FLEET_APPROVAL_TIMEOUT_MS: '400', FLEET_APPROVAL_POLL_MS: '120' },
    )
    assert.strictEqual(posts.length, 1, 'a gated bypass session DOES post an approval')
    assert.match(r.out, /"permissionDecision":"deny"/, 'no answer in a gated bypass session → deny')
    ok('gateBypassSessions hard-gates a bypass session: no answer → deny')
  }

  // 9. ATTENDED non-bypass mode (plan) → STILL pages. Pins the invariant that
  //    isUnattended() is false for every mode except bypass / acceptEdits-on-edits,
  //    so a future typo/added case can't silently ungate an attended session.
  {
    const home = freshHome(); homes.push(home)
    posts = []; postStatus = 200; decision = { status: 'allow', scope: 'once' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-plan', tool_input: { command: 'npm test' }, cwd: '/x/y', permission_mode: 'plan' })
    assert.strictEqual(posts.length, 1, 'an attended (plan) session still pages')
    assert.match(r.out, /"permissionDecision":"allow"/, 'allowed after approval')
    ok('attended non-bypass mode (plan) still pages (not treated as unattended)')
  }

  // 10. BYPASS + a SAFE command → still observe-only. Pins that the observe-only
  //     early-exit runs BEFORE the danger/whitelist logic (not only for dangerous ones).
  {
    const home = freshHome(); homes.push(home)
    posts = []; postStatus = 200; decision = { status: 'pending' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-bypass-safe', tool_input: { command: 'ls' }, cwd: '/x/y', permission_mode: 'bypassPermissions' })
    assert.strictEqual(posts.length, 0, 'safe bypass command posts nothing')
    assert.strictEqual(r.out.trim(), '', 'safe bypass command is observe-only too (exit ordering pinned)')
    ok('bypass + safe command is observe-only (early-exit precedes danger/whitelist logic)')
  }

  // 11. gateBypassSessions + BACKEND UNREACHABLE → fail CLOSED (deny), not defer.
  //     A hard-gated bypass session has no local prompt to fall back to, so a failed
  //     POST must deny rather than let the tool run ungated. (Regression for the
  //     fail-open bug the adversarial review caught.)
  {
    const home = freshHome(['Bash'], { gateBypassSessions: true }); homes.push(home)
    posts = []; postStatus = 500; decision = { status: 'pending' }
    const r = await runHook(home, { tool_name: 'Bash', session_id: 'sess-gate-down', tool_input: { command: 'rm -rf /tmp/x' }, cwd: '/x/y', permission_mode: 'bypassPermissions' })
    assert.strictEqual(posts.length, 1, 'the POST was attempted')
    assert.match(r.out, /"permissionDecision":"deny"/, 'gated bypass session fails CLOSED when the backend is unreachable')
    postStatus = 200
    ok('gateBypassSessions fails closed on backend-unreachable (deny, not defer)')
  }

  console.log(`\n✅ ${pass} checks passed — scoped-approval hardening + bypass-mode observe-only + fail-closed\n`)
} catch (err) {
  console.error(`\n✗ approve-hook hardening failed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  server.close()
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch {} }
}
