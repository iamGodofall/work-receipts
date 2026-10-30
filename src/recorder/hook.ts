import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256Object } from "../core/integrity";
import { classifyToolCall } from "./classify";
import { CONTRACT_FILE, loadContract } from "./contract";
import { captureBaseline, searchableFiles } from "./git";
import { matchesPatternList } from "./glob";
import { evaluateSessionAction, evaluateWithInvalidContract, type SessionPolicyResult } from "./policy";
import { appendEvent, redactPreview, type NewEvent } from "./store";

type HookInput = {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  tool_response?: unknown;
  agent_type?: unknown;
  source?: unknown;
};

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "ask" | "deny";
    permissionDecisionReason: string;
  };
};

const OUTCOME = { allow: "ALLOW", ask: "REQUIRE_APPROVAL", deny: "DENY" } as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The project root. Claude Code sets CLAUDE_PROJECT_DIR for hooks; otherwise
 * walk up from cwd to the nearest contract or git root so a `cd` into a
 * subdirectory cannot hide the contract.
 */
export function resolveProjectDir(env: Record<string, string | undefined>, cwd: unknown): string {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  const start = resolve(typeof cwd === "string" ? cwd : process.cwd());
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONTRACT_FILE)) || existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

function output(decision: "ask" | "deny", reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: "Work Receipts: " + reason,
    },
  };
}

export type HookMode = "pre" | "post" | "failure";

type SessionStartOutput = {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
};

/** Tell the model its scope up front so it does not waste turns on denied actions. */
export function describeScope(projectDir: string): string {
  const loaded = loadContract(projectDir);
  if (loaded.status === "absent") {
    return "Work Receipts is recording this session's tool calls. No receipts.contract.json exists, so nothing is restricted beyond the recorder's own files. The user can run /receipt-init to define a scope.";
  }
  if (loaded.status === "invalid") {
    return "Work Receipts: " + loaded.message + " Until the user fixes it, only reads are allowed. You cannot edit the contract.";
  }
  const c = loaded.contract;
  return [
    "Work Receipts session contract (written by the user; you cannot modify it):",
    "- Goal: " + c.goal,
    "- You may change only files matching: " + c.write.join(", "),
    "- Protected (no read or write): " + c.protect.filter((pattern) => !pattern.startsWith("!")).join(", "),
    "- Pre-approved shell commands: " + (c.shell.allow.length ? c.shell.allow.join(", ") : "none") + "; other commands: " + c.shell.otherwise,
    "- Acceptance checks run at the end: " + c.checks.map((check) => check.command).join("; "),
    "Any file outside the write scope that changes by any means, including shell commands, fails the receipt. Do not claim the work is done or verified; the receipt verdict decides that.",
  ].join("\n");
}

/** Record the git baseline before any tool runs and give the model its scope. */
export function handleSessionStart(input: HookInput, env: Record<string, string | undefined>): SessionStartOutput {
  const projectDir = resolveProjectDir(env, input.cwd);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown-session";
  appendEvent(projectDir, sessionId, {
    actorSubject: "work-receipts",
    eventType: "session.started",
    payload: { source: typeof input.source === "string" ? input.source.slice(0, 32) : "unknown" },
  }, () => ({
    actorSubject: "work-receipts",
    eventType: "session.baseline",
    payload: { baseline: captureBaseline(projectDir) },
  }));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: describeScope(projectDir) } };
}

/**
 * Handle one Claude Code hook invocation. Returns the JSON to print, or null
 * when the recorder has no objection and the host's own permissions apply.
 * Throws only for post/failure logging errors; pre always returns a decision.
 */
