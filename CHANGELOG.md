# Changelog

## Work Receipts 0.1.0 (unreleased)

First release candidate of the Claude Code plugin.

- Session contract: write scope, protected files, shell allow list, web and MCP settings, acceptance checks.
- PreToolUse enforcement that only ever denies or asks. Path aliases, junctions and symlinks are resolved or denied.
- Hash-linked event log covering every tool call, including subagent calls, with redacted command previews.
- Git baseline at session start. Receipts fail as OUT OF SCOPE when any out-of-scope file changes by any means.
- `/receipt` produces HTML, Markdown and JSON receipts. The HTML embeds a verifiable evidence bundle.
- `verify` recomputes a receipt from its bundle and detects edits.
- Ed25519 receipt signing with a per-user key kept outside every project and blocked from the agent; `verify --expect-key` and a `key` command.
- SessionStart context tells the model its scope.
- Known limitations are printed on every receipt.
- Contract `ignore` list for changes by trusted tools; ignored changes are listed but cannot fail scope.
- Receipts record their recorder version; receipts from another version are reported as needing regeneration, never as tampered.
- Local Work Receipts viewer in the web app (/receipts) that re-verifies every receipt on load.
- Starter contract pre-approves read-only commands (ls, pwd, git status/diff/log).

Validated in a live Claude Code session on 2026-10-30: hooks fired, scope context was honoured, and git verification caught out-of-scope files written by a third-party hook.
