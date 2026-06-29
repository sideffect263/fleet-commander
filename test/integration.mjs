// integration.mjs — exercises the REAL plugin scripts against a REAL backend
// over HTTP. Spawns backend/src/server.mjs on a test port, simulates the phone
// pairing, then runs the actual link.mjs and forwarder.mjs the way Claude Code
// would — with a throwaway $HOME so it never touches your real ~/.fleet-commander.
//
//   node test/integration.mjs

import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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

  const fleet2 = await (await fetch(`${BASE}/v1/fleet`, { headers: { authorization: `Bearer ${pair.appToken}` } })).json()
  const codexShip = fleet2.ships.find((s) => s.projectDir === 'orion-cli')
  assert.ok(codexShip, 'codex ship is visible to the phone')
  assert.strictEqual(codexShip.agent, 'codex', 'ship tagged agent=codex')
  assert.strictEqual(codexShip.action, 'terminal', 'Bash → terminal (codex)')
  ok(`phone sees Codex ship "${codexShip.projectDir}" — agent=${codexShip.agent}`)

  // --- Dead fleet → auto-unlink ---------------------------------------------
  // Simulate a deleted/revoked fleet by pointing config at a device token the
  // backend doesn't know. /v1/ingest 401s; the forwarder must count strikes and
  // unlink this Mac after the limit, then go quiet.
  const cfgPath = join(HOME, '.fleet-commander', 'config.json')
  const authPath = join(HOME, '.fleet-commander', 'auth-state.json')
  writeFileSync(cfgPath, JSON.stringify({ baseUrl: BASE, deviceToken: 'dev_revoked', accountId: 'acct_gone' }))
  try { rmSync(authPath, { force: true }) } catch {}

  const deadHook = (n) => JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: `dead-${n}`, cwd: '/Users/dev/code/ghost', tool_name: 'Bash',
  })

  // First two rejections: still paired, just accumulating strikes.
  for (let i = 1; i <= 2; i++) {
    const r = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE }, deadHook(i))
    assert.strictEqual(r.code, 0, `forwarder exits clean on 401 #${i} (stderr: ${r.err})`)
    assert.ok(JSON.parse(readFileSync(cfgPath, 'utf8')).deviceToken, `still paired after strike ${i}`)
    assert.strictEqual(JSON.parse(readFileSync(authPath, 'utf8')).strikes, i, `strike count is ${i}`)
  }
  ok('forwarder counts auth strikes without unlinking prematurely')

  // Third rejection crosses the limit → unlink.
  const kill = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE }, deadHook(3))
  assert.strictEqual(kill.code, 0, `forwarder exits clean on final 401 (stderr: ${kill.err})`)
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.ok(!after.deviceToken, 'deviceToken cleared after strike limit')
  assert.ok(!after.accountId, 'accountId cleared after strike limit')
  assert.strictEqual(after.baseUrl, BASE, 'baseUrl preserved so re-linking is easy')
  assert.ok(JSON.parse(readFileSync(authPath, 'utf8')).unlinkedAt, 'records when/why it auto-unlinked')
  ok('forwarder auto-unlinks the Mac once a dead fleet 401s it repeatedly')

  // Now unpaired → a further hook is a fast no-op (proves it stopped sending).
  const quiet = await runScript([join(pluginRoot, 'scripts', 'forwarder.mjs')], { HOME, FLEET_CLOUD_URL: BASE }, deadHook(4))
  assert.strictEqual(quiet.code, 0, 'forwarder no-ops once unlinked')
  ok('once unlinked, the forwarder goes quiet')

  console.log(`\n✅ ${pass} checks passed — real plugin scripts drive the real backend over HTTP\n`)
} catch (err) {
  console.error(`\n✗ integration failed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  server.kill('SIGKILL')
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}
