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

- The repository's documented adversarial benchmark: 19/19 scripted scope attacks stopped and 4/4 legitimate sessions verified in the recorded benchmark.
- Shareable HTML, Markdown and JSON receipt outputs.
- Independent receipt verification command.
- Security policy and documented limitations.

Do not claim the plugin has been validated in a live customer environment. The main project README records that a live Claude Code session test had not yet been completed at the time of that status statement. Before making a live-deployment claim, run and record a fresh end-to-end test on the supported host versions.

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

- Run the plugin end-to-end inside a real Claude Code session.
- Verify install and uninstall on supported Windows and Linux environments.
- Re-run the adversarial benchmark and preserve raw output.
- Confirm package and marketplace metadata, licence, support route and security disclosure process.
- Review every public claim against current repository evidence.
