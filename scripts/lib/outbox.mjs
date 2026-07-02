// outbox.mjs — the plugin's durable, fire-and-forget delivery queue.
//
// WHY: the forwarder used to `await` the /v1/ingest POST inline on every hook,
// so a slow/hung backend blocked the agent for the full fetch timeout on EVERY
// tool boundary (~1.3s worst case, twice per Bash call). This module moves the
// network off the hook hot path: the forwarder APPENDS one JSON line here and
// returns instantly; the already-running fleet-daemon drains the queue to the
// backend on its beat. The daemon already runs, so this adds no new process.
//
// GUARANTEES:
//   • at-least-once + ordering: append-only NDJSON is FIFO; drain reads
//     top-to-bottom and only removes lines it successfully delivered (or which
//     are permanently un-sendable), leaving the unsent remainder IN ORDER.
//   • idempotency: each event carries a stable eventId; drain dedupes within a
//     batch (server-side dedupe is optional — parseIngestEvent ignores unknown
//     fields, so eventId is forward-safe).
//   • bounded: on overflow (OUTBOX_MAX_EVENTS or OUTBOX_MAX_BYTES) we drop the
//     OLDEST events — live state is last-writer-wins per sessionId, so stale
//     oldest events are lossless for what the map shows.
//   • poison-safe: a permanent 4xx (400 bad_event / 413 too large) is DROPPED,
//     never retried, so one un-sendable line can't wedge the whole queue.
//
// Split into RULE (pure: makeEventId/dedupe/trimToCaps) and IO (enqueue/drain/
// outboxSize) so the rules unit-test without a filesystem, like leases.mjs.

import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { CONFIG_DIR, OUTBOX_PATH } from './config.mjs'

export const OUTBOX_MAX_EVENTS = 2000
export const OUTBOX_MAX_BYTES = 1024 * 1024 // 1 MiB
// Permanent 4xx — the backend will never accept this body (malformed / oversized).
// Drop it and keep draining rather than retrying it forever.
const DROP_STATUSES = new Set([400, 413])

let SEQ = 0
// Stable per-event id: `${sessionId}:${time+seq}:${rand}`. The monotonic per-process
// seq disambiguates events stamped in the same millisecond; 6 hex guard cross-process.
export function makeEventId(sessionId) {
  return `${sessionId || 's'}:${Date.now().toString(36)}${(SEQ++).toString(36)}:${randomBytes(3).toString('hex')}`
}

// RULE (pure) — dedupe by eventId, keeping the FIRST occurrence, preserving order.
// Lines with no parseable eventId are kept as-is (tolerate legacy / id-less lines).
export function dedupe(lines) {
  const seen = new Set()
  const out = []
  for (const l of lines) {
    let ev
    try { ev = JSON.parse(l) } catch { continue } // drop garbage lines
    if (!ev || !ev.eventId) { out.push(l); continue }
    if (seen.has(ev.eventId)) continue
    seen.add(ev.eventId)
    out.push(l)
  }
  return out
}

// RULE (pure) — drop the OLDEST lines to fit the caps. Returns the tail to keep.
export function trimToCaps(lines) {
  let kept = lines.length > OUTBOX_MAX_EVENTS ? lines.slice(-OUTBOX_MAX_EVENTS) : lines
  let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) // +1 for the newline
  while (kept.length > 1 && bytes > OUTBOX_MAX_BYTES) {
    bytes -= Buffer.byteLength(kept[0]) + 1
    kept = kept.slice(1) // drop oldest
  }
  return kept
}

// --- IO ---------------------------------------------------------------------

function readLines() {
  try { return readFileSync(OUTBOX_PATH, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

// Atomic full rewrite: write a tmp then rename over the outbox, so a crash mid-write
// never leaves a torn file. Empty list → truncate to an empty file.
function atomicWrite(lines) {
  const tmp = `${OUTBOX_PATH}.tmp.${process.pid}`
  writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '')
  renameSync(tmp, OUTBOX_PATH)
}

/** How many events are queued for delivery (best-effort; 0 on any error). */
export function outboxSize() {
  try { return readLines().length } catch { return 0 }
}

/**
 * Append one event to the outbox (stamping an eventId if absent), then enforce
 * the caps. Best-effort: NEVER throws — enqueue must not block or crash the agent.
 * O_APPEND makes small whole-line writes atomic, so concurrent hooks interleave
 * whole lines and never tear one.
 */
export function enqueueEvent(event) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const ev = event && event.eventId ? event : { ...event, eventId: makeEventId(event && event.sessionId) }
    appendFileSync(OUTBOX_PATH, JSON.stringify(ev) + '\n')
    let over = false
    try { over = statSync(OUTBOX_PATH).size > OUTBOX_MAX_BYTES } catch {}
    const lines = readLines()
    if (over || lines.length > OUTBOX_MAX_EVENTS) atomicWrite(trimToCaps(lines))
  } catch { /* enqueue is best-effort — never block the agent */ }
}

/**
 * Drain the outbox oldest-first via the injected `post(event) -> httpStatus`.
 * (Status 0 = never completed: offline / timeout.) Delivered (2xx) and poison
 * (400/413) lines are removed; on the first transient failure or auth rejection
 * we STOP and persist the unsent remainder IN ORDER, so at-least-once + ordering
 * hold across drains. Returns { drained, lastStatus, remaining } — the daemon
 * feeds lastStatus into the 3-strike auth reaction.
 */
export async function drain(post) {
  const lines = dedupe(readLines())
  if (!lines.length) return { drained: 0, lastStatus: 200, remaining: 0 }
  let i = 0
  let lastStatus = 0
  for (; i < lines.length; i++) {
    let ev
    try { ev = JSON.parse(lines[i]) } catch { continue } // skip garbage — treat as drained
    lastStatus = await post(ev)
    if (lastStatus >= 200 && lastStatus < 300) continue // delivered
    if (DROP_STATUSES.has(lastStatus)) continue // poison → drop, keep draining the rest
    if (lastStatus === 401 || lastStatus === 403) { i++; break } // auth-dead: drop this one, stop, unlink upstream
    break // 0 / 5xx / other → stop, retry the remainder next beat
  }
  const remainder = lines.slice(i)
  atomicWrite(remainder)
  return { drained: i, lastStatus, remaining: remainder.length }
}
