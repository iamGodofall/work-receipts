---
description: Run this session's acceptance checks and show its Work Receipt
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" receipt`

Show the receipt above to the user exactly as produced. Do not describe the work as complete or verified unless the heading says VERIFIED. If it says CHECKS FAILED, UNVERIFIED, or LOG INTEGRITY FAILURE, state that plainly and list what failed.
