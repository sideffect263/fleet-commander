// integration.mjs — exercises the REAL plugin scripts against a REAL backend
// over HTTP. Spawns backend/src/server.mjs on a test port, simulates the phone
// pairing, then runs the actual link.mjs and forwarder.mjs the way Claude Code
// would — with a throwaway $HOME so it never touches your real ~/.fleet-commander.
//
// SINCE THE FIRE-AND-FORGET OUTBOX: the forwarder no longer POSTs on the hook —
// it APPENDS to ~/.fleet-commander/outbox.ndjson and the fleet-daemon drains it
// to /v1/ingest on its beat. So this test runs the forwarder, then EXPLICITLY
// drains the outbox (via lib/outbox.mjs against the real server) before asserting
// the ship is visible; and it drives the 3-strike auto-unlink through DRAINING a
// revoked-token outbox, since strikes now accrue on delivery, not on the hook.
//
//   node test/integration.mjs

import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const backendEntry = join(pluginRoot, '..', 'backend', 'src', 'server.mjs')
const node = process.execPath

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const HOME = mkdtempSync(join(tmpdir(), 'fleet-home-'))
// This test exercises the forwarder's hook path, not the heartbeat daemon — keep it
// from spawning a real background daemon (it would linger ~45s against the dead test
// backend). The daemon's own rule is covered by test/heartbeat.mjs.
process.env.FLEET_NO_DAEMON = '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runScript(scriptArgs, env, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, scriptArgs, { env: { ...process.env, ...env } })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    if (stdinText != null) { child.stdin.write(stdinText); child.stdin.end() }
  })
}

// Drain the outbox against the real backend the way the daemon does: import
// lib/outbox.mjs's drain with a real /v1/ingest post, then run the same 3-strike
// reactToAuth from lib/config.mjs. Run in a child $HOME so it reads the config +
// outbox we wrote, exactly like the daemon would. Returns { drained, lastStatus }.
// (We drive the delivery step directly rather than spawning the full daemon so the
// assertion is deterministic and doesn't wait on the 45s beat interval.)
function drainOutbox(home) {
  const script = `
    import { drain } from ${JSON.stringify(join(pluginRoot, 'scripts', 'lib', 'outbox.mjs'))}
    import { readConfig, readAuthState, writeAuthState, clearDeviceLink } from ${JSON.stringify(join(pluginRoot, 'scripts', 'lib', 'config.mjs'))}
    const AUTH_STRIKE_LIMIT = 3
    function reactToAuth(status) {
      if (status === 401 || status === 403) {
        const strikes = (readAuthState().strikes || 0) + 1
        if (strikes >= AUTH_STRIKE_LIMIT) clearDeviceLink('revoked in test')
        else writeAuthState({ strikes })
      } else if (status >= 200 && status < 300) {
        if ((readAuthState().strikes || 0) !== 0) writeAuthState({ strikes: 0 })
      }
    }
    const cfg = readConfig()
    async function post(ev) {
      try {
        const res = await fetch(cfg.baseUrl + '/v1/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.deviceToken },
          body: JSON.stringify(ev),
        })
        return res.status
      } catch { return 0 }
    }
    const r = await drain(post)
    reactToAuth(r.lastStatus)
    process.stdout.write(JSON.stringify(r))
  `
  return runScript(['--input-type=module', '-e', script], { HOME: home, FLEET_CLOUD_URL: BASE })
}

async function waitForHealth(ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch {}
    await sleep(100)
  }
  throw new Error('backend did not become healthy')
}

console.log('\nFleet Commander — plugin ↔ backend integration\n')

const server = spawn(node, [backendEntry], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' })
let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }

