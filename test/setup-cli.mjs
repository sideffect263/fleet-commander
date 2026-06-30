// setup-cli.mjs — exercises the unified `fleet setup` CLI + the Codex stale-path
// fix against a REAL backend, with a throwaway $HOME so it never touches your real
// ~/.fleet-commander or ~/.codex.
//
//   node test/setup-cli.mjs

import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const backendEntry = join(pluginRoot, '..', 'backend', 'src', 'server.mjs')
const fleetCli = join(pluginRoot, 'scripts', 'fleet.mjs')
const installCodex = join(pluginRoot, 'scripts', 'install-codex.mjs')
const node = process.execPath
const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(args, env) {
  return new Promise((resolve) => {
    // FLEET_NO_DAEMON: don't spawn a heartbeat daemon from anything we invoke.
    const child = spawn(node, args, { env: { ...process.env, FLEET_NO_DAEMON: '1', ...env } })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

console.log('\nFleet Commander plugin — unified `fleet setup` CLI + Codex stale-path fix\n')

const server = spawn(node, [backendEntry], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' })
try {
  // Readiness probe doubles as the pairing-code mint.
  let pair = null
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/v1/pair/new`, { method: 'POST' }); if (r.ok) { pair = await r.json(); break } } catch {}
    await sleep(100)
  }
  assert.ok(pair?.code, 'backend came up and minted a pairing code')
  ok(`backend up on :${PORT}`)

  // === A. fleet setup --agent codex --code <code> ===
  const HOME = mkdtempSync(join(tmpdir(), 'fleet-cli-'))
  const env = { HOME, FLEET_CLOUD_URL: BASE }
  const stableDir = join(HOME, '.fleet-commander', 'scripts')

  const r1 = await run([fleetCli, 'setup', '--agent', 'codex', '--code', pair.code], env)
  assert.strictEqual(r1.code, 0, `setup exits 0 (got ${r1.code}; stderr: ${r1.err})`)
  ok('`fleet setup --agent codex --code <code>` exits 0')

  const cfg = JSON.parse(readFileSync(join(HOME, '.fleet-commander', 'config.json'), 'utf8'))
  assert.ok(cfg.deviceToken, 'config has a deviceToken')
  ok('pairing wrote a deviceToken to ~/.fleet-commander/config.json')

  assert.ok(existsSync(join(stableDir, 'forwarder.mjs')), 'forwarder copied')
  assert.ok(existsSync(join(stableDir, 'fleet-daemon.mjs')), 'fleet-daemon copied (forwarder spawns it)')
  assert.ok(existsSync(join(stableDir, 'lib', 'config.mjs')), 'lib/ copied')
  ok('runtime copied into the stable ~/.fleet-commander/scripts dir')

  const codexHooks = readFileSync(join(HOME, '.codex', 'hooks.json'), 'utf8')
  assert.ok(codexHooks.includes(stableDir), 'codex hooks bake the STABLE scripts dir')
  assert.ok(!codexHooks.includes(join(pluginRoot, 'scripts')), 'codex hooks do NOT bake the ephemeral plugin dir')
  assert.ok(codexHooks.includes('FLEET_AGENT=codex'), 'codex hooks carry FLEET_AGENT=codex')
  ok('codex hooks point at the stable dir — STALE-PATH BUG FIXED (not the plugin dir)')

  // === B. idempotent re-run (no needless /hooks re-trust) ===
  const before = readFileSync(join(HOME, '.codex', 'hooks.json'), 'utf8')
  const r2 = await run([fleetCli, 'setup', '--agent', 'codex'], env)
  assert.strictEqual(r2.code, 0, 're-run exits 0')
  assert.match(r2.out, /Already paired/i, 're-run detects existing pairing (no duplicate claim)')
  assert.strictEqual(readFileSync(join(HOME, '.codex', 'hooks.json'), 'utf8'), before, 'hooks.json byte-identical on re-run')
  ok('re-run is idempotent: already-paired, hooks unchanged (no /hooks churn)')

  // === C. --remove strips our hooks ===
  const r3 = await run([fleetCli, 'setup', '--agent', 'codex', '--remove'], env)
  assert.strictEqual(r3.code, 0, 'remove exits 0')
  assert.ok(!readFileSync(join(HOME, '.codex', 'hooks.json'), 'utf8').includes('forwarder.mjs'), 'fleet hooks gone')
  ok('`fleet setup --agent codex --remove` strips our hooks cleanly')

  // === D. cursor is honest about not-yet-available (doesn't half-wire) ===
  const r4 = await run([fleetCli, 'setup', '--agent', 'cursor', '--code', 'FLEET-XX'], env)
  assert.strictEqual(r4.code, 2, 'cursor (no adapter yet) exits 2')
  ok('cursor reports honestly (exit 2) until the adapter ships — no half-wiring')

  // === E. standalone install-codex.mjs also bakes the stable path + trust gate ===
  const HOME2 = mkdtempSync(join(tmpdir(), 'fleet-cli2-'))
  const r5 = await run([installCodex], { HOME: HOME2, FLEET_CLOUD_URL: BASE })
  assert.strictEqual(r5.code, 0, 'install-codex exits 0')
  const ch2 = readFileSync(join(HOME2, '.codex', 'hooks.json'), 'utf8')
  assert.ok(ch2.includes(join(HOME2, '.fleet-commander', 'scripts')), 'install-codex bakes the stable dir')
  assert.ok(!ch2.includes(join(pluginRoot, 'scripts')), 'install-codex no longer bakes the plugin dir')
  assert.match(r5.out, /\/hooks/, 'install-codex surfaces the Codex trust gate (run /hooks)')
  ok('standalone install-codex.mjs: stable path + trust-gate message')

  rmSync(HOME, { recursive: true, force: true })
  rmSync(HOME2, { recursive: true, force: true })
  console.log(`\n✅ ${pass} checks passed — unified setup CLI + Codex stale-path fix\n`)
} finally {
  server.kill()
}
