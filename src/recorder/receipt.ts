import { verifyAuditChain, type AuditChainAssessment, type AuditEvent } from "../core/audit-chain";
import { sha256Object } from "../core/integrity";
import type { SessionContract } from "./contract";
import type { GitBaseline, GitChanges } from "./git";
import { matchesPatternList } from "./glob";

export type CheckResult = {
  id: string;
  description: string;
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  durationMs: number;
  outputDigest: string;
  outputTail: string;
  checkedAt: string;
};

export type FileEvidence = {
  path: string;
  /** SHA-256 of the file at receipt time; null when the file no longer exists. */
  sha256: string | null;
};

export type ContractInfo =
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "loaded"; contract: SessionContract };

/** Bump whenever receipt computation changes, so older receipts are never misread as tampered. */
export const RECORDER_VERSION = "0.1.0";

export type Verdict = "verified" | "checks_failed" | "out_of_scope" | "unverified" | "tampered";

export type SessionReceipt = {
  schemaVersion: "1.0";
  kind: "claude-code-session";
  /** Version of the logic that computed this receipt; verification must use the same rules. */
  recorderVersion: string;
  sessionId: string;
  workspaceId: string | null;
  generatedAt: string;
  firstEventAt: string | null;
  lastEventAt: string | null;
  contract: { status: ContractInfo["status"]; digest: string | null; goal: string | null; terms: SessionContract | null };
  chain: AuditChainAssessment & { headHash: string | null };
  summary: {
    requested: number;
    completed: number;
    failed: number;
    denied: number;
    approvalRequested: number;
    byCategory: Record<string, number>;
  };
  denied: { tool: string; target: string; reason: string; at: string }[];
  approvalRequests: { tool: string; target: string; preview: string | null; executed: boolean; at: string }[];
  filesChanged: FileEvidence[];
  workingTree: GitChanges & { outOfScope: string[]; notFromFileTools: string[]; ignored: string[] };
  /** Changed files that can alter what the acceptance checks actually execute. */
  checkInputsChanged: string[];
  checks: CheckResult[];
  verdict: Verdict;
  verdictReason: string;
  limitations: string[];
};

/** Root-level files the shell resolves before PATH on Windows. */
const ROOT_EXECUTABLES = ["*.cmd", "*.bat", "*.exe", "*.com", "*.ps1"];

/** Files that define what check commands do. Changes here deserve human review. */
const CHECK_INPUTS = [
  ...ROOT_EXECUTABLES,
  "**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lock*",
  "**/vitest.config.*", "**/vite.config.*", "**/jest.config.*", "**/playwright.config.*", "**/tsconfig*.json",
  "**/Makefile", "**/pyproject.toml", "**/setup.cfg", "**/pytest.ini", "**/tox.ini", "**/Cargo.toml", "**/go.mod",
];

export const STANDING_LIMITATIONS = [
  "The hash chain detects edits to recorded events. It cannot detect a log that was deleted or regenerated wholesale by someone with write access to this machine.",
  "Working-tree changes come from git and include every change since the session started, including edits you made yourself. Files ignored by .gitignore are not compared.",
  "An approval request followed by execution shows that the action ran after the host asked for permission. It does not prove which person approved it.",
  "Acceptance checks run against the working tree when the receipt is generated, not at the moment each action ran.",
  "Command previews use heuristic secret redaction and may miss unusual credential formats.",
  "A signature identifies the user key that produced the receipt. The agent runs as the same OS user: file tools and shell commands naming the key are blocked, but a disguised shell command approved by you could still read it.",
];

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/**
 * Assemble a receipt from recorded events and freshly observed evidence.
 * Pure: the caller supplies check results and file digests.
 */
