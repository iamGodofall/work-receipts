import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gate, renderGateSummary } from "./ci";
import { join } from "node:path";
import { sha256Hex } from "../core/integrity";
import { CONTRACT_FILE, loadContract, STARTER_CONTRACT, type SessionCheck } from "./contract";
import { createBundle, matchTree, verifyBundle, type BundleVerification, type ReceiptBundle } from "./bundle";
import { fingerprintOf, keyDir, loadOrCreateKey, signDigest } from "./signing";
import { buildStatement, signStatement, verifyAttestation, type AttestationCheck, type DsseEnvelope } from "./attestation";
import { addedLines, changedSince, codeTree, currentHead, readCommittedFile, receiptsEntries, treeOfRevision, type CodeIdentity, type GitBaseline, type GitChanges } from "./git";
import { agentDigests, ATTRIBUTION_SIDECAR, attribute, loadOrCreateAttributionKey, sessionAttributionKey, type Attribution } from "./attribution";
import { contractFromProposal, fileSystemReader, PLACEHOLDER_CHECK, proposeContract, type ProjectProposal } from "./detect";
import { extractBundle, renderReceiptHtml } from "./html";
import { renderPrSummary } from "./pr";
import { baselineFromEvents, buildSessionReceipt, renderReceiptMarkdown, type CheckResult, type ContractInfo } from "./receipt";
import { latestSessionId, readEvents, redactPreview, safeSessionId, sessionDir } from "./store";

