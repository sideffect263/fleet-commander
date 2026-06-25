---
description: Pair this Mac with your Fleet Commander iPhone app using the code shown in the app
argument-hint: FLEET-XXXXXX
allowed-tools: Bash(node:*)
---

The user wants to link this machine to their Fleet Commander phone so their
Claude Code sessions show up as ships. The pairing code is in `$ARGUMENTS`.

Run exactly this, substituting the code:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/link.mjs" $ARGUMENTS
```

Then report whether pairing succeeded in one line. If `$ARGUMENTS` is empty, do
NOT run anything — instead tell the user to open the Fleet Commander iPhone app,
read the `FLEET-XXXXXX` code on screen, and run `/fleet-link FLEET-XXXXXX`.