try {
  await waitForHealth()
  ok(`backend up on :${PORT}`)

  // Phone begins pairing (what the iOS app's "pair" button does).
  const pair = await (await fetch(`${BASE}/v1/pair/new`, { method: 'POST' })).json()
  ok(`phone got code ${pair.code}`)

  // Real link.mjs, hermetic HOME → writes <HOME>/.fleet-commander/config.json.
  const link = await runScript([join(pluginRoot, 'scripts', 'link.mjs'), pair.code], { HOME, FLEET_CLOUD_URL: BASE })
  assert.strictEqual(link.code, 0, `link.mjs exit 0 (stderr: ${link.err})`)
  const cfg = JSON.parse(readFileSync(join(HOME, '.fleet-commander', 'config.json'), 'utf8'))
  assert.ok(cfg.deviceToken?.startsWith('dev_'), 'device token saved to config')
  ok('link.mjs paired and wrote config')

  // Real forwarder.mjs, fed a hook payload on stdin exactly like Claude Code does.
  const hook = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'itest-session-1',
    cwd: '/Users/dev/code/nebula-svc',
    tool_name: 'Bash',
  })
  const fwd = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE }, hook)
  assert.strictEqual(fwd.code, 0, `forwarder.mjs exit 0 (stderr: ${fwd.err})`)
  ok('forwarder.mjs accepted a hook and exited clean')

  // The forwarder no longer POSTs — it enqueued the event. Prove the event landed
  // in the durable outbox, then drain it to the backend the way the daemon does.
  const outboxPath = join(HOME, '.fleet-commander', 'outbox.ndjson')
  assert.ok(readFileSync(outboxPath, 'utf8').includes('itest-session-1'), 'event was enqueued to the local outbox (no network on the hook)')
  const drain1 = await drainOutbox(HOME)
  assert.strictEqual(drain1.code, 0, `drain exits clean (stderr: ${drain1.err})`)
  const outboxLeft = readFileSync(outboxPath, 'utf8').split('\n').filter(Boolean).length
  assert.strictEqual(outboxLeft, 0, 'outbox drained to empty')
  ok('outbox drained to the backend (delivery deferred off the hook, done by the daemon path)')

  // Read the fleet as the phone would.
  const fleet = await (await fetch(`${BASE}/v1/fleet`, { headers: { authorization: `Bearer ${pair.appToken}` } })).json()
  assert.strictEqual(fleet.ships.length, 1, 'one ship visible to phone')
  assert.strictEqual(fleet.ships[0].projectDir, 'nebula-svc', 'projectDir from cwd')
  assert.strictEqual(fleet.ships[0].action, 'terminal', 'Bash → terminal')
  assert.strictEqual(fleet.ships[0].agent, 'claude', 'default agent is claude')
  ok(`phone sees ship "${fleet.ships[0].projectDir}" — ${fleet.ships[0].action} (claude)`)

  // --- Codex adapter: the SAME forwarder.mjs, fed a Codex-shaped hook payload
  // with FLEET_AGENT=codex. Codex emits identical field names (session_id, cwd,
  // hook_event_name, tool_name) — only the env-driven agent tag differs. Assert
  // the resulting ship comes back tagged agent='codex'.
  const codexHook = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'itest-codex-1',
    cwd: '/Users/dev/code/orion-cli',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    transcript_path: null,
    model: 'gpt-5-codex',
    permission_mode: 'default',
    turn_id: 'turn-xyz',
  })
  const cfwd = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE, FLEET_AGENT: 'codex' }, codexHook)
  assert.strictEqual(cfwd.code, 0, `forwarder.mjs (codex) exit 0 (stderr: ${cfwd.err})`)
  ok('forwarder.mjs accepted a Codex-shaped hook with FLEET_AGENT=codex')

  // Drain the codex event (again, the delivery the daemon would do on its beat).
  const drain2 = await drainOutbox(HOME)
  assert.strictEqual(drain2.code, 0, `codex drain exits clean (stderr: ${drain2.err})`)

  const fleet2 = await (await fetch(`${BASE}/v1/fleet`, { headers: { authorization: `Bearer ${pair.appToken}` } })).json()
  const codexShip = fleet2.ships.find((s) => s.projectDir === 'orion-cli')
  assert.ok(codexShip, 'codex ship is visible to the phone')
  assert.strictEqual(codexShip.agent, 'codex', 'ship tagged agent=codex')
  assert.strictEqual(codexShip.action, 'terminal', 'Bash → terminal (codex)')
  ok(`phone sees Codex ship "${codexShip.projectDir}" — agent=${codexShip.agent}`)

  // --- Dead fleet → auto-unlink (now driven on DRAIN) -----------------------
  // Simulate a deleted/revoked fleet by pointing config at a device token the
  // backend doesn't know. The forwarder no longer POSTs, so strikes no longer
  // accrue on the hook — they accrue when the DAEMON DRAINS the outbox and the
  // backend 401s. So we enqueue one event, then drain the revoked-token outbox
  // three times: two strikes keep the pairing, the third crosses the limit and
  // auto-unlinks the Mac. This proves the 3-strike unlink still holds, on its new
  // (drain) trigger.
  const cfgPath = join(HOME, '.fleet-commander', 'config.json')
  const authPath = join(HOME, '.fleet-commander', 'auth-state.json')
  const outbox = join(HOME, '.fleet-commander', 'outbox.ndjson')
  writeFileSync(cfgPath, JSON.stringify({ baseUrl: BASE, deviceToken: 'dev_revoked', accountId: 'acct_gone' }))
  try { rmSync(authPath, { force: true }) } catch {}

  // Seed the outbox with an event the backend will reject (unknown token → 401).
  const reEnqueue = () => writeFileSync(outbox, JSON.stringify({
    eventId: `dead:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    name: 'PreToolUse', sessionId: 'dead-1', agent: 'claude', cwd: 'ghost', toolName: 'Bash',
    timestamp: new Date().toISOString(),
  }) + '\n')

  // First two drains: 401 → still paired, just accumulating strikes.
  for (let i = 1; i <= 2; i++) {
    reEnqueue()
    const r = await drainOutbox(HOME)
    assert.strictEqual(r.code, 0, `drain exits clean on 401 #${i} (stderr: ${r.err})`)
    assert.strictEqual(JSON.parse(r.out).lastStatus, 401, `backend 401s the revoked token (drain #${i})`)
    assert.ok(JSON.parse(readFileSync(cfgPath, 'utf8')).deviceToken, `still paired after strike ${i}`)
    assert.strictEqual(JSON.parse(readFileSync(authPath, 'utf8')).strikes, i, `strike count is ${i}`)
  }
  ok('drain counts auth strikes without unlinking prematurely')

  // Third drain crosses the limit → unlink.
  reEnqueue()
  const kill = await drainOutbox(HOME)
  assert.strictEqual(kill.code, 0, `drain exits clean on final 401 (stderr: ${kill.err})`)
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.ok(!after.deviceToken, 'deviceToken cleared after strike limit')
  assert.ok(!after.accountId, 'accountId cleared after strike limit')
  assert.strictEqual(after.baseUrl, BASE, 'baseUrl preserved so re-linking is easy')
  assert.ok(JSON.parse(readFileSync(authPath, 'utf8')).unlinkedAt, 'records when/why it auto-unlinked')
  ok('drain auto-unlinks the Mac once a dead fleet 401s it repeatedly')

  // Now unpaired → a further hook is a fast no-op (proves the forwarder stops
  // enqueueing once there's no token).
  const quietHook = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'dead-4', cwd: '/Users/dev/code/ghost', tool_name: 'Bash' })
  try { rmSync(outbox, { force: true }) } catch {}
  const quiet = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE }, quietHook)
  assert.strictEqual(quiet.code, 0, 'forwarder no-ops once unlinked')
  assert.ok(!existsSync(outbox) || readFileSync(outbox, 'utf8').trim() === '', 'unpaired forwarder enqueues nothing')
  ok('once unlinked, the forwarder goes quiet (enqueues nothing)')

  console.log(`\n✅ ${pass} checks passed — real plugin scripts drive the real backend over HTTP\n`)
} catch (err) {
  console.error(`\n✗ integration failed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  server.kill('SIGKILL')
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}
