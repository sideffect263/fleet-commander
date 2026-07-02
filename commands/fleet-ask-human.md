---
description: Turn the ask_human tool (agent asks a question answered from your phone) on or off
argument-hint: on | off
allowed-tools: Bash(node:*)
---

The user wants to toggle the Fleet Commander ask_human tool. When ON, the agent
can call `ask_human` to pause and get a free-text answer from the paired phone;
when OFF (the default) the tool is not advertised at all (no per-turn context
cost). Run exactly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ask-human.mjs" $ARGUMENTS
```

Then report the new state in one line. If `$ARGUMENTS` is empty, the script
prints the current state — just relay it. Note that a toggle takes effect on the
next agent turn (the session may need a restart if it lingers).
