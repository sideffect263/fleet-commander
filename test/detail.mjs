// detail.mjs — the activity-descriptor redaction (lib/detail.mjs).
//
//   node test/detail.mjs
//
// SECURITY-CRITICAL: this is the only place we look at tool input, so it must
// never emit a full path, a full command, file contents, or a search pattern —
// only basenames + the bare program name (env-var prefixes and paths stripped).

import assert from 'node:assert'
import { toolDetail, bashProgram } from '../scripts/lib/detail.mjs'

let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }

console.log('\nFleet Commander plugin — activity-detail redaction\n')

// --- bashProgram: program (+ safe subcommand) only, never args/secrets --------
{
  assert.strictEqual(bashProgram('npm test'), 'npm test', 'program + subcommand')
  assert.strictEqual(bashProgram('git push origin main'), 'git push', 'args after subcommand dropped')
  assert.strictEqual(bashProgram('ls -la'), 'ls', 'flags dropped (ls not multi-tool)')
  assert.strictEqual(bashProgram('curl https://x.com?token=abc123'), 'curl', 'URL with token NOT leaked')
  assert.strictEqual(bashProgram('/usr/local/bin/node server.js'), 'node', 'leading path stripped to program')
  assert.strictEqual(bashProgram(''), undefined, 'empty → undefined')
  ok('bashProgram: program (+ safe subcommand) only — args/URLs/flags dropped')

  // The load-bearing privacy guarantee: env-var prefixes (which carry secrets) are skipped.
  assert.strictEqual(bashProgram('SECRET=abc npm test'), 'npm test', 'env-prefix secret stripped')
  assert.strictEqual(bashProgram('API_KEY=xyz TOKEN=q git commit -m "msg"'), 'git commit', 'multiple env prefixes stripped')
  assert.ok(!String(bashProgram('AWS_SECRET=topsecret aws s3 ls')).includes('topsecret'), 'secret value never appears')
  ok('bashProgram: leading KEY=value env prefixes (potential secrets) are stripped')
}

// --- toolDetail: basenames for files, host for web, type for subagents --------
{
  assert.strictEqual(toolDetail('Bash', { command: 'npm run build' }), 'npm run', 'Bash → program')
  assert.strictEqual(toolDetail('Edit', { file_path: '/Users/me/proj/src/auth.ts' }), 'auth.ts', 'Edit → basename only (no path)')
  assert.strictEqual(toolDetail('Read', { file_path: '/etc/secrets/config.json' }), 'config.json', 'Read → basename only')
  assert.strictEqual(toolDetail('Write', { file_path: 'a/b/c/index.tsx' }), 'index.tsx', 'Write → basename')
  assert.strictEqual(toolDetail('Task', { subagent_type: 'Explore' }), 'Explore', 'Task → subagent type')
  assert.strictEqual(toolDetail('WebFetch', { url: 'https://www.example.com/page' }), 'example.com', 'WebFetch → host (www stripped)')
  ok('toolDetail: files→basename, bash→program, task→type, webfetch→host')

  assert.strictEqual(toolDetail('Grep', { pattern: 'API_KEY' }), undefined, 'Grep pattern NOT emitted (could be sensitive)')
  assert.strictEqual(toolDetail('Glob', { pattern: '**/*.secret' }), undefined, 'Glob pattern NOT emitted')
  assert.strictEqual(toolDetail('Edit', {}), undefined, 'missing input → undefined')
  assert.strictEqual(toolDetail('Bash', null), undefined, 'no input → undefined')
  assert.strictEqual(toolDetail('', { command: 'x' }), undefined, 'no tool name → undefined')
  ok('toolDetail: search patterns omitted; malformed/empty → undefined')
}

console.log(`\n✅ ${pass} checks passed — activity detail is basename/program-only, secrets stripped\n`)
