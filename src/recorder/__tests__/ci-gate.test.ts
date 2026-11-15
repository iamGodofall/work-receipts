import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "../../core/audit-chain";
import { createBundle } from "../bundle";
import { gate, renderGateSummary } from "../ci";
import { SessionContractSchema } from "../contract";
import { readCommittedFile, receiptsEntries, treeOfRevision, workingTreeId } from "../git";
import { md } from "../ci";
import { buildSessionReceipt, type CheckResult } from "../receipt";
import { fingerprintOf, signDigest } from "../signing";

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const user = keys();
const trusted = [fingerprintOf(user.publicKeyPem)];

/** Write a receipt for the current working tree into .receipts/sessions/<id>/receipt.json. */
function writeReceipt(id: string, options: { signer?: ReturnType<typeof keys> | null; status?: CheckResult["status"] } = {}) {
  const tree = workingTreeId(repo)!;
  const contract = SessionContractSchema.parse({
    schemaVersion: "1.0", goal: "g", write: ["src/**"],
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
  });
  const event = appendAuditEvent(undefined, {
    eventId: "e-" + id, runId: id, workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
    payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: "2026-11-15T00:00:00.000Z",
  });
  const status = options.status ?? "passed";
  const receipt = buildSessionReceipt({
    sessionId: id, events: [event], contract: { status: "loaded", contract },
    checks: [{ id: "tests", description: "Tests pass", command: "npm test", status, exitCode: status === "passed" ? 0 : 1, durationMs: 1, outputDigest: "e".repeat(64), outputTail: "", checkedAt: "2026-11-15T00:00:00.000Z" }],
    gitChanges: { available: true, changed: ["src/a.ts"], contractChanged: false }, hashFile: () => null,
    code: { available: true, tree, treeAfterChecks: tree, head: null },
  });
  const bundle = createBundle(receipt, [event]);
  const signer = options.signer === undefined ? user : options.signer;
  if (signer) bundle.signature = signDigest(bundle.bundleDigest, signer);
  const dir = join(repo, ".receipts", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(bundle));
}

function commitAll(message: string) {
  git("add", "-A", "-f");
  git("commit", "-q", "-m", message);
}

