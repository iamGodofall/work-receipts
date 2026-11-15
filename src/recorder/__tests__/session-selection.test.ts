import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAgentWork, latestWorkSession } from "../store";

/**
 * Found in a live Claude Code session (2026-11-15): running /receipt in a new
 * session receipted that new, empty session (it only invoked the command) and
 * reported VERIFIED, instead of the session that did the work.
 */

const requested = (tool: string, commandPreview?: string) => ({ eventType: "tool.requested", payload: { tool, ...(commandPreview ? { commandPreview } : {}) } });

let project = "";
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-select-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function session(id: string, events: unknown[], ageSeconds: number) {
  const dir = join(project, ".receipts", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(file, when, when);
}

describe("choosing the session a receipt describes", () => {
  it("recognises sessions that only ran the recorder's own commands", () => {
    expect(hasAgentWork([{ eventType: "session.baseline" }, requested("Skill")])).toBe(false);
    expect(hasAgentWork([requested("Bash", "node \"C:/x/plugin/bin/cli.js\" receipt")])).toBe(false);
    expect(hasAgentWork([requested("Skill"), requested("Edit")])).toBe(true);
    expect(hasAgentWork([requested("Bash", "npm test")])).toBe(true);
    expect(hasAgentWork([null, { eventType: "tool.completed", payload: { tool: "Edit" } }])).toBe(false);
  });

  it("skips newer command-only sessions and reports how many it skipped", () => {
    session("work", [{ eventType: "session.baseline" }, requested("Edit"), requested("Bash", "npm test")], 300);
    session("receipt-run", [{ eventType: "session.baseline" }, requested("Skill")], 60);
    session("receipt-run-2", [requested("Bash", "node plugin/bin/cli.js pr")], 10);
    expect(latestWorkSession(project)).toEqual({ sessionId: "work", skipped: 2 });
  });

  it("picks the newest working session and returns null when none did work", () => {
    session("older", [requested("Read")], 500);
    session("newer", [requested("Write")], 100);
    expect(latestWorkSession(project)).toEqual({ sessionId: "newer", skipped: 0 });
    rmSync(join(project, ".receipts"), { recursive: true, force: true });
    expect(latestWorkSession(project)).toBeNull();
    session("only-receipt", [requested("Skill")], 5);
    expect(latestWorkSession(project)).toBeNull();
  });
});
