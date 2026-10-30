import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../core/integrity";
import { CONTRACT_FILE, loadContract, STARTER_CONTRACT, type SessionCheck } from "./contract";
import { createBundle, verifyBundle, type BundleVerification } from "./bundle";
import { fingerprintOf, keyDir, loadOrCreateKey, signDigest } from "./signing";
import { changedSince } from "./git";
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

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv: string[]): void {
  const command = argv[2];
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (command === "init") {
    const path = join(projectDir, CONTRACT_FILE);
    if (existsSync(path)) {
      process.stdout.write(CONTRACT_FILE + " already exists; leaving it unchanged.\n");
      return;
    }
    writeFileSync(path, JSON.stringify(STARTER_CONTRACT, null, 2) + "\n", "utf8");
    process.stdout.write("Created " + CONTRACT_FILE + ". Edit the goal, write scope, and checks before starting work.\n");
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

    const checks = contract.status === "loaded" && !argv.includes("--no-checks")
      ? contract.contract.checks.map((check) => runCheck(projectDir, check))
      : [];

    const dir = sessionDir(projectDir, sessionId);
    if (!existsSync(join(dir, "events.jsonl"))) {
      process.stdout.write("No recorded events for session " + sessionId + ".\n");
      process.exitCode = 1;
      return;
    }
    const events = readEvents(dir);
    const receipt = buildSessionReceipt({
      sessionId,
      events,
      contract,
      checks,
      gitChanges: changedSince(projectDir, baselineFromEvents(events)),
      hashFile: (path) => {
        const absolute = join(projectDir, path);
        return existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : null;
      },
    });

    const markdown = renderReceiptMarkdown(receipt);
    const bundle = createBundle(receipt, events);
    if (!argv.includes("--no-sign")) {
      try {
        bundle.signature = signDigest(bundle.bundleDigest, loadOrCreateKey());
      } catch (error) {
        process.stderr.write("Receipt left unsigned: " + (error instanceof Error ? error.message : "signing failed") + "\n");
      }
    }
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8");
    writeFileSync(join(dir, "receipt.md"), markdown, "utf8");
    writeFileSync(join(dir, "receipt.html"), renderReceiptHtml(bundle), "utf8");
    writeFileSync(join(dir, "receipt.pr.md"), renderPrSummary(bundle), "utf8");
    const where = join(".receipts", "sessions", sessionId);
    process.stdout.write(markdown + "\nSaved " + join(where, "receipt.html") + " (shareable, embeds the verifiable evidence bundle), receipt.md, and receipt.json.\n");
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
    try {
      result = verifyBundle(extractBundle(readFileSync(file, "utf8")));
    } catch {
      result = { consistent: false, verdict: null, problems: ["File does not contain a readable receipt bundle."], signature: { status: "unsigned" } };
    }
    const expected = option(argv, "--expect-key");
    if (expected && !(result.signature.status === "valid" && result.signature.fingerprint === expected)) {
      result.problems.push("Not signed by the expected key " + expected + ".");
      result.consistent = false;
    }
    if (result.consistent) {
      const signer = result.signature.status === "valid"
        ? "Signed by key " + result.signature.fingerprint + ". Compare this fingerprint with the one the author published."
        : "Unsigned: nothing shows who generated it.";
      process.stdout.write(
        "CONSISTENT: the verdict (" + result.verdict + ") follows from the bundled evidence and nothing was edited after generation.\n" +
        signer + "\nThe signature shows which key produced the receipt, not that the recorded check results were truthful.\n",
      );
    } else {
      process.stdout.write("INCONSISTENT:\n" + result.problems.map((problem) => "- " + problem).join("\n") + "\n");
      process.exitCode = 2;
    }
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
    process.stdout.write(renderPrSummary(JSON.parse(readFileSync(file, "utf8"))));
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

  process.stdout.write("Usage: cli.js init | receipt [--session <id>] [--no-checks] [--no-sign] [--strict] | pr [--session <id>] | verify <file> [--expect-key <fingerprint>] | key\n");
  process.exitCode = 1;
}
