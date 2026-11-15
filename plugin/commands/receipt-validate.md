---
description: Check that receipts.contract.json is valid and say exactly what to fix
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" validate`

Relay the result to the user verbatim. If it is invalid or has warnings, tell them which field to change. Do not offer to edit the contract: the recorder blocks agent writes to it by design.