export function handleHook(mode: HookMode, input: HookInput, env: Record<string, string | undefined>): HookOutput | null {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown-session";
  const projectDir = resolveProjectDir(env, input.cwd);
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "unknown";
  const toolInput = asRecord(input.tool_input);
  const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id.slice(0, 128) : undefined;

  const action = classifyToolCall(projectDir, toolName, toolInput);
  // Digest the redacted command so low-entropy secrets cannot be recovered from the log.
  const digestInput = action.command !== undefined ? { ...toolInput, command: redactPreview(action.command, 100000) } : toolInput;
  const common = {
    // Subagent tool calls fire the same hooks; attribute them.
    actorSubject: typeof input.agent_type === "string"
      ? ("claude-code:" + input.agent_type.replace(/[^A-Za-z0-9:_-]/g, "")).slice(0, 128)
      : "claude-code",
    actionKind: action.actionKind,
    target: action.target.slice(0, 512),
    actionDigest: sha256Object({ tool: toolName, input: digestInput }),
  };

  // Snapshot the working tree once, before the first recorded action.
  const baseline = (): NewEvent => ({
    actorSubject: "work-receipts",
    eventType: "session.baseline",
    payload: { baseline: captureBaseline(projectDir) },
  });

  if (mode !== "pre") {
    appendEvent(projectDir, sessionId, {
      ...common,
      eventType: mode === "post" ? "tool.completed" : "tool.failed",
      resultStatus: mode === "post" ? "success" : "failed",
      payload: {
        tool: toolName,
        category: action.category,
        ...(toolUseId ? { toolUseId } : {}),
        ...(mode === "post" ? { outputDigest: sha256Object(input.tool_response ?? null) } : {}),
      },
    }, baseline);
    return null;
  }

  const loaded = loadContract(projectDir);
  if (loaded.status === "loaded" && toolName === "Grep" && action.category === "read" && !action.outsideProject) {
    // A content search over a folder reads every non-ignored file in it.
    const exposed = searchExposure(projectDir, action.target, loaded.contract.protect);
    if (exposed) action.exposesProtected = exposed;
  }
  const result: SessionPolicyResult = loaded.status === "invalid"
    ? evaluateWithInvalidContract(action, loaded.message)
    : evaluateSessionAction(loaded.status === "loaded" ? loaded.contract : null, action);

  try {
    appendEvent(projectDir, sessionId, {
      ...common,
      eventType: "tool.requested",
      policyOutcome: OUTCOME[result.decision],
      ...(result.decision === "deny" ? { resultStatus: "denied" as const } : {}),
      payload: {
        tool: toolName,
        category: action.category,
        reason: result.reason,
        contract: loaded.status,
        ...(toolUseId ? { toolUseId } : {}),
        ...(action.realTarget ? { realTarget: action.realTarget.slice(0, 512) } : {}),
        ...(action.command !== undefined ? { commandPreview: redactPreview(action.command) } : {}),
      },
    }, baseline);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // A denial is enforced whether or not it could be logged. Under a contract,
    // an action that cannot be recorded must not run.
    if (result.decision === "deny") return output("deny", result.reason + " (Also not recorded: " + message + ")");
    if (loaded.status !== "absent") return output("deny", "Could not record this action (" + message + ").");
    return result.decision === "ask" ? output("ask", result.reason) : null;
  }

  return result.decision === "allow" ? null : output(result.decision, result.reason);
}

export function main(argv: string[]): void {
  const mode = argv[2];
  if (mode === "session-start") {
    try {
      const input = asRecord(JSON.parse(readFileSync(0, "utf8"))) as HookInput;
      process.stdout.write(JSON.stringify(handleSessionStart(input, process.env)));
    } catch (error) {
      process.stderr.write("Work Receipts could not start recording: " + (error instanceof Error ? error.message : "unknown error") + "\n");
    }
    return;
  }
  if (mode !== "pre" && mode !== "post" && mode !== "failure") {
    process.stderr.write("Usage: hook.js session-start|pre|post|failure\n");
    process.exitCode = 1;
    return;
  }

  let input: HookInput = {};
  try {
    input = asRecord(JSON.parse(readFileSync(0, "utf8"))) as HookInput;
  } catch {
    // Unparseable input is classified as an unknown tool, which a contract puts behind approval.
  }

  try {
    const result = handleHook(mode, input, process.env);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write("Work Receipts recorder error: " + message + "\n");
    if (mode === "pre") {
      process.stdout.write(JSON.stringify(output("deny", "Recorder failure (" + message + ").")));
    }
  }
}

/** The first protected file a content search over `target` would read, if any. */
export function searchExposure(projectDir: string, target: string, protect: readonly string[]): string | null {
  let isDirectory = false;
  try {
    isDirectory = statSync(join(projectDir, target)).isDirectory();
  } catch {
    return null;
  }
  if (!isDirectory) return null;
  return searchableFiles(projectDir, target).find((path) => matchesPatternList(path, protect)) ?? null;
}
