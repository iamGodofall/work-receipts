import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "../../core/audit-chain";
import { createBundle, matchTree, verifyBundle } from "../bundle";
import { SessionContractSchema } from "../contract";
import { currentHead, treeOfRevision, workingTreeId, type CodeIdentity } from "../git";
import { buildSessionReceipt, type CheckResult } from "../receipt";

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "receipts-code-"));
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "dist/\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("code identity", () => {
  it("equals the tree of the commit that records the same working tree", () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    const before = workingTreeId(repo);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    git("add", "-A");
    git("commit", "-q", "-m", "agent work");
    expect(treeOfRevision(repo, "HEAD")).toBe(before);
    expect(treeOfRevision(repo, currentHead(repo)!)).toBe(before);
    expect(treeOfRevision(repo, "HEAD~1")).not.toBe(before);
  });

  it("hashes a same-size edit made in the same second as the index (git's racy-clean case)", () => {
    // Make stat data alone unable to reveal the edit: same size, same mtime, ctime ignored.
    git("config", "core.trustctime", "false");
    const file = join(repo, "src", "a.ts");
    // Whole seconds are stored exactly on every platform, so the restored time matches the index entry bit for bit.
    const instant = Math.floor(Date.now() / 1000) - 100;
    utimesSync(file, instant, instant);
    git("add", "src/a.ts"); // the index entry now records mtime = instant
    writeFileSync(file, "export const a = 9;\n");
    utimesSync(file, instant, instant);
    // The index was written in the same instant as the entry it records: only racy-clean detection can catch this.
    utimesSync(join(repo, ".git", "index"), instant, instant);
    const tree = workingTreeId(repo);
    git("add", "-A");
    git("commit", "-q", "-m", "edit");
    expect(git("show", "HEAD:src/a.ts")).toBe("export const a = 9;");
    expect(tree).toBe(treeOfRevision(repo, "HEAD"));
  });

  it("leaves the real index and the working tree untouched", () => {
    writeFileSync(join(repo, "src", "untracked.ts"), "x\n");
    const index = join(repo, ".git", "index");
    const indexBefore = readFileSync(index);
    const mtime = statSync(index).mtimeMs;
    workingTreeId(repo);
    expect(readFileSync(index).equals(indexBefore)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(mtime);
    expect(git("status", "--porcelain")).toBe("?? src/untracked.ts");
  });

  it("ignores the recorder's folder and gitignored files, and sees every other change", () => {
    const clean = workingTreeId(repo);
    expect(clean).toBe(treeOfRevision(repo, "HEAD"));
    mkdirSync(join(repo, ".receipts", "sessions"), { recursive: true });
    writeFileSync(join(repo, ".receipts", "sessions", "events.jsonl"), "{}\n");
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "out.js"), "built\n");
    expect(workingTreeId(repo)).toBe(clean);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
    expect(workingTreeId(repo)).not.toBe(clean);
  });

  it("excludes a committed .receipts folder on both sides of the comparison", () => {
    mkdirSync(join(repo, ".receipts"));
    writeFileSync(join(repo, ".receipts", "receipt.json"), "{}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "commit receipts too");
    expect(treeOfRevision(repo, "HEAD")).toBe(workingTreeId(repo));
  });

  it("refuses revisions that git could read as options or ranges", () => {
    for (const bad of ["--output=/tmp/x", "-h", "HEAD..main", "a b", "", "HEAD;rm"]) {
      expect(treeOfRevision(repo, bad)).toBeNull();
    }
    expect(treeOfRevision(repo, "no-such-branch")).toBeNull();
  });

  it("is unavailable outside git", () => {
    const plain = mkdtempSync(join(tmpdir(), "receipts-plain-"));
    try {
      expect(workingTreeId(plain)).toBeNull();
      expect(currentHead(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("receipts bound to code", () => {
  const contract = SessionContractSchema.parse({
    schemaVersion: "1.0", goal: "g", write: ["src/**"],
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
  });
  const passed: CheckResult = {
    id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
    durationMs: 1, outputDigest: "a".repeat(64), outputTail: "", checkedAt: "2026-11-15T00:00:00.000Z",
  };
  const baselineEvent = appendAuditEvent(undefined, {
    eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
    payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: "2026-11-15T00:00:00.000Z",
  });
  const build = (code: CodeIdentity, checks: CheckResult[] = [passed]) => buildSessionReceipt({
    sessionId: "s", events: [baselineEvent], contract: { status: "loaded", contract }, checks,
    gitChanges: { available: true, changed: ["src/a.ts"], contractChanged: false }, hashFile: () => null, code,
  });
  const tree = "1".repeat(40);

  it("verifies only when the checks left the code unchanged", () => {
    expect(build({ available: true, tree, treeAfterChecks: tree, head: null }).verdict).toBe("verified");
    const rewritten = build({ available: true, tree, treeAfterChecks: "2".repeat(40), head: null });
    expect(rewritten.verdict).toBe("unverified");
    expect(rewritten.verdictReason).toMatch(/changed files while running/);
  });

  it("keeps a failing check as the headline even when it also rewrote files", () => {
    const failed = { ...passed, status: "failed" as const, exitCode: 1 };
    expect(build({ available: true, tree, treeAfterChecks: "2".repeat(40), head: null }, [failed]).verdict).toBe("checks_failed");
  });

  it("round-trips through bundle verification and detects an edited tree", () => {
    const receipt = build({ available: true, tree, treeAfterChecks: tree, head: "c".repeat(40) });
    const bundle = createBundle(receipt, [baselineEvent]);
    expect(verifyBundle(bundle).consistent).toBe(true);
    expect(matchTree(receipt, tree)).toEqual({ status: "match", tree });
    expect(matchTree(receipt, "3".repeat(40)).status).toBe("mismatch");
    expect(matchTree(receipt, null).status).toBe("unknown");

    const forged = JSON.parse(JSON.stringify(bundle));
    forged.receipt.code.tree = "3".repeat(40);
    const result = verifyBundle(forged);
    expect(result.consistent).toBe(false);
    expect(result.problems.join(" ")).toMatch(/digest does not match/);
  });

  it("cannot confirm code for receipts that never recorded it", () => {
    const receipt = build({ available: false, reason: "not git" });
    expect(matchTree(receipt, tree)).toEqual({ status: "unknown", reason: "The receipt does not identify the code it covers." });
  });
});
