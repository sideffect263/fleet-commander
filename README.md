# Fleet Commander — Claude Code & Codex plugin

Streams your coding-agent activity to the Fleet Commander cloud so every session
shows up as a live ship on your iPhone and Apple Watch. Installs as a Claude Code
plugin, and the same scripts also wire into **OpenAI Codex CLI** (see below). No
Google Sheet, no API keys, no localhost server.

## What it does

- Wires every Claude Code hook (`SessionStart`, `PreToolUse`, `PostToolUse`,
  `SubagentStart/Stop`, `Stop`, `SessionEnd`, …) to a tiny forwarder.
- The forwarder POSTs a compact event + the latest token usage to your account
  in the cloud. At quiet moments it also sends 5h/week budget stats.
- It **never blocks Claude Code**: unpaired, offline, or slow → it exits in
  milliseconds. Hard cap 2.5s.
- Pure Node builtins. No `npm install` for the user.

## Install

```bash
# add the marketplace, then install
claude plugin marketplace add sideffect263/fleet-commander
claude plugin install fleet-commander
```

## Pair with your phone

1. Open the Fleet Commander app on your iPhone — it shows a code like `FLEET-7Q2K`.
2. In Claude Code, run:

   ```
   /fleet-link FLEET-7Q2K
   ```

3. Done. Your next actions appear as ships. Check anytime with `/fleet-status`.

## Unlinking

Run `/fleet-unlink` to stop this Mac from sending anything to your phone.

You don't have to remember it, though: if you **delete the fleet on your phone**
(or the link is otherwise revoked), the backend starts rejecting this Mac's
events with `401`. The forwarder notices, and after a few consecutive rejections
it forgets the pairing on its own and goes quiet — no orphaned Mac quietly
POSTing into the void. `/fleet-status` will also detect and clean a dead link the
next time you run it.

## Answer from your phone (`fleet-run`)

Remote approvals let your phone answer a *yes/no*. `fleet-run` lets it answer a
*question* — type any text in the iPhone/Watch app and it lands in your live
session as if you'd typed it at the keyboard.

`fleet-run` is a thin PTY wrapper around `claude`: it runs the real Claude Code
TUI unchanged (same keys, colors, everything) and, in the background, polls the
backend for a reply you sent from the app. When one arrives it types it into the
session for you (text + Enter).

```bash
# instead of `claude`, run:
node scripts/fleet-run.mjs            # any normal `claude` args pass through
# e.g.  node scripts/fleet-run.mjs --model opus
```

How it targets the right ship: `fleet-run` generates a session UUID and launches
`claude --session-id <uuid>`, so it knows in advance which ship the phone will
show (`claude:<uuid>`) and polls replies for exactly that session. (If you pass
your own `--session-id`/`--resume`/`-c`, it respects yours and skips reply
injection.)

**node-pty (optional, native).** Phone-reply injection needs a PTY, which comes
from the native [`node-pty`](https://www.npmjs.com/package/node-pty) module. It's
an **optional** dependency — the rest of the plugin stays install-free. If it
isn't present, `fleet-run` prints a one-line hint and just runs `claude` normally
(you lose only the reply injection, never Claude Code itself):

```bash
npm i node-pty     # in this plugin dir, to enable phone replies
```

## Use it with OpenAI Codex CLI

The same forwarder + approve-hook also drive **Codex CLI** — Codex's hook system
shares Claude Code's stdin field names (`session_id`, `cwd`, `hook_event_name`,
`tool_name`, `tool_input`, `transcript_path`) and the identical PreToolUse
allow/deny stdout protocol, so no second copy of the scripts is needed. Sessions
show up tagged `agent: codex` (the app skins them per agent).

```bash
# from this plugin dir — wires Fleet Commander into ~/.codex/hooks.json
node scripts/install-codex.mjs
```

Then pair (same `~/.fleet-commander/config.json` — a Codex-only user needs no
Claude Code):

```bash
node scripts/link.mjs FLEET-XXXXXX     # code shown in the iPhone app
```

That's it — run `codex` and your sessions appear as ships. To remove:

```bash
node scripts/install-codex.mjs --uninstall
```

**Remote approvals (opt-in).** Approvals are gated by the same
`~/.fleet-commander/config.json` `approvals` block as Claude. With it enabled,
Codex's `PreToolUse` for a gated tool (default `Bash`) asks your phone first and
honors Approve/Deny; on timeout or if offline it defers to Codex's normal
in-terminal prompt — it never blocks Codex.

The installer is idempotent and merge-safe: it only owns handlers that run a
Fleet Commander script and leaves any of your other `~/.codex/hooks.json` hooks
untouched.

## Layout

```
plugin/
├── .claude-plugin/
│   ├── plugin.json          manifest
│   └── marketplace.json     single-plugin marketplace (host this repo)
├── hooks/hooks.json         Claude Code: wires all hook events → forwarder.mjs
├── codex/
│   └── hooks.template.json  Codex CLI: rendered into ~/.codex/hooks.json
├── commands/
│   ├── fleet-link.md        /fleet-link FLEET-XXXXXX
│   ├── fleet-unlink.md      /fleet-unlink
│   └── fleet-status.md      /fleet-status
├── scripts/
│   ├── forwarder.mjs        runs on every hook: POST /v1/ingest (+ /v1/stats);
│   │                        auto-unlinks if the backend 401s a dead fleet
│   ├── approve-hook.mjs     opt-in PreToolUse remote approval (Claude + Codex)
│   ├── fleet-run.mjs        PTY wrapper: type a reply in the app → injected here
│   ├── install-codex.mjs    wires the above into Codex (FLEET_AGENT=codex)
│   ├── link.mjs             claims a pairing code, saves the device token
│   ├── unlink.mjs           forgets the pairing (manual; forwarder also self-heals)
│   ├── status.mjs           prints link + backend health, probes /v1/ping
│   └── lib/
│       ├── config.mjs       ~/.fleet-commander/config.json (+ auth-state.json)
│       └── transcript.mjs   token usage + 5h/week cost (ported from internal)
├── package.json            declares node-pty as an OPTIONAL dep (for fleet-run)
└── README.md
```

## Local development

Point the plugin at a local backend instead of production:

```bash
export FLEET_CLOUD_URL=http://127.0.0.1:8787
```

Then the `/fleet-link` flow and the forwarder both talk to your local
`backend/`. See [`../backend/README.md`](../backend/README.md).

## Privacy

The forwarder sends only: event name, session id, working-directory basename,
tool name, a timestamp, and aggregate token counts. It does **not** send prompts,
file contents, tool inputs/outputs, or transcripts. Stats are token/cost totals
only. Everything is scoped to your paired account.

`fleet-run` reads back only the reply text you typed in the app (over your paired
account) and types it into the session — it never sends your terminal output,
transcript, or full working path anywhere.
