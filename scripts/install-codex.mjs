#!/usr/bin/env node
// install-codex.mjs — wire Fleet Commander into the OpenAI Codex CLI.
//
//   node scripts/install-codex.mjs            # install / refresh
//   node scripts/install-codex.mjs --uninstall
//
// Codex discovers lifecycle hooks from ~/.codex/hooks.json (same JSON schema as
// Claude Code's hooks.json). Codex's hook stdin shape and PreToolUse allow/deny
// stdout protocol are identical to Claude's, so the runtime (forwarder.mjs +
// approve-hook.mjs) is reused verbatim — only FLEET_AGENT=codex differs.
//
// The hooks point at a STABLE copy of the runtime in ~/.fleet-commander/scripts
// (see lib/install-common.mjs) — NOT this plugin dir, which under npx lives in an
// ephemeral cache that would leave the baked path dangling. The shared merge only
// rewrites hooks.json when it actually changes, so Codex's hook-trust gate isn't
// re-triggered needlessly.

import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  copyRuntimeScripts, SCRIPTS_DIR, installAgentHooks, uninstallAgentHooks,
} from './lib/install-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))     // the plugin's scripts dir
const pluginRoot = resolve(here, '..')
const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')
const templatePath = join(pluginRoot, 'codex', 'hooks.template.json')

if (process.argv.includes('--uninstall')) {
  uninstallAgentHooks({ hooksPath: HOOKS_PATH })
  console.log(`Fleet Commander Codex hooks removed from ${HOOKS_PATH}`)
} else {
  copyRuntimeScripts(here) // stable copy → ~/.fleet-commander/scripts
  const { changed } = installAgentHooks({ hooksPath: HOOKS_PATH, templatePath, scriptsDir: SCRIPTS_DIR })
  console.log(`Fleet Commander wired into Codex → ${HOOKS_PATH}`)
  console.log(`  runtime:  ${SCRIPTS_DIR}  (stable copy — survives plugin updates)`)
  console.log(`  agent:    codex  (FLEET_AGENT=codex)`)
  console.log(`  pairing:  reuses ~/.fleet-commander/config.json — run /fleet-link in Claude Code,`)
  console.log(`            or: node "${join(here, 'link.mjs')}" FLEET-XXXXXX`)
  if (changed) {
    console.log(`\n⚠️  Codex requires you to TRUST hooks before they run:`)
    console.log(`    open Codex and run \`/hooks\`, then approve Fleet Commander.`)
  } else {
    console.log(`\n  Hooks already current — no \`/hooks\` re-approval needed.`)
  }
}
