// outbox.mjs — the fire-and-forget delivery queue's pure rules + IO, hermetically.
//
//   node test/outbox.mjs   (or part of: npm test)
//
// Proves the guarantees the forwarder→daemon split relies on: enqueue stamps a
// stable eventId + appends one line; dedupe drops duplicate ids; drop-oldest keeps
// the newest N on overflow; drain posts oldest-first, removes only delivered (2xx)
// lines, leaves the unsent remainder IN ORDER on a network failure, and poison-drops
// permanent 400/413 without retrying. A fake `post` (no real HTTP) + a throwaway
// $HOME keep it fully hermetic — no backend, no touching the real ~/.fleet-commander.
//
// NOTE: OUTBOX_PATH is derived from homedir() at import time, so HOME is redirected
// to a temp dir BEFORE the module is imported (same trick as test/mcp-ask-human.mjs).

import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'fc-outbox-'))
process.env.HOME = HOME // redirect homedir() BEFORE importing the module under test
delete process.env.FLEET_CLOUD_URL

const {
  enqueueEvent, drain, dedupe, trimToCaps, makeEventId, outboxSize,
  OUTBOX_MAX_EVENTS,
} = await import('../scripts/lib/outbox.mjs')
const { OUTBOX_PATH } = await import('../scripts/lib/config.mjs')

let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }
const readLines = () => (existsSync(OUTBOX_PATH) ? readFileSync(OUTBOX_PATH, 'utf8').split('\n').filter(Boolean) : [])

console.log('\nFleet Commander plugin — outbox (fire-and-forget delivery queue)\n')

