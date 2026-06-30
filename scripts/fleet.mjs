#!/usr/bin/env node
// fleet.mjs — one-command setup: wire an agent's hooks AND pair, in a single run.
// This is the unified onboarding entry point; the iPhone app surfaces it as a
// per-agent copy-paste line with the pairing code baked in, e.g.
//
//   npx -y fleet-commander@<pinned> setup --agent codex --code FLEET-AB12CD
//
// Locally (from the plugin):
//   node scripts/fleet.mjs setup --agent codex  --code FLEET-AB12CD
//   node scripts/fleet.mjs setup --agent cursor --code FLEET-AB12CD
//   node scripts/fleet.mjs setup --agent codex  --remove
//
// Two phases, separated so re-running is safe: wiring hooks is idempotent (always
// re-asserted); claiming a code is one-time (skipped if already paired).

import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  copyRuntimeScripts, SCRIPTS_DIR, installAgentHooks, uninstallAgentHooks, linkFleet,
} from './lib/install-common.mjs'
import { readConfig } from './lib/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const AGENTS = {
  claude: { },
  codex:  { hooks: join(homedir(), '.codex', 'hooks.json'),  template: join(pluginRoot, 'codex', 'hooks.template.json'),  trust: 'open Codex and run `/hooks`, then approve Fleet Commander.' },
  cursor: { hooks: join(homedir(), '.cursor', 'hooks.json'), template: join(pluginRoot, 'cursor', 'hooks.template.json'), trust: 'Cursor hooks are beta — re-verify after a Cursor upgrade.' },
}

// --- tiny arg parser: flags (--agent x / --code y / --remove) + positionals ---
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (key === 'remove' || key === 'uninstall') out.remove = true
      else { out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true }
    } else out._.push(a)
  }
  return out
}

function usage(msg) {
  if (msg) console.error(`✗ ${msg}\n`)
  console.error('Usage:')
  console.error('  fleet setup --agent <claude|codex|cursor> --code FLEET-XXXX')
  console.error('  fleet setup --agent <codex|cursor> --remove')
  process.exit(msg ? 1 : 0)
}

const args = parseArgs(process.argv.slice(2))
const sub = args._[0]
if (sub !== 'setup') usage(sub ? `unknown command "${sub}"` : null)

const agent = (args.agent || args._[1] || '').toLowerCase()
const code = args.code || args._[2]
if (!AGENTS[agent]) usage(`--agent must be one of: ${Object.keys(AGENTS).join(', ')}`)
const A = AGENTS[agent]

// --- uninstall path ----------------------------------------------------------
if (args.remove) {
  if (agent === 'claude') { console.log('Claude Code hooks ship with the marketplace plugin — remove it with `claude plugin uninstall fleet-commander`.'); process.exit(0) }
  uninstallAgentHooks({ hooksPath: A.hooks })
  console.log(`✓ Fleet Commander ${agent} hooks removed from ${A.hooks}`)
  process.exit(0)
}

// --- 1. stable runtime copy --------------------------------------------------
copyRuntimeScripts(here)

// --- 2. wire the agent's hooks (idempotent) ----------------------------------
let trustNote = ''
if (agent === 'claude') {
  console.log('Claude Code wires automatically via the marketplace plugin:')
  console.log('  claude plugin marketplace add sideffect263/fleet-commander')
  console.log('  claude plugin install fleet-commander')
} else if (!existsSync(A.template)) {
  // Cursor adapter not shipped in this version yet — fail honestly, don't half-wire.
  console.log(`\n⚠️  ${agent} support isn't available in this version yet.`)
  console.log(`    Claude Code and Codex are supported today.`)
  process.exit(2)
} else {
  const { changed } = installAgentHooks({ hooksPath: A.hooks, templatePath: A.template, scriptsDir: SCRIPTS_DIR })
  console.log(`✓ Fleet Commander wired into ${agent} → ${A.hooks}`)
  console.log(`  runtime: ${SCRIPTS_DIR}  (stable copy — survives updates)`)
  if (changed && A.trust) trustNote = A.trust
}

// --- 3. pair (one-time; skip if already linked) ------------------------------
const cfg = readConfig()
if (cfg.deviceToken && !code) {
  console.log(`\n✓ Already paired to ${cfg.accountId || 'your fleet'} — hooks refreshed.`)
} else if (code) {
  const r = await linkFleet(code)
  if (!r.ok) {
    console.error(`\n✗ Pairing failed: ${r.message}`)
    console.error(`  (Hooks are wired; re-run with a fresh --code from the app to finish pairing.)`)
    process.exit(1)
  }
  console.log(`\n✓ Paired to ${r.accountId}`)
} else {
  console.log(`\nNot paired yet — get a code from the iPhone app's "Add fleet" screen, then run:`)
  console.log(`  fleet setup --agent ${agent} --code FLEET-XXXX`)
}

if (trustNote) console.log(`\n⚠️  One more step: ${trustNote}`)
console.log(`\nRun ${agent === 'claude' ? 'Claude Code' : agent} and your sessions appear as ships on your phone. 🚀`)
