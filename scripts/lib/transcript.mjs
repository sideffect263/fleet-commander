// transcript.mjs — read token usage + cost from Claude Code transcripts.
//
// Ported almost verbatim from ../../../sources/claude.mjs so the cloud numbers
// match the internal Google-Sheet version exactly. Two jobs:
//   • latestAssistantUsage() — the last message's usage (drives context %).
//   • computeStats()         — incremental 5h/week token+cost rollup (the
//                              /v1/stats payload), using a byte-offset cache so
//                              repeat scans are cheap.

import {
  createReadStream, readFileSync, writeFileSync, renameSync, statSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const BUCKET_RETENTION_DAYS = 30

const WEEKLY_BUDGET_USD = 2000
const FIVE_HOUR_BUDGET_USD = 500

const PRICING = {
  opus: { in: 15, out: 75, cwrite: 18.75, cread: 1.5 },
  sonnet: { in: 3, out: 15, cwrite: 3.75, cread: 0.3 },
  haiku: { in: 1, out: 5, cwrite: 1.25, cread: 0.1 },
}

function priceFor(model) {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return PRICING.opus
  if (m.includes('haiku')) return PRICING.haiku
  return PRICING.sonnet
}

function costFor(u, model) {
  const p = priceFor(model)
  return (
    (u.input_tokens || 0) * p.in +
    (u.output_tokens || 0) * p.out +
    (u.cache_creation_input_tokens || 0) * p.cwrite +
    (u.cache_read_input_tokens || 0) * p.cread
  ) / 1_000_000
}

function tokensIn(u) {
  return (
    (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
  )
}

// --- latest message usage (for context %) -----------------------------------

export async function latestAssistantUsage(transcriptPath) {
  if (!transcriptPath) return null
  let size = 0
  try { size = statSync(transcriptPath).size } catch { return null }
  const start = Math.max(0, size - 256 * 1024)
  const rl = createInterface({ input: createReadStream(transcriptPath, { start, encoding: 'utf8' }) })
  let last = null
  for await (const line of rl) {
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m.type === 'assistant' && m.message?.usage) last = m
    } catch { /* partial trailing line */ }
  }
  if (!last) return null
  const u = last.message.usage || {}
  return {
    model: last.message.model || '',
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  }
}

// --- incremental 5h/week stats ----------------------------------------------

function hourBucketKey(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (isNaN(x)) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}-${p(x.getHours())}`
}

function bucketKeyToMs(k) {
  const [y, mo, da, hr] = k.split('-').map(Number)
  return new Date(y, mo - 1, da, hr).getTime()
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj))
  renameSync(tmp, path)
}

async function scanSince(path, startOffset, buckets) {
  let st
  try { st = statSync(path) } catch { return startOffset }
  if (st.size <= startOffset) return startOffset
  const rl = createInterface({ input: createReadStream(path, { start: startOffset, encoding: 'utf8' }) })
  let cursor = startOffset
  let sawLine = false
  for await (const line of rl) {
    cursor += Buffer.byteLength(line, 'utf8') + 1
    sawLine = true
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m.type !== 'assistant') continue
      const u = m.message?.usage
      if (!u) continue
      const key = hourBucketKey(m.timestamp)
      if (!key) continue
      const b = buckets[key] || (buckets[key] = { tokens: 0, cost: 0 })
      b.tokens += tokensIn(u)
      b.cost += costFor(u, m.message?.model)
    } catch { /* skip malformed */ }
  }
  return sawLine ? Math.min(cursor, st.size) : startOffset
}

async function updateBuckets(cachePath) {
  const prior = readJson(cachePath) || {}
  const files = prior.files || {}
  const buckets = prior.buckets || {}
  let projects = []
  try { projects = readdirSync(PROJECTS_DIR) } catch { return { files, buckets } }

  for (const proj of projects) {
    let entries = []
    try { entries = readdirSync(join(PROJECTS_DIR, proj)) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(PROJECTS_DIR, proj, f)
      let st
      try { st = statSync(path) } catch { continue }
      const mtime = st.mtime.getTime()
      const prev = files[path]
      if (prev && prev.mtime === mtime && prev.offset === st.size) continue
      const startOffset = prev && st.size >= prev.offset ? prev.offset : 0
      files[path] = { mtime, offset: await scanSince(path, startOffset, buckets) }
    }
  }

  const cutoff = Date.now() - BUCKET_RETENTION_DAYS * 864e5
  for (const key of Object.keys(buckets)) {
    if (bucketKeyToMs(key) < cutoff) delete buckets[key]
  }
  try { writeJsonAtomic(cachePath, { fetchedAt: Date.now(), files, buckets }) } catch {}
  return { files, buckets }
}

function statsFromBuckets(buckets, weekStart) {
  const now = Date.now()
  const fiveHoursAgo = now - 5 * 3600 * 1000
  const wkStart = weekStart ?? (now - 168 * 3600 * 1000)
  let fhT = 0, fhC = 0, wkT = 0, wkC = 0
  for (const [key, b] of Object.entries(buckets)) {
    const mid = bucketKeyToMs(key) + 30 * 60 * 1000
    if (mid < wkStart) continue
    wkT += b.tokens; wkC += b.cost
    if (mid >= fiveHoursAgo) { fhT += b.tokens; fhC += b.cost }
  }
  return {
    kind: 'stats',
    providers: {
      claude: {
        fiveH: { tokens: Math.round(fhT), cost: Math.round(fhC * 100) / 100, percent: Math.round((fhC / FIVE_HOUR_BUDGET_USD) * 100) },
        week: { tokens: Math.round(wkT), cost: Math.round(wkC * 100) / 100, percent: Math.round((wkC / WEEKLY_BUDGET_USD) * 100) },
        fiveHourBudget: FIVE_HOUR_BUDGET_USD,
        weeklyBudget: WEEKLY_BUDGET_USD,
      },
    },
  }
}

/** Compute the /v1/stats payload, caching byte offsets at `cachePath`. */
export async function computeStats(cachePath, { weekStart } = {}) {
  const { buckets } = await updateBuckets(cachePath)
  return statsFromBuckets(buckets, weekStart)
}
