#!/usr/bin/env node
// install-codex.mjs — wire Fleet Commander into the OpenAI Codex CLI.
//
//   node scripts/install-codex.mjs            # install / refresh
//   node scripts/install-codex.mjs --uninstall
//
// Codex discovers lifecycle hooks from ~/.codex/hooks.json (same JSON schema as
// Claude Code's hooks.json). Codex's hook stdin shape and PreToolUse allow/deny
// stdout protocol are identical to Claude's, so we reuse THIS plugin's
// forwarder.mjs + approve-hook.mjs verbatim — only FLEET_AGENT=codex differs.
//
// This installer renders codex/hooks.template.json with the absolute path to
// this plugin's scripts dir, then MERGES the Fleet Commander event handlers into
// any pre-existing ~/.codex/hooks.json (it never clobbers a user's other hooks —
// it only owns handlers whose command mentions a Fleet Commander script).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const scriptsDir = join(pluginRoot, 'scripts')
const templatePath = join(pluginRoot, 'codex', 'hooks.template.json')

const CODEX_DIR = join(homedir(), '.codex')
const HOOKS_PATH = join(CODEX_DIR, 'hooks.json')

// A handler "belongs to Fleet Commander" if its command runs one of our scripts.
const isFleetCommand = (cmd) =>
  typeof cmd === 'string' && /forwarder\.mjs|approve-hook\.mjs/.test(cmd)
const isFleetGroup = (group) =>
  Array.isArray(group?.hooks) && group.hooks.some((h) => isFleetCommand(h.command))

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  renameSync(tmp, path)
}

// Strip our Fleet Commander handlers out of an existing hooks map (used by both
// merge — to replace stale ones — and uninstall).
function stripFleet(existingHooks) {
  const out = {}
  for (const [event, groups] of Object.entries(existingHooks || {})) {
    if (!Array.isArray(groups)) { out[event] = groups; continue }
    const kept = groups.filter((g) => !isFleetGroup(g))
    if (kept.length) out[event] = kept
  }
  return out
}

function loadFleetHooks() {
  const raw = readFileSync(templatePath, 'utf8').replaceAll('__FLEET_SCRIPTS__', scriptsDir)
  const parsed = JSON.parse(raw)
  delete parsed._comment
  return parsed.hooks
}

function main() {
  const uninstall = process.argv.includes('--uninstall')
  const existing = readJson(HOOKS_PATH) || {}
  const base = stripFleet(existing.hooks || {})

  if (uninstall) {
    const next = { ...existing, hooks: base }
    if (!Object.keys(base).length) delete next.hooks
    writeJsonAtomic(HOOKS_PATH, next)
    console.log(`Fleet Commander Codex hooks removed from ${HOOKS_PATH}`)
    return
  }

  const fleet = loadFleetHooks()
  const merged = { ...base }
  for (const [event, groups] of Object.entries(fleet)) {
    merged[event] = [...(merged[event] || []), ...groups]
  }
  writeJsonAtomic(HOOKS_PATH, { ...existing, hooks: merged })

  console.log(`Fleet Commander wired into Codex → ${HOOKS_PATH}`)
  console.log(`  scripts:  ${scriptsDir}`)
  console.log(`  agent:    codex  (FLEET_AGENT=codex)`)
  console.log(`  pairing:  reuses ~/.fleet-commander/config.json — run /fleet-link in Claude Code,`)
  console.log(`            or: node "${join(scriptsDir, 'link.mjs')}" FLEET-XXXXXX`)
}

main()
