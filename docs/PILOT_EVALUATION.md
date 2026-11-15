# Work Receipts customer evaluation

Work Receipts is a local-first Claude Code plugin for session scope enforcement, evidence recording, signed receipts, and pull-request verification.

This evaluation is designed to establish whether the product works reliably in one representative customer repository. It is not a security certification, penetration test, or guarantee of complete coverage.

## Scope

One evaluation covers one repository and one agreed workflow. The work is defined with the customer before the evaluation begins.

The evaluation includes:

1. Confirming compatibility with the customer's Claude Code, Node.js, Git, operating system, and repository setup.
2. Installing Work Receipts and reviewing its hook configuration.
3. Defining a customer-authored session contract with explicit file scope, protected paths, shell permissions, and acceptance checks.
4. Running representative in-scope, out-of-scope, blocked, approval-required, and failed-check scenarios.
5. Generating a receipt and verifying its signature, evidence bundle, and code-tree binding.
6. Configuring the GitHub pull-request gate with a customer-controlled trusted signer fingerprint, where the workflow is suitable.
7. Reviewing observed behaviour, friction, false blocks, missing coverage, and known limitations.

## Customer prerequisites

The customer provides:

- A working Claude Code installation.
- Node.js 20 or newer and Git.
- One repository suitable for a controlled evaluation.
- Existing test or acceptance commands that represent the work being evaluated.
- A GitHub repository and permission to configure a pull-request workflow, when CI gate testing is included.
- A person who owns the contract, reviews approval prompts, and controls the signing-key fingerprint trusted by CI.

The first test should use a non-production branch or a disposable repository copy. Do not begin with privileged credentials, production secrets, or destructive workflows.

## Evidence and data handling

The plugin runs locally and makes no network requests. The customer keeps control of the repository, signing key, session logs, and generated receipts.

The customer decides which receipt or diagnostic details to share for evaluation. Review and redact shared material before sending. Do not email source code, credentials, private keys, access tokens, or unredacted environment files.

A receipt signature confirms integrity relative to a trusted public-key fingerprint. A signature does not prove that the acceptance checks were well designed, that their output was truthful, or that the host machine was uncompromised. Git tree comparison excludes gitignored files and the .receipts evidence directory by design. Review the receipt's limitations and [security policy](../SECURITY.md).

## Evaluation outputs

At the end of the agreed evaluation, the customer receives:

- A record of the installed version and tested environment.
- The reviewed session contract and acceptance-check definitions.
- Example receipts for the agreed scenarios.
- The result of signature and Git tree verification.
- The result of the pull-request gate, when included.
- A findings summary covering observed behaviour, usability friction, exceptions, and unresolved limits.
- A recommendation on whether the tested workflow is suitable for broader internal use, requires remediation, or should not proceed.

The evaluation report describes only the repository, versions, workflows, and scenarios tested. It is not a general assurance statement for other repositories or environments.

## Commercial terms

Work Receipts is source-available under the PolyForm Noncommercial License 1.0.0. Commercial use requires a separate commercial licence from Enock Labs.

Evaluation scope, fees, deliverables, access arrangements, and any support commitments are agreed in writing before work begins. No evaluation or licence is implied by submitting an enquiry.

## Request an evaluation

Email **info@socialfeed.co.za** with:

- Your team or organisation name.
- The Claude Code and operating-system versions in use.
- The repository language and build/test toolchain.
- The workflow you want to evaluate.
- Whether pull-request gate validation is required.

Do not attach source code, credentials, private keys, or production secrets.

Security vulnerabilities should be reported using the private reporting route described in [SECURITY.md](../SECURITY.md), not through a general commercial enquiry.