export function runCheck(projectDir: string, check: SessionCheck): CheckResult {
  const started = Date.now();
  const result = spawnSync(check.command, {
    cwd: projectDir,
    shell: true,
    encoding: "utf8",
    timeout: check.timeoutSeconds * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const timedOut = result.error !== undefined && /ETIMEDOUT/.test(String(result.error));
  const tail = output.split(/\r?\n/).filter((line) => line.trim()).slice(-15).join("\n");
  return {
    id: check.id,
    description: check.description,
    command: check.command,
    status: timedOut ? "timed_out" : result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    outputDigest: sha256Hex(output),
    outputTail: redactPreview(tail, 2000),
    checkedAt: new Date().toISOString(),
  };
}

/** What `init` found and wrote, so the human knows exactly what to review. */
export function renderProposal(proposal: ProjectProposal): string {
  const lines = [
    "Created " + CONTRACT_FILE + " from your project files.",
    "Detected: " + (proposal.detected.length ? proposal.detected.join(", ") : "no known toolchain"),
    "Acceptance checks:",
    ...proposal.checks.map((check) => "  - " + check.id + ": " + check.command),
    "Write scope: " + proposal.write.join(", "),
    "Pre-approved commands: " + proposal.shellAllow.join(", "),
    ...proposal.notes.map((note) => "Note: " + note),
    "Next: set the goal and review the scope yourself. The agent cannot edit this file.",
    "Run `validate` after editing to confirm the contract is valid.",
  ];
  return lines.join("\n") + "\n";
}

/** "OK ..." for a usable contract; otherwise the exact problem to fix. */
export function describeValidation(projectDir: string): string {
  const loaded = loadContract(projectDir);
  if (loaded.status === "absent") return "No " + CONTRACT_FILE + " found. Run init to create one.\n";
  if (loaded.status === "invalid") return "INVALID: " + loaded.message + "\nUntil it is fixed, the agent may only read files.\n";
  const c = loaded.contract;
  const warnings: string[] = [];
  if (c.goal === STARTER_CONTRACT.goal) warnings.push("The goal is still the placeholder text.");
  if (c.checks.some((check) => check.command === PLACEHOLDER_CHECK.command && check.id === PLACEHOLDER_CHECK.id)) {
    warnings.push("The placeholder check is still present, so every receipt will report failed checks.");
  }
  return "OK: " + c.checks.length + " check(s), write scope " + c.write.join(", ") + ".\n" +
    warnings.map((warning) => "Warning: " + warning + "\n").join("");
}

function measureAttribution(projectDir: string, sessionId: string, baseline: GitBaseline | null, changes: GitChanges, events: unknown[]): Attribution {
  if (!changes.available) return { available: false, reason: changes.reason };
  if (!baseline || !baseline.git) return { available: false, reason: "No git baseline was recorded." };
  let key: Buffer;
  try {
    key = sessionAttributionKey(loadOrCreateAttributionKey(), safeSessionId(sessionId));
  } catch {
    return { available: false, reason: "The attribution key could not be read." };
  }
  let sidecar = "";
  try {
    const file = join(sessionDir(projectDir, sessionId), ATTRIBUTION_SIDECAR);
    if (existsSync(file)) sidecar = readFileSync(file, "utf8");
  } catch {
    return { available: false, reason: "The private authorship record could not be read." };
  }
  return attribute(addedLines(projectDir, baseline.head, changes.changed), agentDigests(sidecar, events), key);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const MAX_ATTESTATION_BYTES = 1024 * 1024;
const VALUE_FLAGS = ["--tree", "--expect-key", "--session", "--key"];

/** Flags that take a value but were given none, e.g. a trailing `--tree`. */
export function missingFlagValues(argv: readonly string[]): string[] {
  return VALUE_FLAGS.filter((flag) => {
    const index = argv.indexOf(flag);
    if (index < 0) return false;
    const value = argv[index + 1];
    return value === undefined || value.startsWith("--") || value.trim() === "";
  });
}

/** One line of terminal-safe text: no escape sequences or carriage returns from receipt content. */
function clean(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 2000);
}

export function main(argv: string[]): void {
  const command = argv[2];
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const missing = missingFlagValues(argv);
  if (missing.length) {
    // A silently skipped `--tree` would let someone believe a receipt was bound to code when it was not.
    process.stdout.write("Missing value for " + missing.join(", ") + ".\n");
    process.exitCode = 1;
    return;
  }

  if (command === "init") {
    const path = join(projectDir, CONTRACT_FILE);
    if (existsSync(path)) {
      process.stdout.write(CONTRACT_FILE + " already exists; leaving it unchanged.\n" + describeValidation(projectDir));
      return;
    }
    const proposal = proposeContract(fileSystemReader(projectDir));
    writeFileSync(path, JSON.stringify(contractFromProposal(proposal), null, 2) + "\n", "utf8");
    process.stdout.write(renderProposal(proposal));
    return;
  }

  if (command === "validate") {
    const report = describeValidation(projectDir);
    process.stdout.write(report);
    if (!report.startsWith("OK")) process.exitCode = 1;
    return;
  }

  if (command === "receipt") {
    const requested = option(argv, "--session");
    const sessionId = requested ? safeSessionId(requested) : latestSessionId(projectDir);
    if (!sessionId) {
      process.stdout.write("No recorded sessions found under .receipts/sessions.\n");
      process.exitCode = 1;
      return;
    }

    const loaded = loadContract(projectDir);
    const contract: ContractInfo = loaded.status === "loaded"
      ? { status: "loaded", contract: loaded.contract }
      : loaded.status === "invalid"
        ? { status: "invalid", message: loaded.message }
        : { status: "absent" };

    // Name the code before the checks run, then again after, to catch checks that rewrite files.
    const before = codeTree(projectDir);
    const checks = contract.status === "loaded" && !argv.includes("--no-checks")
      ? contract.contract.checks.map((check) => runCheck(projectDir, check))
      : [];
    const after = checks.length > 0 && "tree" in before ? codeTree(projectDir) : before;
    const code: CodeIdentity = "tree" in before && "tree" in after
      ? { available: true, tree: before.tree, treeAfterChecks: after.tree, head: currentHead(projectDir) }
      : { available: false, reason: "reason" in before ? before.reason : "After the checks ran: " + ("reason" in after ? after.reason : "unknown") };

    const dir = sessionDir(projectDir, sessionId);
    if (!existsSync(join(dir, "events.jsonl"))) {
      process.stdout.write("No recorded events for session " + sessionId + ".\n");
      process.exitCode = 1;
      return;
    }
    const events = readEvents(dir);
    const baseline = baselineFromEvents(events);
    const gitChanges = changedSince(projectDir, baseline);
    const receipt = buildSessionReceipt({
      sessionId,
      events,
      contract,
      checks,
      gitChanges,
      code,
      attribution: measureAttribution(projectDir, sessionId, baseline, gitChanges, events),
      hashFile: (path) => {
        const absolute = join(projectDir, path);
        return existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : null;
      },
    });

    const markdown = renderReceiptMarkdown(receipt);
    const bundle = createBundle(receipt, events);
    let attestation: DsseEnvelope | null = null;
    if (!argv.includes("--no-sign")) {
      try {
        const keys = loadOrCreateKey();
        bundle.signature = signDigest(bundle.bundleDigest, keys);
        if (receipt.code.available) attestation = signStatement(buildStatement(bundle, keys.publicKeyPem), keys);
      } catch (error) {
        process.stderr.write("Receipt left unsigned: " + (error instanceof Error ? error.message : "signing failed") + "\n");
      }
    }
    if (attestation) writeFileSync(join(dir, "receipt.intoto.json"), JSON.stringify(attestation, null, 2) + "\n", "utf8");
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8");
    writeFileSync(join(dir, "receipt.md"), markdown, "utf8");
    writeFileSync(join(dir, "receipt.html"), renderReceiptHtml(bundle), "utf8");
    writeFileSync(join(dir, "receipt.pr.md"), renderPrSummary(bundle), "utf8");
    const where = join(".receipts", "sessions", sessionId);
    process.stdout.write(markdown + "\nSaved " + join(where, "receipt.html") + " (shareable, embeds the verifiable evidence bundle), receipt.md, and receipt.json" +
      (attestation ? ", plus receipt.intoto.json (signed in-toto attestation for the exact code)" : "") + ".\n");
    // Exit non-zero only when asked, so the receipt still displays inside Claude Code.
    if (argv.includes("--strict") && receipt.verdict !== "verified") process.exitCode = 2;
    return;
  }

  if (command === "verify") {
    const file = argv[3];
    if (!file || !existsSync(file)) {
      process.stdout.write("Usage: cli.js verify <receipt.html | receipt.json>\n");
      process.exitCode = 1;
      return;
    }
    let result: BundleVerification;
    let bundle: ReceiptBundle | null = null;
    try {
      bundle = extractBundle(readFileSync(file, "utf8")) as ReceiptBundle;
      result = verifyBundle(bundle);
    } catch {
      result = { consistent: false, verdict: null, problems: ["File does not contain a readable receipt bundle."], signature: { status: "unsigned" } };
    }
    const expected = option(argv, "--expect-key");
    if (expected && !(result.signature.status === "valid" && result.signature.fingerprint === expected)) {
      result.problems.push("Not signed by the expected key " + expected + ".");
      result.consistent = false;
    }
    const revision = option(argv, "--tree");
    let treeLine = "";
    if (revision !== undefined) {
      const match = bundle?.receipt ? matchTree(bundle.receipt, treeOfRevision(projectDir, revision)) : { status: "unknown" as const, reason: "No receipt to compare." };
      if (match.status === "match") {
        treeLine = "CODE MATCH: " + revision + " contains exactly the code the checks ran against (tree " + match.tree + ").\n";
      } else {
        result.problems.push(match.status === "mismatch"
          ? "Code mismatch: " + revision + " has tree " + match.actualTree + ", but the receipt covers tree " + match.receiptTree + "."
          : "Code not confirmed: " + match.reason);
        result.consistent = false;
      }
    }
    const requireVerified = argv.includes("--require-verified");
    if (requireVerified && result.consistent && result.verdict !== "verified") {
      result.problems.push("Verdict is " + result.verdict + ", and --require-verified needs verified.");
      result.consistent = false;
    }
    if (result.consistent) {
      const signer = result.signature.status === "valid"
        ? "Signed by key " + result.signature.fingerprint + ". Compare this fingerprint with the one the author published."
        : "Unsigned: nothing shows who generated it.";
      process.stdout.write(
        "CONSISTENT: the verdict (" + result.verdict + ") follows from the bundled evidence and nothing was edited after generation.\n" +
        treeLine +
        signer + "\nThe signature shows which key produced the receipt, not that the recorded check results were truthful.\n",
      );
    } else {
      process.stdout.write("INCONSISTENT:\n" + result.problems.map((problem) => "- " + clean(problem)).join("\n") + "\n");
      process.exitCode = 2;
    }
    return;
  }

  if (command === "ci") {
    const revision = option(argv, "--tree") ?? "HEAD";
    const trustedKeys = (option(argv, "--expect-key") ?? "").split(/[\s,]+/).filter(Boolean);
    const result = gate({
      revision,
      tree: treeOfRevision(projectDir, revision),
      receiptsEntries: receiptsEntries(projectDir, revision),
      readCommitted: (path) => readCommittedFile(projectDir, revision, path),
      trustedKeys,
      requireVerified: !argv.includes("--allow-unverified"),
    });
    const summary = renderGateSummary(result);
    process.stdout.write(summary);
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      try {
        appendFileSync(summaryFile, summary + "\n", "utf8");
      } catch {
        // The console output above carries the same result.
      }
    }
    if (!result.passed) process.exitCode = 2;
    return;
  }

  if (command === "verify-attestation") {
    const file = argv[3];
    if (!file || !existsSync(file)) {
      process.stdout.write("Usage: cli.js verify-attestation <receipt.intoto.json> [--key <public.pem>] [--expect-key <fingerprint>] [--tree <commit>] [--require-verified]\n");
      process.exitCode = 1;
      return;
    }
    const keyFile = option(argv, "--key");
    const problems: string[] = [];
    let check: AttestationCheck;
    try {
      if (statSync(file).size > MAX_ATTESTATION_BYTES) throw new Error("too large");
      check = verifyAttestation(JSON.parse(readFileSync(file, "utf8")), {
        trustedPublicKeyPem: keyFile ? readFileSync(keyFile, "utf8") : undefined,
        expectFingerprint: option(argv, "--expect-key"),
      });
    } catch {
      check = { valid: false, problem: "The attestation is unreadable, not JSON, or larger than 1 MB, or the key file is unreadable." };
    }
    if (!check.valid) {
      process.stdout.write("INVALID: " + check.problem + "\n");
      process.exitCode = 2;
      return;
    }
    const predicate = check.statement.predicate;
    const tree = check.statement.subject[0].digest.gitTree;
    const revision = option(argv, "--tree");
    if (revision !== undefined) {
      const actual = treeOfRevision(projectDir, revision);
      if (!actual) problems.push("Could not resolve " + revision + " in this repository.");
      else if (actual !== tree) problems.push("Code mismatch: " + revision + " has tree " + actual + ", but the attestation covers " + tree + ".");
    }
    if (argv.includes("--require-verified") && predicate.verdict !== "verified") {
      problems.push("Verdict is " + predicate.verdict + ", and --require-verified needs verified.");
    }
    if (problems.length) {
      process.stdout.write("INVALID:\n" + problems.map((problem) => "- " + problem).join("\n") + "\n");
      process.exitCode = 2;
      return;
    }
    if (!check.pinned) {
      // Anyone can produce a self-signed envelope; without a pinned key this proves integrity only.
      process.stdout.write(
        "UNPINNED: the envelope is intact and self-consistent, but it names its own key (" + check.fingerprint + "), so anyone could have made it.\n" +
        "Pass --expect-key <fingerprint> or --key <public.pem> to check who signed it.\n",
      );
      process.exitCode = 3;
      return;
    }
    process.stdout.write(
      "VALID: in-toto attestation signed by " + check.fingerprint + " (the key you named).\n" +
      "Verdict: " + clean(predicate.verdict) + ". Code: git tree " + tree + (revision !== undefined ? ", which matches " + revision : "") + ".\n",
    );
    return;
  }

  if (command === "pr") {
    const requested = option(argv, "--session");
    const sessionId = requested ? safeSessionId(requested) : latestSessionId(projectDir);
    const file = sessionId ? join(sessionDir(projectDir, sessionId), "receipt.json") : null;
    if (!file || !existsSync(file)) {
      process.stdout.write("No receipt yet. Run /receipt first.\n");
      process.exitCode = 1;
      return;
    }
    const bundle = JSON.parse(readFileSync(file, "utf8")) as ReceiptBundle;
    const check = verifyBundle(bundle);
    if (!check.consistent) {
      // Never render a verdict headline the evidence does not support.
      process.stdout.write("This receipt failed verification, so no summary was produced:\n" + check.problems.map((problem) => "- " + clean(problem)).join("\n") + "\nRegenerate it with /receipt.\n");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(renderPrSummary(bundle));
    return;
  }

  if (command === "key") {
    const keys = loadOrCreateKey();
    process.stdout.write(
      "Receipt signing key fingerprint: " + fingerprintOf(keys.publicKeyPem) + "\n" +
      "Public key: " + join(keyDir(), "signing-key.pub.pem") + "\n" +
      "Share the fingerprint so others can check your receipts with: verify <file> --expect-key <fingerprint>\n",
    );
    return;
  }

  process.stdout.write("Usage: cli.js init | validate | ci --expect-key <fingerprint[,fingerprint]> [--tree <commit>] [--allow-unverified] | receipt [--session <id>] [--no-checks] [--no-sign] [--strict] | pr [--session <id>] | verify <file> [--expect-key <fingerprint>] [--tree <commit>] [--require-verified] | verify-attestation <file> [--key <pem>] [--expect-key <fingerprint>] [--tree <commit>] [--require-verified] | key\n");
  process.exitCode = 1;
}