try {
  // === enqueue: stamps an eventId + appends exactly one line ===
  {
    enqueueEvent({ name: 'PreToolUse', sessionId: 's1', toolName: 'Bash' })
    const lines = readLines()
    assert.strictEqual(lines.length, 1, 'one enqueue → one line')
    const ev = JSON.parse(lines[0])
    assert.ok(ev.eventId && typeof ev.eventId === 'string', 'enqueue stamps an eventId')
    assert.ok(ev.eventId.startsWith('s1:'), 'eventId carries the sessionId prefix')
    assert.strictEqual(ev.name, 'PreToolUse', 'envelope fields preserved')
    assert.strictEqual(outboxSize(), 1, 'outboxSize reflects one queued event')

    enqueueEvent({ name: 'PostToolUse', sessionId: 's1', toolName: 'Bash' })
    assert.strictEqual(readLines().length, 2, 'second enqueue appends (does not overwrite)')
    assert.strictEqual(outboxSize(), 2, 'outboxSize now 2')
    // A caller-supplied eventId is preserved (not re-stamped).
    enqueueEvent({ name: 'Stop', sessionId: 's1', eventId: 'fixed-id-1' })
    assert.strictEqual(JSON.parse(readLines()[2]).eventId, 'fixed-id-1', 'explicit eventId is preserved')
    ok('enqueue stamps an eventId + appends one line per event')
  }

  // === makeEventId: unique across rapid calls (seq disambiguates same-ms) ===
  {
    const ids = new Set()
    for (let i = 0; i < 500; i++) ids.add(makeEventId('sX'))
    assert.strictEqual(ids.size, 500, 'makeEventId is unique across 500 rapid calls')
    ok('makeEventId is unique even within the same millisecond')
  }

  // === dedupe (pure): drops duplicate eventIds, keeps first, preserves order ===
  {
    const lines = [
      JSON.stringify({ eventId: 'a', n: 1 }),
      JSON.stringify({ eventId: 'b', n: 2 }),
      JSON.stringify({ eventId: 'a', n: 3 }), // dup of a → dropped
      'not json',                              // garbage → dropped
      JSON.stringify({ eventId: 'c', n: 4 }),
      JSON.stringify({ noId: true }),          // no eventId → kept as-is
    ]
    const out = dedupe(lines).map((l) => JSON.parse(l))
    assert.deepStrictEqual(out.map((e) => e.eventId ?? '-'), ['a', 'b', 'c', '-'], 'dedupe keeps first of each id, drops dups + garbage, keeps id-less')
    ok('dedupe drops duplicate eventIds (and garbage) while preserving order')
  }

  // === trimToCaps (pure): drop-OLDEST keeps the newest N on overflow ===
  {
    const many = Array.from({ length: OUTBOX_MAX_EVENTS + 50 }, (_, i) => JSON.stringify({ eventId: `e${i}`, i }))
    const kept = trimToCaps(many)
    assert.strictEqual(kept.length, OUTBOX_MAX_EVENTS, `trims down to OUTBOX_MAX_EVENTS (${OUTBOX_MAX_EVENTS})`)
    assert.strictEqual(JSON.parse(kept[0]).i, 50, 'drops the OLDEST — keeps the newest window')
    assert.strictEqual(JSON.parse(kept[kept.length - 1]).i, OUTBOX_MAX_EVENTS + 49, 'newest event retained')
    ok('trimToCaps drops the oldest events, keeping the newest N on overflow')
  }

  // === enqueue overflow: file never exceeds OUTBOX_MAX_EVENTS ===
  {
    rmSync(OUTBOX_PATH, { force: true })
    for (let i = 0; i < OUTBOX_MAX_EVENTS + 25; i++) enqueueEvent({ name: 'Ping', sessionId: 'sO', i })
    const lines = readLines()
    assert.ok(lines.length <= OUTBOX_MAX_EVENTS, `enqueue keeps the file at/under the cap (got ${lines.length})`)
    // The newest event must survive; the oldest must have been dropped.
    assert.strictEqual(JSON.parse(lines[lines.length - 1]).i, OUTBOX_MAX_EVENTS + 24, 'newest enqueued event survives overflow trim')
    assert.ok(JSON.parse(lines[0]).i > 0, 'the very oldest event was trimmed away')
    ok('enqueue enforces the drop-oldest cap on overflow')
  }

  // === drain: posts oldest-first, removes only 2xx, leaves remainder IN ORDER ===
  {
    rmSync(OUTBOX_PATH, { force: true })
    for (const i of [1, 2, 3, 4, 5]) enqueueEvent({ name: 'E', sessionId: 's', i })

    // Fake backend: 200 for the first 2, then a transient network failure (0) — drain
    // must STOP there and keep 3,4,5 in order.
    const seen = []
    let calls = 0
    const post = async (ev) => { seen.push(ev.i); return ++calls <= 2 ? 200 : 0 }
    const res = await drain(post)

    assert.deepStrictEqual(seen, [1, 2, 3], 'posts oldest-first, stops at the first failure')
    assert.strictEqual(res.drained, 2, 'reports 2 delivered')
    assert.strictEqual(res.lastStatus, 0, 'reports the transient last status (0)')
    const remaining = readLines().map((l) => JSON.parse(l).i)
    assert.deepStrictEqual(remaining, [3, 4, 5], 'unsent remainder stays IN ORDER on network-fail')
    ok('drain posts oldest-first, removes only 2xx, leaves the remainder in order on failure')
  }

  // === drain: resumes and fully drains on the next successful pass ===
  {
    // Continues from [3,4,5] above — now everything succeeds.
    const seen = []
    const res = await drain(async (ev) => { seen.push(ev.i); return 200 })
    assert.deepStrictEqual(seen, [3, 4, 5], 'resumes from where it left off, in order')
    assert.strictEqual(res.remaining, 0, 'outbox fully drained')
    assert.strictEqual(readLines().length, 0, 'outbox file is empty after a full drain')
    assert.strictEqual(outboxSize(), 0, 'outboxSize is 0 after a full drain')
    ok('drain resumes and fully empties the outbox on a clean pass')
  }

  // === drain: poison 400/413 is DROPPED, not retried; queue keeps draining ===
  {
    rmSync(OUTBOX_PATH, { force: true })
    for (const i of [1, 2, 3]) enqueueEvent({ name: 'E', sessionId: 's', i })
    const seen = []
    // Middle event is poison (400) — it must be dropped and 3 still delivered.
    const post = async (ev) => { seen.push(ev.i); return ev.i === 2 ? 400 : 200 }
    const res = await drain(post)
    assert.deepStrictEqual(seen, [1, 2, 3], 'attempts every line — the poison line does not wedge the queue')
    assert.strictEqual(res.remaining, 0, 'poison line dropped (not left to retry forever)')
    assert.strictEqual(readLines().length, 0, 'queue fully cleared: 2xx delivered + poison dropped')
    ok('drain poison-drops 400/413 without retrying, keeps draining the rest')

    // 413 behaves the same as 400.
    enqueueEvent({ name: 'E', sessionId: 's', i: 9 })
    const r2 = await drain(async () => 413)
    assert.strictEqual(r2.remaining, 0, '413 is dropped like 400')
    ok('drain poison-drops 413 (oversized) too')
  }

  // === drain: 401/403 stops the batch (auth-dead) and surfaces lastStatus ===
  {
    rmSync(OUTBOX_PATH, { force: true })
    for (const i of [1, 2, 3]) enqueueEvent({ name: 'E', sessionId: 's', i })
    const seen = []
    // First line 401 → drain stops, surfaces 401 so the daemon can strike/unlink.
    const res = await drain(async (ev) => { seen.push(ev.i); return 401 })
    assert.deepStrictEqual(seen, [1], 'stops at the first auth rejection (does not hammer the rest)')
    assert.strictEqual(res.lastStatus, 401, 'surfaces 401 so the daemon reacts (3-strike unlink)')
    ok('drain stops on 401/403 and surfaces the auth status upstream')
  }

  // === drain: empty outbox is a clean no-op ===
  {
    rmSync(OUTBOX_PATH, { force: true })
    const res = await drain(async () => { throw new Error('post must not be called for an empty outbox') })
    assert.strictEqual(res.drained, 0, 'nothing drained')
    assert.strictEqual(res.remaining, 0, 'nothing remains')
    ok('drain on an empty outbox is a clean no-op')
  }

  // === config round-trips BOTH toggles: approvals.mjs and ask-human.mjs each
  //     preserve the OTHER's block, so flipping one never silently drops the other.
  //     Run the REAL CLI scripts against a paired temp HOME (spawnSync in a child
  //     $HOME so config.mjs's homedir()-derived CONFIG_PATH points there). ===
  {
    const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
    const CHOME = mkdtempSync(join(tmpdir(), 'fc-cfg-'))
    mkdirSync(join(CHOME, '.fleet-commander'), { recursive: true })
    const cfgPath = join(CHOME, '.fleet-commander', 'config.json')
    // Seed a paired config so the CLIs don't bail on "not paired".
    writeFileSync(cfgPath, JSON.stringify({ baseUrl: 'http://x', deviceToken: 'dev_t', accountId: 'a' }))
    // Strip FLEET_ASK_HUMAN / FLEET_CLOUD_URL so the file (not env) is the source of truth.
    const childEnv = { ...process.env, HOME: CHOME }
    delete childEnv.FLEET_ASK_HUMAN
    delete childEnv.FLEET_CLOUD_URL
    const run = (script, arg) => spawnSync(process.execPath, [join(scripts, script), arg], { env: childEnv, encoding: 'utf8' })
    const readCfg = () => JSON.parse(readFileSync(cfgPath, 'utf8'))

    // 1) Turn approvals ON.
    let r = run('approvals.mjs', 'on')
    assert.strictEqual(r.status, 0, `approvals.mjs on exits 0 (stderr: ${r.stderr})`)
    assert.strictEqual(readCfg().approvals.enabled, true, 'approvals now ON')

    // 2) Turn ask_human ON → approvals must SURVIVE.
    r = run('ask-human.mjs', 'on')
    assert.strictEqual(r.status, 0, `ask-human.mjs on exits 0 (stderr: ${r.stderr})`)
    let c = readCfg()
    assert.strictEqual(c.askHuman.enabled, true, 'askHuman now ON')
    assert.strictEqual(c.approvals?.enabled, true, 'approvals PRESERVED after ask-human toggle (not dropped)')
    assert.ok(Array.isArray(c.approvals.tools) && c.approvals.tools.includes('Bash'), 'approvals.tools preserved too')

    // 3) Turn approvals OFF → askHuman must SURVIVE.
    r = run('approvals.mjs', 'off')
    assert.strictEqual(r.status, 0, `approvals.mjs off exits 0 (stderr: ${r.stderr})`)
    c = readCfg()
    assert.strictEqual(c.approvals.enabled, false, 'approvals now OFF')
    assert.strictEqual(c.askHuman?.enabled, true, 'askHuman PRESERVED after approvals toggle (not dropped)')

    // 4) Both blocks coexist in the persisted file.
    assert.ok(c.approvals && c.askHuman, 'BOTH approvals and askHuman blocks present in config.json')
    rmSync(CHOME, { recursive: true, force: true })
    ok('config round-trips BOTH toggles — approvals + askHuman never drop each other')
  }

  console.log(`\n✅ ${pass} checks passed — outbox enqueue/dedupe/cap/drain guarantees hold\n`)
} catch (err) {
  console.error(`\n✗ outbox test failed: ${err.message}\n`, err.stack)
  process.exitCode = 1
} finally {
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}
