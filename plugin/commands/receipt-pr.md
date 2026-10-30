---
description: Show a pull-request-ready summary of the latest Work Receipt
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" pr`

Show the summary above exactly as produced, inside a fenced markdown block, so the user can paste it into a pull request description. Suggest attaching receipt.html from the same session folder. Do not alter the verdict or the numbers.
