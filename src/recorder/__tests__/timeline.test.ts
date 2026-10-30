import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../../core/audit-chain";
import { createBundle } from "../bundle";
import { CONTRACT_FILE } from "../contract";
import { handleHook, handleSessionStart } from "../hook";
import { renderReceiptHtml } from "../html";
import { buildSessionReceipt } from "../receipt";
import { readEvents, sessionDir } from "../store";
import { buildTimeline } from "../timeline";

let project: string;
const session = "timeline-session";

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-timeline-"));
  writeFileSync(join(project, CONTRACT_FILE), JSON.stringify({
    schemaVersion: "1.0", goal: "Timeline", write: ["src/**"],
    shell: { allow: ["npm test"], otherwise: "ask" },
    checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
  }));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function record(): AuditEvent[] {
  const env = { CLAUDE_PROJECT_DIR: project };
  const call = (mode: "pre" | "post" | "failure", tool: string, input: Record<string, unknown>, id: string, agent?: string) =>
    handleHook(mode, { session_id: session, tool_name: tool, tool_input: input, tool_use_id: id, ...(agent ? { agent_type: agent } : {}) }, env);
  handleSessionStart({ session_id: session, cwd: project, source: "startup" }, env);
  call("pre", "Edit", { file_path: join(project, "src", "a.ts") }, "1");
  call("post", "Edit", { file_path: join(project, "src", "a.ts") }, "1");
  call("pre", "Write", { file_path: join(project, "package.json") }, "2");
  call("pre", "Bash", { command: "npm install <script>alert(1)</script>" }, "3");
  call("post", "Bash", { command: "npm install <script>alert(1)</script>" }, "3");
  call("pre", "Bash", { command: "rm -rf build" }, "4");
  call("pre", "Read", { file_path: join(project, "src", "a.ts") }, "5", "Explore");
  call("failure", "Read", { file_path: join(project, "src", "a.ts") }, "5", "Explore");
  return readEvents(sessionDir(project, session)) as AuditEvent[];
}

describe("timeline", () => {
  it("pairs every request with its outcome, in order", () => {
    const timeline = buildTimeline(record());
    expect(timeline.map((entry) => [entry.tool, entry.status])).toEqual([
      ["Edit", "done"],
      ["Write", "blocked"],
      ["Bash", "approved"],
      ["Bash", "not_run"],
      ["Read", "failed"],
    ]);
    expect(timeline[1].reason).toMatch(/write scope/);
    expect(timeline[4].actor).toBe("claude-code:Explore");
  });

  it("renders in the HTML receipt with recorded text escaped", () => {
    const events = record();
    const receipt = buildSessionReceipt({
      sessionId: session, events, contract: { status: "absent" }, checks: [],
      gitChanges: { available: false, reason: "test" }, hashFile: () => null,
    });
    const html = renderReceiptHtml(createBundle(receipt, events));
    expect(html).toContain("What the agent did, step by step");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.split("<script").length - 1).toBe(1);
  });
});
