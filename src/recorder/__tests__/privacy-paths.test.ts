import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../hook";
import { scrubLocalPaths, sessionDir } from "../store";

/**
 * Found reviewing a live receipt (2026-11-15): command previews kept
 * `cd "D:/.../project"`, although receipts promise no absolute paths or user names.
 */
describe("receipts carry no absolute paths or user names", () => {
  const win = process.platform === "win32";
  const project = win ? "C:\\Users\\Ada Lovelace\\work\\app" : "/home/ada/work/app";
  const home = win ? "C:\\Users\\Ada Lovelace" : "/home/ada";

  it("replaces the project with '.' and the home folder with '~' in every spelling", () => {
    const spellings = win
      ? ['cd "C:/Users/Ada Lovelace/work/app" && ls', "cd C:\\Users\\Ada Lovelace\\work\\app\\src", 'cd "/c/Users/Ada Lovelace/work/app"', "cat c:/users/ada lovelace/.ssh/config"]
      : ['cd "/home/ada/work/app" && ls', "cd /home/ada/work/app/src", "cat /home/ada/.ssh/config"];
    for (const text of spellings) {
      const scrubbed = scrubLocalPaths(text, project, home);
      expect(scrubbed).not.toMatch(/Ada|ada/);
    }
    expect(scrubLocalPaths(win ? 'cd "C:/Users/Ada Lovelace/work/app" && ls' : 'cd "/home/ada/work/app" && ls', project, home)).toBe('cd "." && ls');
  });

  it("does not touch paths that only share a prefix", () => {
    const other = win ? "C:\\Users\\Ada Lovelace\\work\\application" : "/home/ada/work/application";
    expect(scrubLocalPaths("cd " + other, project, home)).toBe("cd " + (win ? "~\\work\\application" : "~/work/application"));
  });

  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "receipts-privacy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores scrubbed previews in the session log", () => {
    handleHook("pre", { session_id: "s", tool_name: "Bash", tool_input: { command: 'cd "' + dir.replace(/\\/g, "/") + '" && npm test' } }, { CLAUDE_PROJECT_DIR: dir });
    const log = readFileSync(join(sessionDir(dir, "s"), "events.jsonl"), "utf8");
    expect(log).toContain('cd \\".\\" && npm test');
    expect(log).not.toContain(dir.replace(/\\/g, "/"));
  });
});
