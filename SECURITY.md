# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). Include the affected component, a concrete input that demonstrates the issue, and its impact.

We aim to acknowledge reports within 3 working days and to share a remediation plan within 10 working days.

## Scope

The Work Receipts plugin (`plugin/`, `src/recorder/`) has an explicit threat model: the agent itself, possibly prompt-injected, trying to exceed its scope or obtain a false VERIFIED receipt. In scope:

- Writing outside the contract's write scope, or to protected files, without detection.
- Modifying the receipt log or contract without detection.
- Producing a VERIFIED receipt whose evidence does not support it.
- Secrets reaching the log or the receipt.
- The hook granting a permission the host would not.

The limitations printed on every receipt are known and accepted. Reports that weaken them further are welcome.

## Past reviews

- 2026-10-30: independent internal review of the recorder found 14 issues. The 13 that needed changes were fixed, with regression tests in `src/recorder/__tests__/review-regressions.test.ts`.
