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
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/approvals') {
      posts.push(JSON.parse(body || '{}'))
      res.end(JSON.stringify({ approvalId: 'ap_1' }))
    } else if (req.method === 'GET' && req.url.startsWith('/v1/approvals/')) {
      res.end(JSON.stringify(decision))
    } else { res.statusCode = 404; res.end('{}') }
  })
})

function runHook(home, hookPayload) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [hookPath], {
      env: { ...process.env, HOME: home, FLEET_CLOUD_URL: BASE },
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

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'fleet-home-'))
  mkdirSync(join(home, '.fleet-commander'), { recursive: true })
  writeFileSync(
    join(home, '.fleet-commander', 'config.json'),
    JSON.stringify({ baseUrl: BASE, deviceToken: 'dev_test', accountId: 'acct_test', approvals: { enabled: true, tools: ['Bash'] } }),
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

  console.log(`\n✅ ${pass} checks passed — irreversible commands can never be session-whitelisted\n`)
} catch (err) {
  console.error(`\n✗ approve-hook hardening failed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  server.close()
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch {} }
}
