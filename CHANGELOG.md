# Changelog

## Work Receipts 0.2.0 (unreleased)

Receipts are now bound to the exact code they cover, can gate pull requests, and export standard attestations. Receipt computation changed, so the recorder version is 0.2.0; 0.1.0 receipts are reported as needing regeneration, never as tampered.

- Code identity: every receipt records the git tree hash of the code its checks ran against (the content `git add -A` would commit, excluding gitignored files and `.receipts`), computed with a throwaway index so the real index and working tree are untouched.
- Checks that change files while running make the receipt Unverified, because the code that passed is no longer the code that remains.
- `verify --tree <commit>` confirms a commit contains exactly the receipted code; `--require-verified` fails on any other verdict.
- Pull-request gate: `cli.js ci --expect-key <fingerprints> --tree <commit>` and a composite GitHub Action (`action.yml`) pass only when a receipt signed by a trusted key is consistent, verified, and covers the head commit's code. Receipts can be committed inside the pull request they describe. Writes a job summary on GitHub.
- Standard attestations: signed receipts also write `receipt.intoto.json`, an in-toto Statement v1 (subject: `gitTree` digest) in a DSSE envelope signed with the receipt key; `verify-attestation` checks it. The signature was verified independently with OpenSSL.
- Authorship: receipts report how many added lines agent file tools wrote versus other sources. The hook keeps keyed line digests (per-session key) in a private sidecar that never enters a receipt; the chained log records only a hash of each digest list. Receipts carry counts only.
- Code identity and authorship appear in the Markdown, HTML, and pull request summaries.
- End to end through the shipped plugin: receipt verified, bound to the tree, 100% authorship attributed, gate passed, and the gate failed after a single edit made once the receipt existed.

Hardening from an adversarial review of this release (4 high, 9 medium, 11 low findings; every high and medium fixed, each with a regression test in `review-2026-11.test.ts`, `ci-gate.test.ts`, or `attribution.test.ts`):

- A forged baseline head could inject `--output` into `git diff`, making an out-of-scope session report as verified and truncating a file. Baselines are now validated, only full commit ids reach git, and options are terminated.
- The gate read receipts from the working directory. It now reads them from the commit's git objects.
- Malformed receipts could crash the gate. Each is now assessed in isolation, canonical JSON refuses nesting deeper than 64 levels, and the total receipt size is capped.
- Wildcard allow-list entries such as `git diff*` pre-approved `git diff --output=<file>`. Starter and proposed allow lists are now exact commands, side-effect options never match an allow-list entry, and `git … --output` is always denied.
- Code identity is refused when the tree hash would not name the bytes the checks read: content-rewriting `.gitattributes`, a project in a repository subfolder, or a dirty submodule. Rename detection no longer hides deletions from out-of-scope folders.
- The gate fails when `.receipts` holds anything other than receipt artifacts. Line digests no longer appear in shareable receipts, and keys are per session. A trailing `--tree` with no value is now an error, unpinned attestations exit 3, contract error text is bounded and sanitised, file tools cannot write into `.git`, and summary text escapes backslashes and control characters.
- Benchmark: 22/22 attacks stopped (three new: `--output` truncation, editing code after the receipt, hiding code under `.receipts`), 0 relying only on a human, and 5/5 benign sessions verified, including a commit that passes the gate.

Found by running on real infrastructure (public CI and a live Claude Code session), each fixed with a regression test:

- On GitHub's Windows runners every action was denied, because the project folder sat under the short name `C:\Users\RUNNER~1`. Alias checks now apply only to the part of a path inside the project.
- On macOS and Windows runners the repository-root check compared paths literally (`/var` is a symlink; `RUNNER~1` is a short name) and refused the code identity. It now compares real paths.
- The throwaway index used for code identity had a fresh timestamp, which disabled git's racy-clean protection: a same-size edit made in the same second as the index was written could be hashed as its old content, so a receipt could name stale code. The copy now keeps the real index's timestamps. A proof branch with the fix disabled failed this test on Ubuntu and macOS CI.
- Running `/receipt` in a new Claude Code session receipted that new, empty session and reported Verified. Receipts and pull request summaries now pick the most recent session with agent work and say which sessions they skipped.
- A `"type": "module"` package.json in any folder above the installed plugin made Node load its CommonJS scripts as ES modules, so every hook crashed, and Claude Code treats a crashed hook as non-blocking: enforcement and recording silently stopped. The plugin now ships its own `package.json` pinning CommonJS. Found by installing from GitHub on a drive with such a file.
- The plugin manifest now declares version 0.2.0 (it still said 0.1.0), so installed copies update.
- Recorder tests yield to the event loop after each test, so long synchronous git work cannot trip vitest's RPC timeout on many-core machines.

Validated on 2026-11-15:

- Public CI green on Ubuntu, Windows, and macOS.
- The pull-request gate on real GitHub pull requests in a public demo repository: a verified change passed, and the same change edited after its receipt failed with "covers tree 62209758, not this commit's 5de5114f".
- Two live Claude Code 2.1.314 sessions with the plugin loaded, given an in-scope task plus two deliberate violations (read `.env`, edit `package.json`). Claude made the change, ran `npm test` without a prompt, and declined both violations because it had been told its scope; a whole-project search that would have read the unignored `.env` was blocked. `/receipt` inside Claude Code produced a Verified receipt bound to the tree, with 3 of 3 added lines attributed to the agent.
- `claude plugin validate` passes with no warnings.

Known and accepted: computing a code identity leaves unreachable blobs in the object store until git's normal garbage collection.

## Work Receipts 0.1.0

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
- Receipts show a step-by-step timeline of every tool call: done, approved, blocked (with reason), failed, or not run, with subagent attribution.
- Adversarial benchmark (npm run bench): 19/19 scope attacks stopped against the shipped plugin, 0 known gaps, 4/4 benign sessions verified with no interruptions; results in docs/BENCHMARK.md.
- Content searches are denied when they would read a protected file that is not gitignored (closes the last benchmark gap without affecting gitignored secrets).
- Shell policy denies commands naming protected files, download-and-execute, string evaluation, and root or home wipes; unrecognised tools carrying a command get the shell policy.
- Pull request summaries: every receipt writes receipt.pr.md, and /receipt-pr prints a paste-ready verdict block.
- Shareable receipt redesigned: dark brand theme, animated verdict stamp, floating mascot, staggered timeline; still script-free and self-contained.
- Project-aware `/receipt-init`: proposes acceptance checks, pre-approved commands, and write scope from the project's own toolchain (npm, pnpm, yarn, bun, Python, Rust, Go, Makefile) instead of an npm default that fails elsewhere. Skips npm's placeholder test script; with no recognised checks it writes a placeholder that fails on purpose, so an unconfigured contract can never verify.
- `/receipt-validate` and `cli.js validate`: invalid contracts now name each failing field (for example `checks[0].id`) without echoing contract values, and placeholder goals or checks are flagged.
- Hook overhead cut 58% (48 ms to 20 ms per call; bundle 476 KB to 44 KB) by moving hook-path validation to zod/mini.

Validated in a live Claude Code session on 2026-10-30: hooks fired, scope context was honoured, and git verification caught out-of-scope files written by a third-party hook.
