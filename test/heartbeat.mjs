// heartbeat.mjs — the daemon's pure liveness rule (classifyLeases).
//
//   node test/heartbeat.mjs   (or part of: npm test)
//
// A session is "alive" (worth beating to /v1/heartbeat) while its newest sign of
// life — transcript mtime OR last hook — is recent, so a long silent build still
// beats but an ended/idle session stops. Beyond a longer window the lease itself
// is GC'd. Pure: a mtime resolver is injected, so no filesystem is touched here.

import assert from 'node:assert'
import { classifyLeases, SESSION_IDLE_MAX_MS, LEASE_EXPIRE_MS } from '../scripts/lib/leases.mjs'

let pass = 0
const ok = (l) => { pass++; console.log(`  ✓ ${l}`) }

console.log('\nFleet Commander plugin — daemon liveness rule\n')

const now = 1_700_000_000_000
// Transcript mtimes by path (0 = missing).
const mtimeOf = (p) => ({
  '/fresh': now - 1_000,
  '/old': now - (SESSION_IDLE_MAX_MS + 60_000),
}[p] || 0)

{
  const leases = [
    // transcript fresh wins even though the last hook is ancient → live (long build)
    { sessionId: 'a', transcript: '/fresh', at: now - (LEASE_EXPIRE_MS + 1) },
    // transcript stale but a recent hook → live
    { sessionId: 'b', transcript: '/old', at: now - 5_000 },
    // both stale, inside the GC grace window → neither beat nor expired
    { sessionId: 'c', transcript: '/old', at: now - (SESSION_IDLE_MAX_MS + 120_000) },
    // no fresher transcript + an ancient hook, past the GC window → expired (delete it)
    { sessionId: 'd', transcript: '', at: now - (LEASE_EXPIRE_MS + 60_000) },
    // no transcript, recent hook → live (fallback to hook time)
    { sessionId: 'e', transcript: '', at: now - 1_000 },
  ]
  const { live, expired } = classifyLeases(leases, { now, mtimeOf })
  assert.deepStrictEqual([...live].sort(), ['a', 'b', 'e'], 'beats the live sessions (newest sign of life recent)')
  assert.deepStrictEqual(expired, ['d'], 'GCs only the long-dead lease')
  ok('classifyLeases: transcript-or-hook freshness decides live; grace window before GC')
}

{
  assert.deepStrictEqual(classifyLeases([], { now, mtimeOf }), { live: [], expired: [] }, 'no leases → empty')
  assert.deepStrictEqual(classifyLeases([{ transcript: '/fresh' }], { now, mtimeOf }), { live: [], expired: [] }, 'a lease with no sessionId is ignored')
  ok('classifyLeases: empty + malformed inputs are safe')
}

{
  // Exactly at the idle boundary is still alive; one ms past is not.
  const atBoundary = [{ sessionId: 'x', transcript: '', at: now - SESSION_IDLE_MAX_MS }]
  const pastBoundary = [{ sessionId: 'y', transcript: '', at: now - SESSION_IDLE_MAX_MS - 1 }]
  assert.deepStrictEqual(classifyLeases(atBoundary, { now, mtimeOf }).live, ['x'], 'at the boundary → live')
  assert.deepStrictEqual(classifyLeases(pastBoundary, { now, mtimeOf }).live, [], 'just past the boundary → not live')
  ok('classifyLeases: idle boundary is inclusive')
}

console.log(`\n✅ ${pass} checks passed — daemon beats live sessions, GCs the dead\n`)
