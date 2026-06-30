// mcp-ask-human.mjs — the ask_human MCP server (stdio JSON-RPC) + Codex config.toml
// registration. No network: the unpaired tools/call returns an isError immediately,
// and the config.toml splice is tested against a throwaway $HOME.
//
//   node test/mcp-ask-human.mjs

import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const server = join(pluginRoot, 'scripts', 'mcp-ask-human.mjs')
const node = process.execPath

let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }

console.log('\nFleet Commander plugin — ask_human MCP server + Codex registration\n')

// === A. JSON-RPC stdio handshake (unpaired → tools/call is a clean isError) ===
{
  const HOME = mkdtempSync(join(tmpdir(), 'fc-mcp-'))
  const child = spawn(node, [server], { env: { ...process.env, HOME, FLEET_AGENT: 'claude' }, stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => (out += d))
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_human', arguments: { question: 'which env?' } } })

  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000)
    const check = () => { if (out.includes('"id":3')) { clearTimeout(t); child.stdout.off('data', check); resolve() } }
    child.stdout.on('data', check)
    check()
  })
  child.kill()

  const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const init = msgs.find((m) => m.id === 1)
  assert.strictEqual(init.result.serverInfo.name, 'fleet-ask-human', 'initialize returns serverInfo')
  assert.ok(init.result.capabilities.tools, 'advertises tools capability')
  ok('initialize handshake → serverInfo + tools capability')

  const list = msgs.find((m) => m.id === 2)
  assert.strictEqual(list.result.tools[0].name, 'ask_human', 'tools/list advertises ask_human')
  assert.ok(list.result.tools[0].inputSchema.required.includes('question'), 'ask_human requires a question')
  ok('tools/list advertises ask_human with a required question')

  const call = msgs.find((m) => m.id === 3)
  assert.ok(call.result.isError, 'unpaired tools/call returns isError (never hangs)')
  assert.match(call.result.content[0].text, /not paired/i, 'error explains it is not paired')
  ok('unpaired ask_human → immediate isError (loud, never hangs the agent)')
  rmSync(HOME, { recursive: true, force: true })
}

// === B. Codex config.toml registration: splice-in, idempotent, non-clobbering ===
{
  const HOME = mkdtempSync(join(tmpdir(), 'fc-toml-'))
  process.env.HOME = HOME // redirect homedir() BEFORE importing install-common
  mkdirSync(join(HOME, '.codex'), { recursive: true })
  writeFileSync(join(HOME, '.codex', 'config.toml'), '[history]\nmax_bytes = 1000\n')
  const { installCodexMcp, uninstallCodexMcp } = await import('../scripts/lib/install-common.mjs')
  const stableDir = join(HOME, '.fleet-commander', 'scripts')
  const tomlPath = join(HOME, '.codex', 'config.toml')

  const i1 = installCodexMcp(stableDir)
  assert.strictEqual(i1.changed, true, 'first install writes the block')
  let toml = readFileSync(tomlPath, 'utf8')
  assert.ok(toml.includes('[history]'), 'preserves the user\'s existing table')
  assert.ok(toml.includes('[mcp_servers.fleet_ask_human]'), 'adds the managed MCP table')
  assert.ok(toml.includes(join(stableDir, 'mcp-ask-human.mjs')), 'bakes the stable script path')
  assert.match(toml, /tool_timeout_sec\s*=\s*900/, 'sets a long tool_timeout_sec for blocking asks')
  ok('installCodexMcp adds the MCP block + preserves existing config')

  const afterFirst = toml
  const i2 = installCodexMcp(stableDir)
  assert.strictEqual(i2.changed, false, 're-install is a no-op')
  assert.strictEqual(readFileSync(tomlPath, 'utf8'), afterFirst, 'config.toml byte-identical on re-install')
  ok('installCodexMcp is idempotent (no churn on re-run)')

  const u1 = uninstallCodexMcp()
  assert.strictEqual(u1.changed, true, 'uninstall removes the block')
  toml = readFileSync(tomlPath, 'utf8')
  assert.ok(!toml.includes('mcp_servers.fleet_ask_human'), 'managed block gone after uninstall')
  assert.ok(toml.includes('[history]'), 'user table still intact after uninstall')
  ok('uninstallCodexMcp removes only the managed block, leaving user config intact')
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n✅ ${pass} checks passed — ask_human MCP server + Codex registration\n`)
