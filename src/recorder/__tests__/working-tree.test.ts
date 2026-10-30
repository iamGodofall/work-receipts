import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionContractSchema } from "../contract";
import { captureBaseline, changedSince } from "../git";
import { appendAuditEvent } from "../../core/audit-chain";
import { buildSessionReceipt, type CheckResult } from "../receipt";

let repo: string;

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "receipts-git-"));
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, ".gitignore"), ".receipts/\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("working-tree evidence", () => {
  it("detects changes made by any means, including shell side effects", () => {
    const baseline = captureBaseline(repo);
    writeFileSync(join(repo, "package.json"), "{\"scripts\":{}}\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    const changes = changedSince(repo, baseline);
    expect(changes).toEqual({ available: true, changed: ["package.json", "src/b.ts"], contractChanged: false });
  });

  it("ignores files that were already modified and did not change again", () => {
    writeFileSync(join(repo, "package.json"), "{\"dirty\":true}\n");
    const baseline = captureBaseline(repo);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    const changes = changedSince(repo, baseline);
    expect(changes.available && changes.changed).toEqual(["src/a.ts"]);
  });

  it("includes changes that were committed during the session", () => {
    const baseline = captureBaseline(repo);
    writeFileSync(join(repo, "package.json"), "{\"v\":2}\n");
    git("commit", "-q", "-am", "agent commit");
    const changes = changedSince(repo, baseline);
    expect(changes.available && changes.changed).toEqual(["package.json"]);
  });

  it("reports the contract separately and never counts the receipt log", () => {
    const baseline = captureBaseline(repo);
    writeFileSync(join(repo, "receipts.contract.json"), "{}\n");
    const changes = changedSince(repo, baseline);
    expect(changes).toEqual({ available: true, changed: [], contractChanged: true });
  });

  it("is unavailable outside a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "receipts-plain-"));
    try {
      expect(changedSince(plain, captureBaseline(plain)).available).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("scope verdict", () => {
  const contract = SessionContractSchema.parse({
    schemaVersion: "1.0",
    goal: "Change src only",
    write: ["src/**"],
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
  });
  const passed: CheckResult = {
    id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
    durationMs: 1, outputDigest: "a".repeat(64), outputTail: "", checkedAt: new Date().toISOString(),
  };
  const baselineEvent = appendAuditEvent(undefined, {
    eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
    payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: new Date().toISOString(),
  });
  const build = (gitChanges: Parameters<typeof buildSessionReceipt>[0]["gitChanges"]) =>
    buildSessionReceipt({ sessionId: "s", events: [baselineEvent], contract: { status: "loaded", contract }, checks: [passed], gitChanges, hashFile: () => null });

  it("fails a session that changed files outside the write scope, even when checks pass", () => {
    const receipt = build({ available: true, changed: ["package.json", "src/a.ts"], contractChanged: false });
    expect(receipt.verdict).toBe("out_of_scope");
    expect(receipt.workingTree.outOfScope).toEqual(["package.json"]);
    expect(receipt.workingTree.notFromFileTools).toEqual(["package.json", "src/a.ts"]);
  });

  it("does not verify when working-tree evidence is unavailable", () => {
    expect(build({ available: false, reason: "The project is not a git repository." }).verdict).toBe("unverified");
  });

  it("verifies in-scope changes with passing checks", () => {
    expect(build({ available: true, changed: ["src/a.ts"], contractChanged: false }).verdict).toBe("verified");
  });
});

describe("check integrity", () => {
  it("refuses to verify when a root executable could shadow a check command", () => {
    const contract = SessionContractSchema.parse({
      schemaVersion: "1.0", goal: "g", write: ["**"],
      checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
    });
    const baselineEvent = appendAuditEvent(undefined, {
      eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
      payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: new Date().toISOString(),
    });
    const passed: CheckResult = {
      id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
      durationMs: 1, outputDigest: "a".repeat(64), outputTail: "", checkedAt: new Date().toISOString(),
    };
    const receipt = buildSessionReceipt({
      sessionId: "s", events: [baselineEvent], contract: { status: "loaded", contract }, checks: [passed],
      gitChanges: { available: true, changed: ["npm.cmd", "package.json"], contractChanged: false }, hashFile: () => null,
    });
    expect(receipt.verdict).toBe("unverified");
    expect(receipt.checkInputsChanged).toEqual(["npm.cmd", "package.json"]);
  });

  it("never verifies an empty log", () => {
    const contract = SessionContractSchema.parse({
      schemaVersion: "1.0", goal: "g", write: ["src/**"],
      checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
    });
    const receipt = buildSessionReceipt({
      sessionId: "s", events: [], contract: { status: "loaded", contract }, checks: [],
      gitChanges: { available: true, changed: [], contractChanged: false }, hashFile: () => null,
    });
    expect(receipt.verdict).toBe("unverified");
  });
});

describe("contract ignore list", () => {
  it("lists ignored changes without failing the scope check", () => {
    const contract = SessionContractSchema.parse({
      schemaVersion: "1.0", goal: "g", write: ["src/**"], ignore: ["${HOME}/**"],
      checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
    });
    const baselineEvent = appendAuditEvent(undefined, {
      eventId: "e1", runId: "s", workspaceId: "w", actorSubject: "work-receipts", eventType: "session.baseline",
      payload: { baseline: { git: true, head: null, dirty: [], truncated: false } }, createdAt: new Date().toISOString(),
    });
    const passed: CheckResult = {
      id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
      durationMs: 1, outputDigest: "a".repeat(64), outputTail: "", checkedAt: new Date().toISOString(),
    };
    const receipt = buildSessionReceipt({
      sessionId: "s", events: [baselineEvent], contract: { status: "loaded", contract }, checks: [passed],
      gitChanges: { available: true, changed: ["${HOME}/.claude/log.jsonl", "src/a.ts"], contractChanged: false }, hashFile: () => null,
    });
    expect(receipt.verdict).toBe("verified");
    expect(receipt.workingTree.ignored).toEqual(["${HOME}/.claude/log.jsonl"]);
  });
});
