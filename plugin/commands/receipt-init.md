---
description: Create a starter receipts.contract.json for this project
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" init`

Tell the user that the contract file must be edited by them (goal, write scope, shell allow list, acceptance checks). You cannot edit it: the recorder blocks agent writes to it by design.
