# Fleet Commander — Claude Code plugin

Streams your Claude Code activity to the Fleet Commander cloud so every session
shows up as a live ship on your iPhone and Apple Watch. No Google Sheet, no API
keys, no localhost server.

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

## Layout

```
plugin/
├── .claude-plugin/
│   ├── plugin.json          manifest
│   └── marketplace.json     single-plugin marketplace (host this repo)
├── hooks/hooks.json         wires all hook events → forwarder.mjs
├── commands/
│   ├── fleet-link.md        /fleet-link FLEET-XXXXXX
│   └── fleet-status.md      /fleet-status
├── scripts/
│   ├── forwarder.mjs        runs on every hook: POST /v1/ingest (+ /v1/stats)
│   ├── link.mjs             claims a pairing code, saves the device token
│   ├── status.mjs           prints link + backend health
│   └── lib/
│       ├── config.mjs       ~/.fleet-commander/config.json
│       └── transcript.mjs   token usage + 5h/week cost (ported from internal)
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
