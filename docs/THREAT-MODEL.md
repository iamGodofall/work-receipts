# Work Receipts threat model

Version: 1.0
Reviewed: 2026-11-15

## Purpose

Work Receipts is a local evidence and policy-enforcement plugin for Claude Code. It is designed to make a defined class of AI-assisted coding actions more constrained, observable and verifiable.

The security objective is not to prove that an agent is safe or that software is correct. The objective is to record a user-owned work contract, enforce supported tool-call policy, detect scope violations in the Git working tree, and issue evidence bound to the code state covered by the checks.

## Assets

- The session contract, including writable paths, protected paths, command policy and acceptance checks.
- The session event log and its hash chain.
- The local Ed25519 signing key and its public-key fingerprint.
- The baseline captured for a session and the resulting path-state findings.
- The receipt, its evidence bundle and its in-toto DSSE attestation.
- The Git tree identity and the trusted fingerprint used by the pull-request gate.

## Adversary model

The primary adversary is an AI coding agent acting on untrusted or prompt-injected repository content and attempting to exceed the user's written scope, obtain protected information, alter the contract or fabricate a successful receipt.

The product also considers accidental mistakes, shell-based edits, malformed evidence, post-receipt code changes and changes to Git-tracked path metadata.

## Security controls and evidence

| Control | Mechanism | Evidence and limit |
| --- | --- | --- |
| User-owned policy | A project contract defines write scope, protected paths, shell policy and checks. The agent is not permitted to edit the contract through supported hooks. | Hook decisions and contract validation are recorded. This is not an OS-level sandbox. |
| Tool-call enforcement | Claude Code hooks classify supported tool calls and allow, deny or request approval. Unknown or risky actions take a conservative path. | Enforcement applies to tool calls observed by the configured Claude Code hooks. It does not intercept every process or action on the host. |
| Working-tree scope detection | Version 2 path-state fingerprints include regular-file content, executable status, object type and symlink target. | Regression tests cover executable-bit-only changes and symlink retargeting. Git-ignored files and non-Git filesystem metadata are outside the final Git-tree identity. |
| Event integrity | Session events are stored in a hash-linked log. | The chain detects inconsistent edits within the retained log. A local administrator who can replace the entire log and signing material is outside the protection boundary. |
| Receipt authenticity | Receipts are signed with Ed25519. The in-toto Statement is carried in a DSSE envelope. | A verifier checks mathematical signature validity and trusted-key identity. A signature does not prove who controlled the key at signing time or whether the host was compromised. |
| Code identity | A Git tree digest binds the receipt to the code state covered by checks. | The identity follows Git tree semantics. Git-ignored files and the .receipts directory are excluded by design. |
| CI gate | The GitHub Action verifies the receipt, trusted fingerprint and pull-request tree. | The gate depends on a trusted CI runner, protected workflow configuration and correct fingerprint provisioning. |

## Trust assumptions

Work Receipts assumes:

1. The host operating system, Node.js runtime, Git executable and Claude Code hook runner are not compromised.
2. The repository's trusted branch and CI workflow configuration are protected from unreviewed modification.
3. The verifier obtains the expected public-key fingerprint through a trusted channel.
4. Acceptance checks are selected and reviewed by the project owner, and the CI environment runs them as represented in the receipt.
5. The user understands approval prompts and does not approve an action whose purpose or effects are unclear.

A breach of these assumptions can invalidate the security meaning of a receipt.

## Explicit non-goals and limitations

Work Receipts does not currently provide:

- OS-level process isolation, container sandboxing, syscall filtering or network-egress enforcement.
- Hardware-backed or remote key custody. The local key is stored under the user's Work Receipts home directory. Hook-level restrictions are not equivalent to a hardware security boundary.
- Independent proof of the human identity behind an approval prompt.
- External anchoring or remote retention of the local event log. A local administrator able to replace all local state is outside the threat model.
- Assurance for Git-ignored files, untracked data excluded from the receipted tree, file ownership, ACLs, timestamps or every filesystem side effect outside the repository.
- Proof that a test suite is complete, correct, uncompromised or sufficient for the software being changed.
- General protection against malicious dependencies, compromised build hosts, malicious editor extensions, other agents or external applications acting outside observed Claude Code hooks.
- A multi-tenant service, SSO, central policy administration or cross-agent compatibility layer.

The plugin itself makes no network requests. This statement does not prevent an approved shell command, dependency, MCP server, extension or other host process from using the network.

## Safe deployment guidance

- Start from a clean checkout and keep the write scope as narrow as the task permits.
- Prefer exact, read-only pre-approved commands. Keep unknown commands set to approval or denial.
- Review every contract and every approval prompt. Do not approve a request solely because the agent says it is required.
- Keep the signing key and trusted fingerprint under separate administrative control. Do not share private key material.
- Pin the GitHub Action to an immutable commit SHA and protect the workflow and expected-key configuration.
- Review the acceptance commands, their dependencies and the CI runner environment.
- Treat receipts as evidence for the listed session and code tree, not as a certification of the resulting software.

## Test status

The 2026-11-15 internal regression suite contains 24 adversarial scenarios and five benign scenarios. All 24 listed attacks were prevented or caught, and all five benign scenarios verified without interruption. These are finite internal tests. They are not an independent penetration test or certification.

The threat model must be revised when the hook surface, signing model, CI gate, supported agents or evidence format changes materially.