export function buildSessionReceipt(params: {
  sessionId: string;
  events: unknown[];
  contract: ContractInfo;
  checks: CheckResult[];
  gitChanges: GitChanges;
  hashFile: (projectRelativePath: string) => string | null;
  now?: Date;
}): SessionReceipt {
  const assessment = verifyAuditChain(params.events);
  const events = assessment.valid ? (params.events as AuditEvent[]) : [];

  const byCategory: Record<string, number> = {};
  const denied: SessionReceipt["denied"] = [];
  const approvalRequests: SessionReceipt["approvalRequests"] = [];
  const completedKeys = new Set<string>();
  const writtenPaths = new Set<string>();
  let requested = 0;
  let completed = 0;
  let failed = 0;

  for (const event of events) {
    const toolUseId = text(event.payload, "toolUseId");
    if (event.eventType === "tool.completed") {
      completed += 1;
      completedKeys.add(toolUseId ?? event.actionDigest ?? event.eventId);
      if (event.actionKind === "write" && event.target && text(event.payload, "category") === "write") {
        writtenPaths.add(event.target);
      }
    } else if (event.eventType === "tool.failed") {
      failed += 1;
    }
  }

  for (const event of events) {
    if (event.eventType !== "tool.requested") continue;
    requested += 1;
    const category = text(event.payload, "category") ?? "unknown";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    const tool = text(event.payload, "tool") ?? "unknown";
    if (event.policyOutcome === "DENY") {
      denied.push({ tool, target: event.target ?? "", reason: text(event.payload, "reason") ?? "", at: event.createdAt });
    } else if (event.policyOutcome === "REQUIRE_APPROVAL") {
      const key = text(event.payload, "toolUseId") ?? event.actionDigest ?? event.eventId;
      approvalRequests.push({
        tool,
        target: event.target ?? "",
        preview: text(event.payload, "commandPreview"),
        executed: completedKeys.has(key),
        at: event.createdAt,
      });
    }
  }

  const filesChanged = [...writtenPaths]
    .filter((path) => !path.startsWith("/") && !/^[A-Za-z]:/.test(path))
    .sort()
    .map((path) => ({ path, sha256: params.hashFile(path) }));

  const changes = params.gitChanges;
  const scope = params.contract.status === "loaded" ? params.contract.contract : null;
  // Changes the human chose to ignore are listed but cannot fail the scope check.
  const ignored = changes.available && scope ? changes.changed.filter((path) => matchesPatternList(path, scope.ignore)) : [];
  const outOfScope = changes.available && scope
    ? changes.changed.filter((path) =>
        !ignored.includes(path) && (!matchesPatternList(path, scope.write) || matchesPatternList(path, scope.protect)))
    : [];
  const checkInputsChanged = changes.available
    ? changes.changed.filter((path) => matchesPatternList(path, CHECK_INPUTS))
    : [];
  const plantedExecutables = checkInputsChanged.filter((path) => matchesPatternList(path, ROOT_EXECUTABLES));
  const notFromFileTools = changes.available ? changes.changed.filter((path) => !writtenPaths.has(path)) : [];

  let verdict: Verdict;
  let verdictReason: string;
  if (!assessment.valid) {
    verdict = "tampered";
    verdictReason = "The event log failed integrity verification: " + (assessment.reason ?? "unknown reason") + ".";
  } else if (!events.some((event) => event.eventType === "session.baseline")) {
    verdict = "unverified";
    verdictReason = "No session baseline was recorded, so there is nothing to verify.";
  } else if (params.contract.status !== "loaded") {
    verdict = "unverified";
    verdictReason = params.contract.status === "absent"
      ? "No session contract was defined, so actions were recorded but nothing was checked."
      : "The session contract is invalid, so no acceptance checks could run.";
  } else if (!changes.available) {
    verdict = "unverified";
    verdictReason = "Scope could not be verified from the working tree: " + changes.reason;
  } else if (outOfScope.length > 0) {
    verdict = "out_of_scope";
    verdictReason = "Files outside the contract's write scope changed during the session: " + outOfScope.slice(0, 3).join(", ") + (outOfScope.length > 3 ? " and " + (outOfScope.length - 3) + " more" : "") + ".";
  } else if (plantedExecutables.length > 0) {
    verdict = "unverified";
    verdictReason = "Executables in the project root changed during the session and could replace the commands the checks run: " + plantedExecutables.join(", ") + ".";
  } else if (params.checks.length === 0) {
    verdict = "unverified";
    verdictReason = "Acceptance checks were not run for this receipt.";
  } else if (params.checks.some((check) => check.status !== "passed")) {
    const failing = params.checks.filter((check) => check.status !== "passed").map((check) => check.id);
    verdict = "checks_failed";
    verdictReason = "Acceptance checks did not pass: " + failing.join(", ") + ".";
  } else {
    verdict = "verified";
    verdictReason = (params.checks.length === 1 ? "The acceptance check" : "All " + params.checks.length + " acceptance checks") + " passed against the current working tree, and every change stayed in scope.";
  }

  const last = events.at(-1);
  return {
    schemaVersion: "1.0",
    kind: "claude-code-session",
    recorderVersion: RECORDER_VERSION,
    sessionId: params.sessionId,
    workspaceId: events[0]?.workspaceId ?? null,
    generatedAt: (params.now ?? new Date()).toISOString(),
    firstEventAt: events[0]?.createdAt ?? null,
    lastEventAt: last?.createdAt ?? null,
    contract: params.contract.status === "loaded"
      ? { status: "loaded", digest: sha256Object(params.contract.contract), goal: params.contract.contract.goal, terms: params.contract.contract }
      : { status: params.contract.status, digest: null, goal: null, terms: null },
    chain: { ...assessment, headHash: last?.eventHash ?? null },
    summary: { requested, completed, failed, denied: denied.length, approvalRequested: approvalRequests.length, byCategory },
    denied,
    approvalRequests,
    filesChanged,
    workingTree: { ...changes, outOfScope, notFromFileTools, ignored },
    checkInputsChanged,
    checks: params.checks,
    verdict,
    verdictReason,
    limitations: STANDING_LIMITATIONS,
  };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "VERIFIED",
  checks_failed: "CHECKS FAILED",
  out_of_scope: "OUT OF SCOPE",
  unverified: "UNVERIFIED",
  tampered: "LOG INTEGRITY FAILURE",
};

