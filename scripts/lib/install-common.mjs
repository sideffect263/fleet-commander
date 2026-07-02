// install-common.mjs — shared helpers for wiring Fleet Commander into any
// hook-capable agent (Codex, Cursor) and for pairing. Centralizes the "stable
// scripts dir" fix and the hooks.json merge so install-codex.mjs, install-cursor.mjs
// (later), and the unified `fleet setup` CLI all share one implementation.
//
// THE STALE-PATH FIX: an agent's hooks.json must invoke the runtime from a
// STABLE, user-owned dir (~/.fleet-commander/scripts), never the plugin's own
// install dir. Under npx/marketplace the plugin lives in an ephemeral,
// content-hashed cache (~/.npm/_npx/<hash>/…) that changes every version bump or
// eviction — baking that path leaves the hooks pointing at a dead location.
// (Claude Code dodges this with the portable ${CLAUDE_PLUGIN_ROOT}; the other
// agents have no equivalent, so we copy the runtime to a path WE control.)

import {
  readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, readdirSync, existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { SCRIPTS_DIR, readConfig, writeConfig, writeAuthState } from './config.mjs'

export { SCRIPTS_DIR }

// The runtime files an agent's hooks invoke: the monitor forwarder, the approval
// hook, and the heartbeat daemon the forwarder spawns (`new URL('./fleet-daemon.mjs')`
// resolves NEXT to the copied forwarder, so it must live alongside it). Plus the
// optional Cursor adapter once it ships. The whole lib/ they import comes too.
const RUNTIME_FILES = ['forwarder.mjs', 'approve-hook.mjs', 'fleet-daemon.mjs', 'cursor-adapter.mjs', 'mcp-ask-human.mjs', 'ask-human.mjs']

/**
 * Copy the hook runtime from the plugin's scripts dir into the stable dir.
 * Idempotent; overwrites so a re-run refreshes to the current plugin version.
 * Returns the stable dir the caller should bake into hooks.json.
 */
export function copyRuntimeScripts(srcScriptsDir) {
  mkdirSync(join(SCRIPTS_DIR, 'lib'), { recursive: true })
  for (const f of RUNTIME_FILES) {
    const src = join(srcScriptsDir, f)
    if (existsSync(src)) copyFileSync(src, join(SCRIPTS_DIR, f))
  }
  const libSrc = join(srcScriptsDir, 'lib')
  if (existsSync(libSrc)) {
    for (const f of readdirSync(libSrc)) {
      if (f.endsWith('.mjs')) copyFileSync(join(libSrc, f), join(SCRIPTS_DIR, 'lib', f))
    }
  }
  return SCRIPTS_DIR
}

// --- hooks.json merge (shared across agents) --------------------------------
// A handler "belongs to Fleet Commander" if its command runs one of our runtime
// scripts. Matches BOTH shapes: Claude/Codex groups ({hooks:[{command}]}) and
// Cursor's flatter entries ({command}). So merge/strip works for every agent.

const FLEET_RE = /forwarder\.mjs|approve-hook\.mjs|cursor-adapter\.mjs/
const isFleetCommand = (cmd) => typeof cmd === 'string' && FLEET_RE.test(cmd)

function isFleetGroup(group) {
  if (!group || typeof group !== 'object') return false
  if (isFleetCommand(group.command)) return true                          // Cursor flat entry
  if (Array.isArray(group.hooks)) return group.hooks.some((h) => isFleetCommand(h.command)) // Claude/Codex group
  return false
}

/** Remove our handlers from an existing hooks map (used by merge + uninstall). */
function stripFleet(hooks) {
  const out = {}
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) { out[event] = groups; continue }
    const kept = groups.filter((g) => !isFleetGroup(g))
    if (kept.length) out[event] = kept
  }
  return out
}

function readJsonRaw(path) { try { return readFileSync(path, 'utf8') } catch { return null } }
function writeJsonAtomic(path, str) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, str)
  renameSync(tmp, path)
}

/** Render a hooks template, replacing __FLEET_SCRIPTS__ with the stable dir. */
function loadTemplateHooks(templatePath, scriptsDir) {
  const raw = readFileSync(templatePath, 'utf8').replaceAll('__FLEET_SCRIPTS__', scriptsDir)
  const parsed = JSON.parse(raw)
  delete parsed._comment
  return parsed.hooks
}

/**
 * Merge the Fleet Commander handlers from `templatePath` into the agent's
 * hooks.json (preserving the user's other hooks), writing ONLY if the content
 * actually changed — so we don't needlessly re-trigger an agent's hook-trust
 * re-approval (Codex/Cursor make the user re-approve on every hash change).
 * Returns { changed, hooksPath }.
 */
export function installAgentHooks({ hooksPath, templatePath, scriptsDir }) {
  const fleet = loadTemplateHooks(templatePath, scriptsDir)
  const existingRaw = readJsonRaw(hooksPath)
  let existing = {}
  if (existingRaw) { try { existing = JSON.parse(existingRaw) } catch { existing = {} } }
  const base = stripFleet(existing.hooks || {})
  const merged = { ...base }
  for (const [event, groups] of Object.entries(fleet)) {
    merged[event] = [...(merged[event] || []), ...groups]
  }
  const nextStr = JSON.stringify({ ...existing, hooks: merged }, null, 2) + '\n'
  if (existingRaw === nextStr) return { changed: false, hooksPath }
  writeJsonAtomic(hooksPath, nextStr)
  return { changed: true, hooksPath }
}

