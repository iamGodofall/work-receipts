import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTRACT_FILE, SessionContractSchema } from "../contract";
import { handleHook } from "../hook";
import { buildSessionReceipt, type CheckResult } from "../receipt";
import { readEvents, redactPreview, sessionDir } from "../store";

let project: string;
const session = "session-test-1";

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function run(mode: "pre" | "post" | "failure", tool: string, input: Record<string, unknown>, id: string) {
  return handleHook(
    mode,
    { session_id: session, cwd: project, tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { ok: true } },
    { CLAUDE_PROJECT_DIR: project },
  );
}

function writeContract(extra: Record<string, unknown> = {}) {
  writeFileSync(join(project, CONTRACT_FILE), JSON.stringify({
    schemaVersion: "1.0",
    goal: "Add a greeting module",
    write: ["src/**"],
    shell: { allow: ["npm test"], otherwise: "ask" },
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
    ...extra,
  }));
}

const clean = { available: true as const, changed: ["src/greet.ts"], contractChanged: false };

const passed: CheckResult = {
  id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
  durationMs: 10, outputDigest: "a".repeat(64), outputTail: "", checkedAt: new Date().toISOString(),
};

describe("hook handler", () => {
  it("returns no decision for allowed actions so host permissions still apply", () => {
    writeContract();
    expect(run("pre", "Write", { file_path: join(project, "src", "greet.ts") }, "t1")).toBeNull();
  });

  it("denies out-of-scope writes and records the denial", () => {
    writeContract();
    const output = run("pre", "Write", { file_path: join(project, "package.json") }, "t2");
    expect(output?.hookSpecificOutput.permissionDecision).toBe("deny");
    const events = readEvents(sessionDir(project, session)) as { eventType: string; policyOutcome?: string; resultStatus?: string }[];
    expect(events[0].eventType).toBe("session.baseline");
    expect(events[1]).toMatchObject({ policyOutcome: "DENY", resultStatus: "denied" });
  });

  it("asks the host to prompt for commands outside the allow list", () => {
    writeContract();
    expect(run("pre", "Bash", { command: "npm install left-pad" }, "t3")?.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("fails closed when the contract is invalid, except for reads", () => {
    writeFileSync(join(project, CONTRACT_FILE), "{ not json");
    expect(run("pre", "Bash", { command: "ls" }, "t4")?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(run("pre", "Read", { file_path: join(project, "README.md") }, "t5")).toBeNull();
  });

  it("does not store raw secrets from commands", () => {
    run("pre", "Bash", { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' https://x" }, "t6");
    const log = readFileSync(join(sessionDir(project, session), "events.jsonl"), "utf8");
    expect(log).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(redactPreview("API_KEY=supersecretvalue npm run x")).toContain("[REDACTED]");
  });

  it("strips URL query strings, which often carry tokens", () => {
    run("pre", "WebFetch", { url: "https://api.example.com/v1/items?token=abc123" }, "t7");
    const log = readFileSync(join(sessionDir(project, session), "events.jsonl"), "utf8");
    expect(log).not.toContain("abc123");
  });
});

describe("session receipt", () => {
  function recordSession() {
    writeContract();
    run("pre", "Write", { file_path: join(project, "src", "greet.ts") }, "w1");
    run("post", "Write", { file_path: join(project, "src", "greet.ts") }, "w1");
    run("pre", "Write", { file_path: join(project, "package.json") }, "w2");
    run("pre", "Bash", { command: "npm install left-pad" }, "b1");
    run("post", "Bash", { command: "npm install left-pad" }, "b1");
    return readEvents(sessionDir(project, session));
  }

  const contractInfo = () => ({
    status: "loaded" as const,
    contract: SessionContractSchema.parse(JSON.parse(readFileSync(join(project, CONTRACT_FILE), "utf8"))),
  });

  it("is verified only when the chain is intact and every check passed", () => {
    const events = recordSession();
    const receipt = buildSessionReceipt({ sessionId: session, events, contract: contractInfo(), checks: [passed], gitChanges: clean, hashFile: () => "b".repeat(64) });
    expect(receipt.verdict).toBe("verified");
    expect(receipt.summary).toMatchObject({ requested: 3, completed: 2, denied: 1, approvalRequested: 1 });
    expect(receipt.approvalRequests[0].executed).toBe(true);
    expect(receipt.filesChanged).toEqual([{ path: "src/greet.ts", sha256: "b".repeat(64) }]);
  });

  it("reports failed checks instead of success", () => {
    const events = recordSession();
    const receipt = buildSessionReceipt({
      sessionId: session, events, contract: contractInfo(),
      checks: [{ ...passed, status: "failed", exitCode: 1 }], gitChanges: clean, hashFile: () => null,
    });
    expect(receipt.verdict).toBe("checks_failed");
  });

  it("is never verified without a contract or without checks", () => {
    const events = recordSession();
    expect(buildSessionReceipt({ sessionId: session, events, contract: { status: "absent" }, checks: [], gitChanges: clean, hashFile: () => null }).verdict).toBe("unverified");
    expect(buildSessionReceipt({ sessionId: session, events, contract: contractInfo(), checks: [], gitChanges: clean, hashFile: () => null }).verdict).toBe("unverified");
  });

  it("detects an edited event log", () => {
    const events = recordSession() as Record<string, unknown>[];
    events[2] = { ...events[2], target: "src/innocent.ts" };
    const receipt = buildSessionReceipt({ sessionId: session, events, contract: contractInfo(), checks: [passed], gitChanges: clean, hashFile: () => null });
    expect(receipt.verdict).toBe("tampered");
  });
});
