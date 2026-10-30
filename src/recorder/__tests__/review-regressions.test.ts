import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aliasingReason, classifyToolCall } from "../classify";
import { CONTRACT_FILE, SessionContractSchema } from "../contract";
import { handleHook, resolveProjectDir } from "../hook";
import { evaluateSessionAction } from "../policy";
import { sessionDir } from "../store";

// Regression tests for the independent security review of 2026-10-30.

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-review-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const contract = SessionContractSchema.parse({
  schemaVersion: "1.0",
  goal: "Change src only",
  write: ["src/**"],
  shell: { allow: ["git diff*", "npm test"], otherwise: "ask" },
  checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
});

function decide(c: typeof contract | null, tool: string, input: Record<string, unknown>) {
  return evaluateSessionAction(c, classifyToolCall(project, tool, input)).decision;
}

describe("Windows path aliases (finding 1)", () => {
  it("flags aliasing path forms", () => {
    expect(aliasingReason("receipts.contract.json.")).toBeDefined();
    expect(aliasingReason("receipts.contract.json ")).toBeDefined();
    expect(aliasingReason(".receipts./sessions/x/events.jsonl")).toBeDefined();
    expect(aliasingReason(".env::$DATA")).toBeDefined();
    expect(aliasingReason("RECEIP~1\\sessions\\x")).toBeDefined();
    expect(aliasingReason("\\\\?\\C:\\work\\.env")).toBeDefined();
    expect(aliasingReason("C:\\work\\src\\a.ts")).toBeUndefined();
    expect(aliasingReason("../src/./a.ts")).toBeUndefined();
  });

  it("denies aliasing paths with or without a contract", () => {
    expect(decide(null, "Write", { file_path: join(project, "receipts.contract.json.") })).toBe("deny");
    expect(decide(contract, "Read", { file_path: join(project, ".env::$DATA") })).toBe("deny");
    expect(decide(contract, "Read", { file_path: join(project, ".env ") })).toBe("deny");
  });

  it("follows junctions and symlinks to the real target", () => {
    mkdirSync(join(project, ".receipts", "sessions"), { recursive: true });
    mkdirSync(join(project, "src"));
    symlinkSync(join(project, ".receipts"), join(project, "src", "r"), "junction");
    expect(decide(contract, "Write", { file_path: join(project, "src", "r", "sessions", "x", "events.jsonl") })).toBe("deny");
    expect(decide(null, "Write", { file_path: join(project, "src", "r", "sessions", "x", "events.jsonl") })).toBe("deny");

    const outside = mkdtempSync(join(tmpdir(), "receipts-outside-"));
    try {
      symlinkSync(outside, join(project, "src", "out"), "junction");
      expect(decide(contract, "Write", { file_path: join(project, "src", "out", "x.ts") })).toBe("deny");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("fail closed for protected paths (finding 2)", () => {
  it("denies a recorder-file write even when the log cannot be appended", () => {
    const dir = sessionDir(project, "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "{ not json\n");
    const result = handleHook("pre", {
      session_id: "s1", cwd: project, tool_name: "Write",
      tool_input: { file_path: join(project, CONTRACT_FILE) },
    }, { CLAUDE_PROJECT_DIR: project });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("unknown tools (finding 3)", () => {
  it("puts unrecognised tools behind approval under a contract", () => {
    expect(decide(contract, "Monitor", { command: "rm -rf src" })).toBe("ask");
    expect(decide(contract, "unknown", {})).toBe("ask");
    expect(decide(contract, "TodoWrite", { todos: [] })).toBe("allow");
  });
});

describe("shell composition (finding 4)", () => {
  it("rejects PowerShell grouping, splatting, and quoting from the allow list", () => {
    expect(decide(contract, "PowerShell", { command: "git diff (Remove-Item -Recurse src)" })).toBe("ask");
    expect(decide(contract, "PowerShell", { command: "git diff @args" })).toBe("ask");
    expect(decide(contract, "Bash", { command: "git diff \"$(id)\"" })).toBe("ask");
    expect(decide(contract, "Bash", { command: "git diff src/a.ts" })).toBe("allow");
  });
});

describe("conflicting path parameters (finding 5)", () => {
  it("denies a tool call whose path parameters disagree", () => {
    expect(decide(contract, "NotebookEdit", {
      file_path: join(project, "src", "ok.ts"),
      notebook_path: join(project, ".receipts", "x.ipynb"),
    })).toBe("deny");
  });
});

describe("web targets (finding 10)", () => {
  it("drops queries and credentials from scheme-less and non-http URLs", () => {
    expect(classifyToolCall(project, "WebFetch", { url: "example.com/x?token=S" }).target).toBe("https://example.com/x");
    const ftp = classifyToolCall(project, "WebFetch", { url: "ftp://u:p@h.example/?k=S" }).target;
    expect(ftp).not.toContain("u:p");
    expect(ftp).not.toContain("k=S");
  });
});

describe("project directory resolution (finding 12)", () => {
  it("walks up from a subdirectory to the contract", () => {
    writeFileSync(join(project, CONTRACT_FILE), "{}");
    mkdirSync(join(project, "src", "deep"), { recursive: true });
    expect(resolveProjectDir({}, join(project, "src", "deep"))).toBe(project);
  });
});

describe("invalid contract (finding 13)", () => {
  it("still denies credential reads", () => {
    writeFileSync(join(project, CONTRACT_FILE), "{ broken");
    const result = handleHook("pre", {
      session_id: "s2", cwd: project, tool_name: "Read", tool_input: { file_path: join(project, ".env") },
    }, { CLAUDE_PROJECT_DIR: project });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    const log = readFileSync(join(sessionDir(project, "s2"), "events.jsonl"), "utf8");
    expect(log).toContain("\"DENY\"");
  });
});
