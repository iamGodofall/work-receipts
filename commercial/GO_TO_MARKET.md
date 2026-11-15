# Work Receipts — Commercial Launch Plan

Status: commercial planning document. This document does not change product behaviour or claim production validation beyond the evidence recorded in the repository.

## Positioning

Work Receipts gives engineering teams an independently checkable record of what an AI coding session was permitted to change, what tools ran, which acceptance checks passed, and whether the final receipt's evidence supports its verdict.

Core buyer problem: engineering managers and security reviewers cannot rely on an agent's self-reported completion summary when reviewing code changes.

## Best initial customers

1. Software development agencies using Claude Code on client repositories.
2. Engineering consultancies delivering work under acceptance criteria.
3. Internal platform and developer-productivity teams evaluating AI coding agents.
4. Security-conscious software teams that need scoped agent sessions and review evidence.

Start with teams already using Claude Code. Do not spend acquisition effort on organisations without an agent-assisted coding workflow.

## First paid offer

### AI coding workflow assurance pilot

A fixed-scope engagement covering:
- Install and configure Work Receipts in one representative repository.
- Define a human-owned session contract and protected paths.
- Configure acceptance checks aligned to the customer's existing test commands.
- Run controlled sessions, including an out-of-scope attempt and a failed-check scenario.
- Deliver example receipts, a configuration guide and a findings report.
- Record limitations and unresolved compatibility issues.

Proposed pilot price for validation: US$250–750 or R4,500–R13,500. Quote after confirming repository count, environment and support burden. This is a test price, not a published rate.

Follow-on revenue:
- Multi-repository rollout and policy configuration.
- Team onboarding and internal training.
- CI/review workflow integration.
- Quarterly configuration review and support.

## Evidence to use

Updated 2026-11-15 for release 0.2.0:

- Adversarial benchmark: 22/22 scripted attacks stopped, 0 relying only on a human approval, 5/5 legitimate sessions verified (docs/BENCHMARK.md).
- Receipts are bound to the exact code by git tree hash, and the pull-request gate is proven on real GitHub pull requests: https://github.com/iamGodofall/work-receipts-demo/pulls?q=is%3Apr (one passes; one, edited after its receipt, is blocked).
- Standard in-toto/DSSE attestations, independently verified with OpenSSL.
- An independent adversarial security review: 4 high and 9 medium findings, all fixed with regression tests.
- Live validation in Claude Code 2.1.314 sessions (Windows) with an in-scope task plus deliberate violations; install, enforcement and uninstall verified on Linux with Claude Code 2.1.325. CI green on Ubuntu, Windows and macOS.
- Shareable HTML, Markdown and JSON receipts; independent verification command; security policy and documented limitations.

Still true: no live customer environment yet. Say "validated in our own live Claude Code sessions and public CI", not "used by customers".

## Qualification questions

- Which coding agent and version does the team use?
- How many developers and repositories are in scope?
- Which file paths must never be modified?
- Which acceptance commands already exist?
- Is the desired outcome developer-level control, reviewer evidence, or a repeatable client-delivery process?
- Which operating systems and shell environments must be supported?

## Sales message

Subject: Evidence for AI-assisted code changes

Your team can see what an AI coding agent says it changed. The harder question is whether the agent stayed inside the agreed scope and whether the acceptance checks support the result.

Work Receipts adds a human-written session contract, tool-call scope enforcement, a tamper-evident activity record and a receipt whose verdict is based on recorded checks and Git evidence.

We are offering a small, fixed-scope evaluation for teams already using Claude Code. The pilot configures one repository, tests both permitted and blocked work, and returns a practical findings report with example receipts.

Would a one-repository evaluation be relevant to your engineering workflow?

## Sales rules

- Do not promise prevention of every attack or complete security.
- Do not describe a tamper-evident record as tamper-proof.
- Do not claim compatibility with coding agents other than those explicitly supported and tested.
- Do not claim independent customer adoption without verifiable customer evidence.
- Keep customer source code and receipts private unless written permission permits publication.
- Do not modify customer repositories without an agreed scope and approval.

## 14-day validation target

- Build a list of 30 qualified teams with visible Claude Code usage.
- Send 10 highly tailored messages per working day.
- Seek 5 discovery replies, 3 technical evaluations and 1 paid pilot.
- Track each contact, date, problem, response, next action and outcome.
- If prospects consistently reject the pilot, revise the offer based on recorded objections rather than adding features by default.

## Release gate before public promotion

Status on 2026-11-15 (release 0.2.0):

- [x] Run the plugin end-to-end inside a real Claude Code session (two sessions; `/receipt` inside Claude Code produced a verified receipt).
- [x] Verify install and uninstall on supported Windows and Linux environments (from GitHub, isolated configs).
- [x] Re-run the adversarial benchmark and preserve raw output (docs/BENCHMARK.md).
- [x] Confirm package and marketplace metadata (`claude plugin validate` passes with no warnings), licence, and security disclosure process (SECURITY.md).
- [ ] Support route: publish a contact address for licences and pilots in the README.
- [x] Review every public claim against current repository evidence (this document updated accordingly).