/** Strip our handlers back out (uninstall). Returns { changed }. */
export function uninstallAgentHooks({ hooksPath }) {
  const existingRaw = readJsonRaw(hooksPath)
  if (!existingRaw) return { changed: false }
  let existing = {}
  try { existing = JSON.parse(existingRaw) } catch { return { changed: false } }
  const base = stripFleet(existing.hooks || {})
  const next = { ...existing }
  if (Object.keys(base).length) next.hooks = base; else delete next.hooks
  const nextStr = JSON.stringify(next, null, 2) + '\n'
  if (existingRaw === nextStr) return { changed: false }
  writeJsonAtomic(hooksPath, nextStr)
  return { changed: true }
}

// --- Codex MCP registration (ask_human) -------------------------------------
// Claude Code ships the ask_human MCP server via plugin.json's mcpServers (with
// ${CLAUDE_PLUGIN_ROOT}); Codex has no plugin manifest, so we register the server
// in ~/.codex/config.toml. config.toml is TOML (not JSON), so rather than parse it
// we manage ONLY our own sentinel-delimited block — append it if absent, replace it
// if present — leaving every other table untouched. Idempotent.

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml')
const MCP_BEGIN = '# >>> fleet-commander ask_human (managed — do not edit) >>>'
const MCP_END = '# <<< fleet-commander ask_human (managed) <<<'

function codexMcpBlock(scriptsDir) {
  const scriptPath = join(scriptsDir, 'mcp-ask-human.mjs')
  // JSON.stringify yields a valid TOML basic string for ordinary paths (escapes
  // backslashes/quotes). Codex enforces a per-tool timeout (default 60s); ask_human
  // blocks for minutes, so tool_timeout_sec must comfortably exceed the MCP server's
  // own ask timeout (10 min) — 900s gives headroom so the server times out first.
  return [
    MCP_BEGIN,
    '[mcp_servers.fleet_ask_human]',
    'command = "node"',
    `args = [${JSON.stringify(scriptPath)}]`,
    'env = { FLEET_AGENT = "codex" }',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 900',
    MCP_END,
  ].join('\n')
}

// Replace any existing managed block (and surrounding blank lines) — used by both
// install (with a fresh block) and uninstall (with '').
function spliceManaged(raw, replacement) {
  const re = new RegExp(`\\n*${MCP_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MCP_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n*`, 'g')
  const stripped = raw.replace(re, '\n')
  if (!replacement) return stripped.replace(/\n{3,}/g, '\n\n').trimEnd() + (stripped.trim() ? '\n' : '')
  const base = stripped.trimEnd()
  return (base ? base + '\n\n' : '') + replacement + '\n'
}

/** Register the ask_human MCP server in Codex's config.toml (idempotent). */
export function installCodexMcp(scriptsDir = SCRIPTS_DIR) {
  const raw = readJsonRaw(CODEX_CONFIG_PATH) || ''
  const next = spliceManaged(raw, codexMcpBlock(scriptsDir))
  if (raw === next) return { changed: false, configPath: CODEX_CONFIG_PATH }
  writeJsonAtomic(CODEX_CONFIG_PATH, next)
  return { changed: true, configPath: CODEX_CONFIG_PATH }
}

/** Remove the ask_human MCP block from Codex's config.toml. */
export function uninstallCodexMcp() {
  const raw = readJsonRaw(CODEX_CONFIG_PATH)
  if (!raw) return { changed: false }
  const next = spliceManaged(raw, '')
  if (raw === next) return { changed: false }
  writeJsonAtomic(CODEX_CONFIG_PATH, next)
  return { changed: true }
}

// --- pairing (shared by link.mjs + `fleet setup`) ---------------------------

/**
 * Claim a pairing code at the backend and persist the deviceToken to
 * ~/.fleet-commander/config.json. Returns { ok, accountId, baseUrl } on success
 * or { ok:false, reason, message } — the caller prints + sets the exit code.
 */
export async function linkFleet(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase()
  if (!code) return { ok: false, reason: 'missing_code', message: 'no code provided' }
  const cfg = readConfig()
  let res
  try {
    res = await fetch(`${cfg.baseUrl}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: `could not reach the backend at ${cfg.baseUrl}: ${err.message}` }
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const why = {
      unknown_code: 'that code is not recognized — re-check it in the app',
      already_claimed: 'that code was already used — tap "new code" in the app',
      expired: 'that code expired — generate a fresh one in the app',
      missing_code: 'no code provided',
      too_many_attempts: 'too many attempts — wait a minute and try again',
    }[data.error] || data.error || `HTTP ${res.status}`
    return { ok: false, reason: data.error || 'http', message: why }
  }
  writeConfig({ baseUrl: cfg.baseUrl, deviceToken: data.deviceToken, accountId: data.accountId })
  writeAuthState({ strikes: 0 }) // fresh link — clear any prior strikes / auto-unlink marker
  return { ok: true, accountId: data.accountId, baseUrl: cfg.baseUrl }
}
