// detail.mjs — derive a SHORT, BASENAME-SAFE activity descriptor from a tool's
// input, so a ship can show WHAT it's doing ("auth.ts", "npm test") not just a
// generic action. Privacy is load-bearing here: this is the one place we look at
// tool input, so it must NEVER emit a full path, file contents, a full command,
// or a search pattern — only basenames + the program name (with env-var prefixes
// and any path stripped, so `SECRET=x /usr/bin/npm test` → "npm test").

const lastSegment = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : undefined)

// Programs whose first subcommand is itself safe + informative (git push, npm test).
const MULTI = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'go', 'docker', 'kubectl', 'make',
  'python', 'python3', 'node', 'pip', 'pip3', 'bun', 'deno', 'terraform', 'gh', 'brew', 'rails',
])

/** The program (and a safe subcommand) from a shell command — never its args. */
export function bashProgram(cmd) {
  const tokens = String(cmd || '').trim().split(/\s+/)
  let i = 0
  // Skip leading env-var assignments (KEY=value …) — these can carry secrets.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  let prog = tokens[i]
  if (!prog || prog.includes('=')) return undefined
  prog = prog.split(/[\\/]/).pop() // strip any path → bare program name
  if (!prog) return undefined
  const sub = tokens[i + 1]
  // Add the subcommand only for known multi-tools, and only if it's a plain word
  // (so flags like "-m" or arg values are never included).
  if (MULTI.has(prog) && sub && /^[a-z][a-z0-9:-]*$/.test(sub)) return `${prog} ${sub}`
  return prog
}

/**
 * A short, safe descriptor for a tool call, or undefined. Files → basename only;
 * Bash → program (+ safe subcommand); Task → subagent type; WebFetch → host. Other
 * tools (Grep/Glob/WebSearch patterns) deliberately return undefined — a search
 * term could itself be sensitive.
 */
export function toolDetail(toolName, toolInput) {
  if (!toolName || !toolInput || typeof toolInput !== 'object') return undefined
  const tn = String(toolName).toLowerCase()
  let d
  if (tn === 'bash' || tn === 'shell' || tn === 'bashoutput' || tn === 'killshell') {
    d = bashProgram(toolInput.command)
  } else if (['read', 'edit', 'write', 'multiedit', 'notebookedit'].includes(tn)) {
    d = lastSegment(toolInput.file_path || toolInput.notebook_path || toolInput.path)
  } else if (tn === 'task' || tn === 'agent') {
    d = toolInput.subagent_type ? String(toolInput.subagent_type) : undefined
  } else if (tn === 'webfetch') {
    try { d = new URL(toolInput.url).hostname.replace(/^www\./, '') } catch { /* not a url */ }
  }
  return d ? String(d).slice(0, 80) : undefined
}
