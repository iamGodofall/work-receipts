---
description: Create a receipts.contract.json proposed from this project's own checks and folders
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" init`

Summarise for the user what was detected: the acceptance checks, the write scope, and any notes. Tell them the contract is only a proposal that they must review and edit themselves (especially the goal), then run /receipt-validate. You cannot edit it: the recorder blocks agent writes to it by design.
