---
description: Unlink this Mac from Fleet Commander so it stops sending sessions to your phone
allowed-tools: Bash(node:*)
---

The user wants to stop this machine from sending Claude Code sessions to their
Fleet Commander phone. Unlink it by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/unlink.mjs"
```

Then confirm in one line whether it was unlinked (or was already not paired).
