---
description: Turn remote phone-approval of tool actions (e.g. Bash commands) on or off
argument-hint: on | off
allowed-tools: Bash(node:*)
---

The user wants to toggle Fleet Commander remote approvals. When ON, gated tool
actions (default: Bash) pause and wait for Approve/Deny on the paired phone
before running. Run exactly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/approvals.mjs" $ARGUMENTS
```

Then report the new state in one line. If `$ARGUMENTS` is empty, the script
prints the current state — just relay it.
