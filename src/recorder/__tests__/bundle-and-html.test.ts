import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBundle, verifyBundle } from "../bundle";
import { CONTRACT_FILE, SessionContractSchema } from "../contract";
import { describeScope, handleHook, handleSessionStart } from "../hook";
import { extractBundle, renderReceiptHtml } from "../html";
import { buildSessionReceipt, type CheckResult } from "../receipt";
import { readEvents, sessionDir } from "../store";

let project: string;
const session = "bundle-session";

const contractJson = {
  schemaVersion: "1.0",
  goal: "Add a <greeting> module",
  write: ["src/**"],
  checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
};

const passed: CheckResult = {
  id: "tests", description: "Tests pass", command: "npm test", status: "passed", exitCode: 0,
  durationMs: 5, outputDigest: "a".repeat(64), outputTail: "", checkedAt: "2026-10-30T08:00:00.000Z",
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "receipts-bundle-"));
  writeFileSync(join(project, CONTRACT_FILE), JSON.stringify(contractJson));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function recordedBundle() {
  const env = { CLAUDE_PROJECT_DIR: project };
  handleSessionStart({ session_id: session, cwd: project, source: "startup" }, env);
  handleHook("pre", { session_id: session, tool_name: "Write", tool_input: { file_path: join(project, "src", "g.ts") }, tool_use_id: "w1" }, env);
  handleHook("post", { session_id: session, tool_name: "Write", tool_input: { file_path: join(project, "src", "g.ts") }, tool_use_id: "w1" }, env);
  handleHook("pre", { session_id: session, tool_name: "Write", tool_input: { file_path: join(project, "package.json") }, tool_use_id: "w2", agent_type: "Explore" }, env);
  const events = readEvents(sessionDir(project, session));
  const receipt = buildSessionReceipt({
    sessionId: session,
    events,
    contract: { status: "loaded", contract: SessionContractSchema.parse(contractJson) },
    checks: [passed],
    gitChanges: { available: true, changed: ["src/g.ts"], contractChanged: false },
    hashFile: () => "b".repeat(64),
    now: new Date("2026-10-30T08:00:01.000Z"),
  });
  return createBundle(receipt, events);
}

describe("session start", () => {
  it("records the baseline before anything else and tells the model its scope", () => {
    const output = handleSessionStart({ session_id: session, cwd: project, source: "startup" }, { CLAUDE_PROJECT_DIR: project });
    expect(output.hookSpecificOutput.additionalContext).toContain("src/**");
    expect(output.hookSpecificOutput.additionalContext).toContain("npm test");
    const events = readEvents(sessionDir(project, session)) as { eventType: string }[];
    expect(events.map((event) => event.eventType)).toEqual(["session.baseline", "session.started"]);
  });

  it("explains recording-only mode when there is no contract", () => {
    rmSync(join(project, CONTRACT_FILE));
    expect(describeScope(project)).toContain("No receipts.contract.json");
  });

  it("attributes subagent tool calls", () => {
    const actors = (recordedBundle().events as { actorSubject: string }[]).map((event) => event.actorSubject);
    expect(actors).toContain("claude-code:Explore");
  });
});

describe("bundle verification", () => {
  it("confirms an untouched bundle", () => {
    expect(verifyBundle(recordedBundle())).toEqual({ consistent: true, verdict: "verified", problems: [], signature: { status: "unsigned" } });
  });

  it("rejects a bundle whose check results were edited", () => {
    const bundle = recordedBundle();
    const forged = { ...bundle, receipt: { ...bundle.receipt, checks: [{ ...passed, status: "failed" as const }] } };
    expect(verifyBundle(forged).consistent).toBe(false);
  });

  it("rejects a bundle with a deleted denial even if the digest is recomputed", () => {
    const bundle = recordedBundle();
    const forged = createBundle(bundle.receipt, bundle.events.slice(0, -1));
    const result = verifyBundle(forged);
    expect(result.consistent).toBe(false);
    expect(result.problems.join(" ")).toMatch(/summary|denied|chain/);
  });

  it("rejects a bundle whose contract was loosened", () => {
    const bundle = recordedBundle();
    const terms = { ...bundle.receipt.contract.terms!, write: ["**"] };
    const forged = createBundle({ ...bundle.receipt, contract: { ...bundle.receipt.contract, terms } }, bundle.events);
    expect(verifyBundle(forged).problems).toContain("Embedded contract does not match its digest.");
  });
});

describe("HTML receipt", () => {
  it("embeds a bundle that round-trips through verification", () => {
    const html = renderReceiptHtml(recordedBundle());
    expect(verifyBundle(extractBundle(html)).consistent).toBe(true);
  });

  it("escapes recorded text so a goal or path cannot inject markup", () => {
    const html = renderReceiptHtml(recordedBundle());
    expect(html).toContain("Add a &lt;greeting&gt; module");
    expect(html).not.toContain("<greeting>");
    const script = /<script type="application\/json" id="work-receipt-bundle">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(script).not.toContain("</");
  });

  it("derives the mascot's mood from the verdict", () => {
    const bundle = recordedBundle();
    expect(renderReceiptHtml(bundle)).toContain("Mascot looking celebrating");
    const failed = { ...bundle, receipt: { ...bundle.receipt, verdict: "checks_failed" as const } };
    expect(renderReceiptHtml(failed)).toContain("Mascot looking concerned");
  });
});

describe("recorder versions", () => {
  it("reports a receipt from another recorder version as a version mismatch, not tampering", () => {
    const bundle = recordedBundle();
    const old = createBundle({ ...bundle.receipt, recorderVersion: "0.0.9" }, bundle.events);
    const result = verifyBundle(old);
    expect(result.consistent).toBe(false);
    expect(result.versionMismatch).toBe("0.0.9");
    expect(result.problems[0]).toMatch(/recorder 0\.0\.9/);
  });
});

describe("pull request summary", () => {
  it("states the computed verdict and numbers, with recorded text escaped", async () => {
    const { renderPrSummary } = await import("../pr");
    const summary = renderPrSummary(recordedBundle());
    expect(summary).toContain("### Work Receipt: ✅ **Verified**");
    expect(summary).toContain("Add a \\<greeting\\> module");
    expect(summary).toContain("**1/1** checks passed");
    expect(summary).toContain("**1** blocked");
    expect(summary).not.toContain("<greeting>");
  });

  it("calls out out-of-scope changes", async () => {
    const { renderPrSummary } = await import("../pr");
    const bundle = recordedBundle();
    const flagged = {
      ...bundle,
      receipt: { ...bundle.receipt, verdict: "out_of_scope" as const, workingTree: { ...bundle.receipt.workingTree, outOfScope: ["package.json"] } },
    };
    const summary = renderPrSummary(flagged);
    expect(summary).toContain("⚠️ **Out of scope**");
    expect(summary).toContain("**Changed outside the agreed scope:** `package.json`");
  });
});