export function renderReceiptMarkdown(receipt: SessionReceipt): string {
  const lines: string[] = [];
  lines.push("# Work Receipt: " + VERDICT_LABEL[receipt.verdict]);
  lines.push("");
  lines.push(receipt.verdictReason);
  lines.push("");
  lines.push("- Session: `" + receipt.sessionId + "`");
  lines.push("- Goal: " + (receipt.contract.goal ?? "_no contract_"));
  lines.push("- Window: " + (receipt.firstEventAt ?? "n/a") + " to " + (receipt.lastEventAt ?? "n/a"));
  lines.push("- Event log: " + (receipt.chain.valid ? "intact" : "FAILED") + ", " + receipt.chain.checkedEvents + " events, head `" + (receipt.chain.headHash?.slice(0, 16) ?? "none") + "`");
  lines.push("- Actions: " + receipt.summary.requested + " requested, " + receipt.summary.completed + " completed, " + receipt.summary.failed + " failed, " + receipt.summary.denied + " denied, " + receipt.summary.approvalRequested + " needed approval");
  lines.push("");

  if (receipt.checks.length > 0) {
    lines.push("## Acceptance checks");
    lines.push("");
    lines.push("| Check | Command | Result | Exit | Time |");
    lines.push("|---|---|---|---|---|");
    for (const check of receipt.checks) {
      lines.push("| " + check.description + " | `" + check.command + "` | " + check.status + " | " + (check.exitCode ?? "n/a") + " | " + Math.round(check.durationMs / 100) / 10 + "s |");
    }
    lines.push("");
  }

  if (receipt.checkInputsChanged.length > 0) {
    lines.push("## Review before trusting the checks");
    lines.push("");
    lines.push("These changed files can alter what the acceptance checks run. A passing check is only as trustworthy as these changes:");
    for (const path of receipt.checkInputsChanged) lines.push("- `" + path + "`");
    lines.push("");
  }

  lines.push("## Working tree since session start");
  lines.push("");
  if (!receipt.workingTree.available) {
    lines.push("Not available: " + receipt.workingTree.reason);
  } else if (receipt.workingTree.changed.length === 0) {
    lines.push("No files changed.");
  } else {
    for (const path of receipt.workingTree.changed) {
      const notes = [
        receipt.workingTree.outOfScope.includes(path) ? "OUT OF SCOPE" : null,
        receipt.workingTree.notFromFileTools.includes(path) ? "not changed by a file tool" : null,
        receipt.workingTree.ignored.includes(path) ? "ignored by contract" : null,
      ].filter(Boolean);
      lines.push("- `" + path + "`" + (notes.length ? " (" + notes.join(", ") + ")" : ""));
    }
  }
  if (receipt.workingTree.available && receipt.workingTree.contractChanged) {
    lines.push("");
    lines.push("Note: the session contract itself changed during this session.");
  }
  lines.push("");

  if (receipt.denied.length > 0) {
    lines.push("## Blocked actions");
    lines.push("");
    for (const entry of receipt.denied) lines.push("- " + entry.tool + " `" + entry.target + "`: " + entry.reason);
    lines.push("");
  }

  if (receipt.approvalRequests.length > 0) {
    lines.push("## Actions that required approval");
    lines.push("");
    for (const entry of receipt.approvalRequests) {
      lines.push("- " + entry.tool + " `" + (entry.preview ?? entry.target) + "`: " + (entry.executed ? "ran after the approval prompt" : "did not run"));
    }
    lines.push("");
  }

  if (receipt.filesChanged.length > 0) {
    lines.push("## Files changed by file tools");
    lines.push("");
    for (const file of receipt.filesChanged) lines.push("- `" + file.path + "` " + (file.sha256 ? "sha256 `" + file.sha256.slice(0, 16) + "…`" : "(no longer exists)"));
    lines.push("");
  }

  lines.push("## Limitations");
  lines.push("");
  for (const limitation of receipt.limitations) lines.push("- " + limitation);
  lines.push("");
  return lines.join("\n");
}

/** The first session.baseline event, if the log recorded one. */
export function baselineFromEvents(events: unknown[]): GitBaseline | null {
  for (const event of events) {
    const record = event as { eventType?: unknown; payload?: { baseline?: unknown } };
    if (record.eventType === "session.baseline" && record.payload?.baseline) {
      return record.payload.baseline as GitBaseline;
    }
  }
  return null;
}
