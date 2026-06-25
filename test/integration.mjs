// integration.mjs — exercises the REAL plugin scripts against a REAL backend
// over HTTP. Spawns backend/src/server.mjs on a test port, simulates the phone
// pairing, then runs the actual link.mjs and forwarder.mjs the way Claude Code
// would — with a throwaway $HOME so it never touches your real ~/.fleet-commander.
//
//   node test/integration.mjs

import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  ok(`phone sees ship "${fleet.ships[0].projectDir}" — ${fleet.ships[0].action}`)

  console.log(`\n✅ ${pass} checks passed — real plugin scripts drive the real backend over HTTP\n`)
} catch (err) {
  console.error(`\n✗ integration failed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  server.kill('SIGKILL')
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}
