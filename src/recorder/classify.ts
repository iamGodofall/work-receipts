import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ActionKind } from "../core/contracts";

export type ActionCategory = "read" | "write" | "shell" | "web" | "mcp" | "internal" | "unknown";

export type ObservedAction = {
  category: ActionCategory;
  actionKind: ActionKind;
  /** Project-relative forward-slash path, URL, or a category label. */
  target: string;
  /** Project-relative form of the resolved real path, when it differs from `target`. */
  realTarget?: string;
  /** True when the lexical or the real path resolves outside the project directory. */
  outsideProject: boolean;
  /** Set when the path uses a form that can alias another file. Always denied. */
  suspicious?: string;
  /**
   * For content searches over a directory: a protected file inside it that the
   * search would read (one that is not gitignored). Set by the hook, not here.
   */
  exposesProtected?: string;
  /** Shell command text, only for the shell category. */
  command?: string;
};

const READ_TOOLS: Record<string, string> = { Read: "file_path", Glob: "path", Grep: "path", LS: "path", NotebookRead: "notebook_path" };
const WRITE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const PATH_KEYS = ["file_path", "notebook_path", "path"];
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Host tools with no direct file, shell, or network effect. Anything else is "unknown". */
const INERT_TOOLS = new Set([
  "Agent", "Task", "TodoWrite", "Skill", "ToolSearch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "ListAgents", "SendMessage", "TaskOutput", "TaskStop", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Detect path spellings that Windows (and some other filesystems) treat as a
 * different name for the same file, so lexical glob checks would not apply.
 */
export function aliasingReason(rawPath: string): string | undefined {
  if (/^(\\\\|\/\/)[?.][\\/]/.test(rawPath)) return "device or long-path prefix";
  const withoutDrive = rawPath.replace(/^[A-Za-z]:/, "");
  if (withoutDrive.includes(":")) return "alternate data stream";
  const segments = rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") continue;
    if (/[. ]$/.test(segment)) return "trailing dot or space";
    if (/~\d/.test(segment)) return "8.3 short name";
  }
  return undefined;
}

/** Resolve symlinks and junctions through the deepest existing ancestor. */
function realPathOf(absolute: string): string {
  let current = absolute;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]/, ""));
    current = parent;
  }
  try {
    return resolve(realpathSync.native(current), ...rest);
  } catch {
    return absolute;
  }
}

function relativeTo(projectReal: string, absolute: string): { path: string; outside: boolean } {
  const rel = relative(projectReal, absolute).replace(/\\/g, "/");
  const outside = rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  return { path: outside ? absolute.replace(/\\/g, "/") : rel || ".", outside };
}

export function toProjectPath(projectDir: string, filePath: string): { path: string; outside: boolean; realPath?: string } {
  const projectAbs = resolve(projectDir);
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(projectAbs, filePath);
  const lexical = relativeTo(projectAbs, absolute);
  const real = relativeTo(realPathOf(projectAbs), realPathOf(absolute));
  return {
    path: lexical.path,
    outside: lexical.outside || real.outside,
    ...(real.path !== lexical.path ? { realPath: real.path } : {}),
  };
}

function webTarget(raw: string | undefined): string {
  if (!raw) return "web";
  for (const candidate of [raw, "https://" + raw]) {
    try {
      const url = new URL(candidate);
      if (url.host) return url.protocol + "//" + url.host + url.pathname;
    } catch {
      // Try the next form.
    }
  }
  return "web";
}

/** Map a Claude Code tool call onto the domain's action vocabulary. */
export function classifyToolCall(
  projectDir: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): ObservedAction {
  const fileKey = READ_TOOLS[toolName] ?? WRITE_TOOLS[toolName];
  if (fileKey) {
    const isWrite = toolName in WRITE_TOOLS;
    const raw = stringField(toolInput, fileKey) ?? ".";
    const otherPaths = PATH_KEYS
      .filter((key) => key !== fileKey)
      .map((key) => stringField(toolInput, key))
      .filter((value): value is string => value !== undefined && value !== raw);
    const { path, outside, realPath } = toProjectPath(projectDir, raw);
    const suspicious = otherPaths.length > 0 ? "conflicting path parameters" : aliasingReason(raw);
    return {
      category: isWrite ? "write" : "read",
      actionKind: isWrite ? "write" : "read",
      target: path,
      outsideProject: outside,
      ...(realPath ? { realTarget: realPath } : {}),
      ...(suspicious ? { suspicious } : {}),
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    return {
      category: "shell",
      actionKind: "execute_code",
      target: "shell",
      outsideProject: false,
      command: stringField(toolInput, "command") ?? "",
    };
  }

  if (toolName === "WebFetch") {
    return { category: "web", actionKind: "read", target: webTarget(stringField(toolInput, "url")), outsideProject: false };
  }
  if (toolName === "WebSearch") {
    return { category: "web", actionKind: "read", target: "web:search", outsideProject: false };
  }

  if (toolName.startsWith("mcp__")) {
    return { category: "mcp", actionKind: "execute_code", target: toolName.slice(0, 512), outsideProject: false };
  }

  if (INERT_TOOLS.has(toolName)) {
    return { category: "internal", actionKind: "read", target: "tool:" + toolName, outsideProject: false };
  }

  // An unrecognised tool that carries a command is treated as a shell, so it
  // gets the full shell policy rather than a generic approval prompt.
  const command = stringField(toolInput, "command");
  if (command !== undefined) {
    return { category: "shell", actionKind: "execute_code", target: "shell", outsideProject: false, command };
  }
  return { category: "unknown", actionKind: "execute_code", target: ("tool:" + toolName).slice(0, 512), outsideProject: false };
}
