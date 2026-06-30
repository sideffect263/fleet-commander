#!/usr/bin/env node
// mcp-ask-human.mjs — a tiny, dependency-free MCP (stdio) server exposing one tool:
//
//   ask_human(question)  — pause the agent and get a free-text answer from the
//                          human, delivered from the Fleet Commander iPhone / Watch.
//
// This is the robust, cross-agent replacement for fleet-run's brittle PTY reply
// injection. Instead of typing into a live terminal, the AGENT calls this tool; we
// park the question on the backend, the phone answers, and we return the answer as
// the tool result so the agent resumes. Works headless, no node-pty, Claude + Codex.
//
// Protocol: JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
// transport). Hand-rolled — NO @modelcontextprotocol/sdk — to keep the plugin's
// "pure Node builtins, no npm install" ethos. STDOUT carries ONLY JSON-RPC frames;
// all diagnostics go to STDERR. Never throws out of the read loop.

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { readConfig } from './lib/config.mjs'
import { readLeases, SESSION_IDLE_MAX_MS } from './lib/leases.mjs'

const SERVER = { name: 'fleet-ask-human', version: '0.8.0' }
const AGENT = process.env.FLEET_AGENT || 'claude'
const POLL_INTERVAL_MS = 1500
const DEFAULT_TIMEOUT_MS = Number(process.env.FLEET_ASK_TIMEOUT_MS) || 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
const MAX_QUESTION_LEN = 4096

const log = (...a) => { try { process.stderr.write(`[fleet-ask-human] ${a.join(' ')}\n`) } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- tiny HTTP helper (builtin fetch + abort) -------------------------------
async function http(method, url, token, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, json }
  } catch { return { status: 0, json: null } } finally { clearTimeout(t) }
}

// Resolve the current session's ship id from the freshest live forwarder lease, so
// the question lands on the SAME ship the user already sees. Fallback: mint an id —
// a ship is then created by the synthetic ingest below, so ask_human still works
// even with no hooks (e.g. an agent that wired the MCP server but not the forwarder).
function resolveSession() {
  let raw = null
  let agent = AGENT
  try {
    let best = null
    for (const L of readLeases()) {
      if (!L || !L.sessionId || !L.at) continue
      if (!best || L.at > best.at) best = L
    }
    if (best && Date.now() - best.at <= SESSION_IDLE_MAX_MS) {
      raw = best.sessionId
      agent = best.agent || AGENT
    }
  } catch { /* no leases — fall through to a minted id */ }
  if (!raw) raw = `ask-${randomUUID()}`
  // Ship ids are always "claude:<raw>" regardless of agent — see projection.shipIdFor.
  return { raw, shipId: `claude:${raw}`, agent }
}

// --- the ask_human tool -----------------------------------------------------
async function askHuman(question) {
  const cfg = readConfig()
  if (!cfg.deviceToken) {
    return { isError: true, text: 'Fleet Commander is not paired on this machine — run /fleet-link (or `fleet setup`) and pair your phone, then ask again.' }
  }
  const q = String(question == null ? '' : question).trim().slice(0, MAX_QUESTION_LEN)
  if (!q) return { isError: true, text: 'ask_human needs a non-empty question.' }

  const { raw, shipId, agent } = resolveSession()
  const base = cfg.baseUrl
  const ask = `${base}/v1/sessions/${encodeURIComponent(shipId)}/ask`

  // Flip the ship to "waiting" (so it enters the phone's Muster + buzzes a push) and
  // ensure a ship exists even with no prior hooks. Best-effort — ignore failures.
  let cwd
  try { cwd = basename(process.cwd()) } catch {}
  await http('POST', `${base}/v1/ingest`, cfg.deviceToken, {
    name: 'Notification', sessionId: raw, agent, cwd, timestamp: new Date().toISOString(),
  })

  // Park the question.
  const posted = await http('POST', ask, cfg.deviceToken, { question: q })
  if (posted.status === 401 || posted.status === 403) {
    return { isError: true, text: 'Fleet Commander rejected this machine (the link was revoked or the fleet was deleted). Re-pair with /fleet-link.' }
  }
  if (posted.status !== 200) {
    return { isError: true, text: `Could not reach Fleet Commander to ask your phone (status ${posted.status || 'offline'}). Answer in the terminal instead.` }
  }
  log(`asked "${q.slice(0, 60)}${q.length > 60 ? '…' : ''}" on ${shipId} — waiting for a phone answer…`)

  // Poll for the human's answer (which the phone queues through the reply channel).
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const r = await http('GET', ask, cfg.deviceToken)
    if (r.status === 200 && r.json && r.json.answer && typeof r.json.answer.text === 'string') {
      log('got an answer from the phone')
      return { text: r.json.answer.text }
    }
    // Transient errors (0 / 5xx) just retry until the deadline.
  }

  // Timed out — clear the parked question so the ship goes calm again.
  await http('DELETE', ask, cfg.deviceToken)
  return { isError: true, text: `No answer from your phone within ${Math.round(DEFAULT_TIMEOUT_MS / 60000)} min. Proceed without it (or ask again / answer in the terminal).` }
}

// --- JSON-RPC 2.0 over stdio ------------------------------------------------
function write(msg) { try { process.stdout.write(JSON.stringify(msg) + '\n') } catch {} }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }) }
function replyErr(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }) }

const TOOLS = [{
  name: 'ask_human',
  description: 'Pause and ask the human operator a free-text question, answered from their phone (Fleet Commander). Use when you are blocked on a decision only the human can make — which approach to take, which environment/value to use, or a judgement call. Blocks until they answer (or it times out) and returns their answer as text.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask. Be specific and self-contained — the human sees only this text on their phone.' },
      context: { type: 'string', description: 'Optional extra context, appended below the question.' },
    },
    required: ['question'],
  },
}]

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      })
    case 'notifications/initialized':
    case 'initialized':
      return // notification — no response
    case 'ping':
      return isRequest ? reply(id, {}) : undefined
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params && params.name
      if (name !== 'ask_human') return replyErr(id, -32602, `unknown tool: ${name}`)
      const args = (params && params.arguments) || {}
      const question = [args.question, args.context].filter(Boolean).join('\n\n')
      let res
      try { res = await askHuman(question) } catch (e) { res = { isError: true, text: `ask_human failed: ${e?.message || e}` } }
      return reply(id, { content: [{ type: 'text', text: res.text }], ...(res.isError ? { isError: true } : {}) })
    }
    default:
      if (isRequest) replyErr(id, -32601, `method not found: ${method}`)
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    Promise.resolve(handle(msg)).catch((e) => log('handler error', e?.message || e))
  }
})
process.stdin.on('end', () => process.exit(0))
log(`ready (agent=${AGENT})`)
