import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTRACT_FILE } from "../contract";
import { handleHook } from "../hook";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-search-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "app.ts"), "export const token = process.env.API_TOKEN;\n");
  writeFileSync(join(project, ".env"), "API_TOKEN=secret\n");
  writeFileSync(join(project, CONTRACT_FILE), JSON.stringify({
    schemaVersion: "1.0", goal: "Search test", write: ["src/**"],
    checks: [{ id: "tests", description: "Tests pass", command: "node -e 0" }],
  }));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function grep(path: string) {
  return handleHook("pre", {
    session_id: "search", tool_name: "Grep", tool_input: { pattern: "API_TOKEN", path }, tool_use_id: "g1",
  }, { CLAUDE_PROJECT_DIR: project })?.hookSpecificOutput.permissionDecision ?? "allow";
}

function initGit(ignoreEnv: boolean) {
  writeFileSync(join(project, ".gitignore"), ignoreEnv ? ".env\n.receipts/\n" : ".receipts/\n");
  spawnSync("git", ["init", "-q"], { cwd: project });
}

describe("content searches and protected files", () => {
  it("denies a project-wide search that would read a non-ignored secret", () => {
    initGit(false);
    expect(grep(project)).toBe("deny");
  });

  it("allows the same search when the secret is gitignored, as Grep skips it", () => {
    initGit(true);
    expect(grep(project)).toBe("allow");
  });

  it("allows searching a folder that holds no protected files", () => {
    initGit(false);
    expect(grep(join(project, "src"))).toBe("allow");
  });

  it("checks the folder directly when the project is not a git repository", () => {
    expect(grep(project)).toBe("deny");
    expect(grep(join(project, "src"))).toBe("allow");
  });
});
