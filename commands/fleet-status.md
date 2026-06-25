---
description: Show whether this Mac is paired to Fleet Commander and the backend is reachable
allowed-tools: Bash(node:*)
---

Show the Fleet Commander link status by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

Summarize the result for the user in one line (paired or not, backend reachable
or not).