const run = (options: Partial<Parameters<typeof gate>[0]> = {}) =>
  gate({
    revision: "HEAD", tree: treeOfRevision(repo, "HEAD"), receiptsEntries: receiptsEntries(repo, "HEAD"),
    readCommitted: (path) => readCommittedFile(repo, "HEAD", path),
    trustedKeys: trusted, requireVerified: true, ...options,
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "receipts-gate-"));
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), ".receipts/\n");
  commitAll("init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("pull-request gate", () => {
  it("passes when a trusted, signed, verified receipt covers exactly the committed code", () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeReceipt("s1");
    commitAll("agent work with receipt");
    const result = run();
    expect(result.passed).toBe(true);
    expect(result.receipts[0]).toMatchObject({ sessionId: "s1", verdict: "verified", signer: trusted[0], passes: true });
    expect(renderGateSummary(result)).toMatch(/✅ passed/);
  });

  it("fails when code changed after the receipt was generated", () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeReceipt("s1");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 'sneaky';\n");
    commitAll("edit after receipt");
    const result = run();
    expect(result.passed).toBe(false);
    expect(result.receipts[0].problems.join(" ")).toMatch(/not this commit's/);
  });

  it("fails without a trusted key, with a foreign signer, or with an unsigned receipt", () => {
    writeReceipt("s1", { signer: keys() });
    writeReceipt("s2", { signer: null });
    commitAll("receipts");
    expect(run({ trustedKeys: [] }).reason).toMatch(/could be forged/);
    const result = run();
    expect(result.passed).toBe(false);
    expect(result.receipts.map((receipt) => receipt.problems.join(" "))).toEqual([
      expect.stringMatching(/not a trusted key/),
      expect.stringMatching(/Unsigned/),
    ]);
  });

  it("requires a verified verdict unless told otherwise", () => {
    writeReceipt("s1", { status: "failed" });
    commitAll("failing checks");
    expect(run().passed).toBe(false);
    expect(run({ requireVerified: false }).passed).toBe(true);
  });

  it("fails clearly when there is no receipt or the commit cannot be resolved", () => {
    expect(run().reason).toMatch(/No receipt found/);
    expect(run({ revision: "nope", tree: null, receiptsEntries: null }).reason).toMatch(/Could not resolve nope/);
    expect(readCommittedFile(repo, "--output=x", "a")).toBeNull();
  });

  it("fails when code is hidden under .receipts, which is outside the receipted code", () => {
    writeFileSync(join(repo, "src", "a.ts"), "export * from '../.receipts/helper';\n");
    mkdirSync(join(repo, ".receipts"), { recursive: true });
    writeFileSync(join(repo, ".receipts", "helper.ts"), "export const a = 1;\n");
    writeReceipt("s1");
    // Changed after the receipt: invisible to the code identity, so the gate must refuse the folder itself.
    writeFileSync(join(repo, ".receipts", "helper.ts"), "export const a = 'evil';\n");
    commitAll("hide code in .receipts");
    const result = run();
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/not receipt artifacts.*\.receipts\/helper\.ts/);
  });

  it("refuses a symlink disguised as a receipt artifact", () => {
    writeReceipt("s1");
    commitAll("receipt");
    // Stage a symlink entry directly, so the test does not depend on OS symlink privileges.
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "../../../src/a.ts", encoding: "utf8" }).stdout.trim();
    git("update-index", "--add", "--cacheinfo", "120000," + blob + ",.receipts/sessions/s1/receipt.md");
    git("commit", "-q", "-m", "symlink");
    expect(run().reason).toMatch(/receipt\.md/);
  });

  it("accepts the complete set of receipt artifacts", () => {
    writeReceipt("s1");
    for (const name of ["receipt.html", "receipt.md", "receipt.pr.md", "receipt.intoto.json", "events.jsonl"]) {
      writeFileSync(join(repo, ".receipts", "sessions", "s1", name), "x\n");
    }
    commitAll("all artifacts");
    expect(run().passed).toBe(true);
  });

  it("judges only what the commit stores, never receipts left in the working directory", () => {
    // A valid signed receipt exists on disk but was never committed (review finding H2).
    writeReceipt("s1");
    expect(run().reason).toMatch(/No receipt found/);
    // And a committed receipt is read from the commit even if the file on disk is replaced afterwards.
    commitAll("receipt");
    writeFileSync(join(repo, ".receipts", "sessions", "s1", "receipt.json"), "garbage");
    expect(run().passed).toBe(true);
  });

  it("assesses hostile receipts as failures without crashing, and still finds a good one", () => {
    const dir = (id: string) => {
      const path = join(repo, ".receipts", "sessions", id);
      mkdirSync(path, { recursive: true });
      return path;
    };
    // Each of these crashed the gate before the review fixes (finding H3).
    writeFileSync(join(dir("a1"), "receipt.json"), JSON.stringify({ kind: "work-receipt-bundle", receipt: { recorderVersion: "0.2.0" }, events: [] }));
    writeFileSync(join(dir("a2"), "receipt.json"), "[".repeat(20000) + "]".repeat(20000));
    writeFileSync(join(dir("a3"), "receipt.json"), JSON.stringify({ kind: "work-receipt-bundle", receipt: { workingTree: {}, filesChanged: [], deep: JSON.parse("[".repeat(100) + "]".repeat(100)) }, events: [] }));
    writeReceipt("good");
    commitAll("mixed receipts");
    const result = run();
    expect(result.passed).toBe(true);
    expect(result.receipts.filter((receipt) => !receipt.passes)).toHaveLength(3);
  });

  it("escapes summary text so a receipt cannot forge table cells or terminal output", () => {
    expect(md("\\| pass |")).toBe("\\\\\\| pass \\|");
    expect(md("ok\u001b[2J\rfake")).toBe("ok \\[2J fake");
  });

  it("detects a receipt edited after signing", () => {
    writeReceipt("s1");
    const file = join(repo, ".receipts", "sessions", "s1", "receipt.json");
    const bundle = JSON.parse(readFileSync(file, "utf8"));
    bundle.receipt.checks[0].status = "passed";
    bundle.receipt.verdictReason = "Totally fine.";
    writeFileSync(file, JSON.stringify(bundle));
    commitAll("tamper");
    const result = run();
    expect(result.passed).toBe(false);
    expect(result.receipts[0].problems.join(" ")).toMatch(/digest|does not follow/);
  });
});
