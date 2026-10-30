import type { ObservedAction } from "./classify";
import { CONTRACT_FILE, DEFAULT_PROTECT, RECEIPTS_DIR, type SessionContract } from "./contract";
import { matchesPatternList } from "./glob";
import { keyDir } from "./signing";

export type SessionDecision = "allow" | "ask" | "deny";

export type SessionPolicyResult = {
  decision: SessionDecision;
  reason: string;
};

/** The recorder's own evidence and the human-authored scope are never agent-writable. */
const RECORDER_OWNED = [RECEIPTS_DIR, RECEIPTS_DIR + "/**", CONTRACT_FILE];

/**
 * Characters that let one command chain, substitute, group, splat, expand, or
 * redirect into another in POSIX shells, cmd.exe, or PowerShell. Any of them,
 * or any non-ASCII character, disqualifies a command from the allow list.
 */
const SHELL_COMPOSITION = /[;&|`$<>\r\n(){}[\]@,#%^!*?~"'\\]|[^\x20-\x7e]/;

const KEY_DIR_NAME = ".work-receipts";

function touchesRecorderFiles(command: string): boolean {
  const lowered = command.toLowerCase();
  return lowered.includes(RECEIPTS_DIR) || lowered.includes(CONTRACT_FILE) || lowered.includes(KEY_DIR_NAME) || lowered.includes("signing-key");
}

function normalizedAbsolute(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when a file-tool target resolves into the user's signing-key directory. */
function touchesSigningKey(action: ObservedAction): boolean {
  const keyRoot = normalizedAbsolute(keyDir());
  return paths(action).some((path) => {
    const candidate = normalizedAbsolute(path);
    return candidate === keyRoot || candidate.startsWith(keyRoot + "/") || candidate.split("/").includes(KEY_DIR_NAME);
  });
}

/** Allow-list entries match the whole command; `*` matches any run of characters. */
export function commandMatches(command: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp("^" + source + "$").test(command);
  });
}

/**
 * Commands that are never acceptable inside a scoped session, whatever the
 * allow list says: download-and-execute, evaluating strings as code, and
 * wiping the filesystem root or home directory.
 */
const DANGEROUS_COMMANDS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|iex|invoke-expression|powershell|pwsh|python3?|node)\b/i,
    reason: "Downloading and executing code in one step is not permitted.",
  },
  { pattern: /(^|[\s;&|(])(iex|invoke-expression)(\s|$|\()/i, reason: "Evaluating strings as PowerShell code is not permitted." },
  {
    pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*("|')?(\/|~|\$home|\*)("|')?(\s|$|[);&|`])/i,
    reason: "Recursively deleting the filesystem root, home directory, or everything in the current directory is not permitted.",
  },
  {
    pattern: /\b(remove-item|rd|rmdir)\b[^\n]*(-recurse|\/s)[^\n]*\s("|')?([a-z]:\\?|\/|~|\$home)("|')?(\s|$)/i,
    reason: "Recursively deleting a drive root or home directory is not permitted.",
  },
];

export function dangerousCommandReason(command: string): string | null {
  return DANGEROUS_COMMANDS.find((rule) => rule.pattern.test(command))?.reason ?? null;
}

/** True when any word in a shell command names a file the contract protects. */
export function referencesProtectedFile(command: string, protect: readonly string[]): boolean {
  return command
    .split(/[\s"'`=;|&<>(),]+/)
    .map((token) => token.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((token) => token.length > 0)
    .some((token) => matchesPatternList(token, protect));
}

function decide(decision: SessionDecision, reason: string): SessionPolicyResult {
  return { decision, reason };
}

/** Every project-relative spelling of the target: lexical and, if different, resolved. */
function paths(action: ObservedAction): string[] {
  return action.realTarget ? [action.target, action.realTarget] : [action.target];
}

function anyMatch(action: ObservedAction, patterns: readonly string[]): boolean {
  return paths(action).some((path) => matchesPatternList(path, patterns));
}

function allMatch(action: ObservedAction, patterns: readonly string[]): boolean {
  return paths(action).every((path) => matchesPatternList(path, patterns));
}

/**
 * Checks that hold with or without a contract. A "deny" here protects the
 * recorder itself and must be enforced even if recording fails.
 */
export function evaluateInvariants(action: ObservedAction): SessionPolicyResult | null {
  if ((action.category === "read" || action.category === "write") && action.suspicious) {
    return decide("deny", "Path form not permitted (" + action.suspicious + ").");
  }
  if ((action.category === "read" || action.category === "write") && touchesSigningKey(action)) {
    return decide("deny", "The receipt signing key is never accessible to the agent.");
  }
  if (action.category === "write" && anyMatch(action, RECORDER_OWNED)) {
    return decide("deny", "The receipt log and session contract cannot be modified by the agent.");
  }
  if (action.category === "shell" && action.command && touchesRecorderFiles(action.command)) {
    return decide("deny", "Shell commands may not reference the receipt log or session contract.");
  }
  return null;
}

/**
 * Decide whether a tool call may proceed. "allow" means the recorder adds no
 * objection; the host's own permission settings still apply. The decision is
 * made from the human-authored contract, never from model output.
 */
export function evaluateSessionAction(
  contract: SessionContract | null,
  action: ObservedAction,
): SessionPolicyResult {
  const invariant = evaluateInvariants(action);
  if (invariant) return invariant;

  // Without a contract the recorder observes and protects its own files only.
  if (!contract) return decide("allow", "No session contract: recording only.");

  switch (action.category) {
    case "read":
      if (anyMatch(action, contract.protect)) {
        return decide("deny", "This file is protected by the session contract.");
      }
      if (action.exposesProtected) {
        return decide(
          "deny",
          "This search would read the protected file " + action.exposesProtected +
            ". Add it to .gitignore or search a narrower folder.",
        );
      }
      if (action.outsideProject) return decide("ask", "Read outside the project directory.");
      return decide("allow", "Read within the project.");

    case "write":
      if (action.outsideProject) return decide("deny", "Writes outside the project directory are not permitted.");
      if (anyMatch(action, contract.protect)) {
        return decide("deny", "This file is protected by the session contract.");
      }
      if (!allMatch(action, contract.write)) {
        return decide("deny", "This path is outside the session contract's write scope.");
      }
      return decide("allow", "Write within the contract's write scope.");

    case "shell": {
      const command = (action.command ?? "").trim();
      const dangerous = dangerousCommandReason(command);
      if (dangerous) return decide("deny", dangerous);
      if (referencesProtectedFile(command, contract.protect)) {
        return decide("deny", "Shell commands may not reference files protected by the session contract.");
      }
      const composable = SHELL_COMPOSITION.test(command);
      if (!composable && commandMatches(command, contract.shell.allow)) {
        return decide("allow", "Command matches the contract's shell allow list.");
      }
      return decide(
        contract.shell.otherwise,
        composable
          ? "Commands with chaining, substitution, grouping, quoting, or wildcard characters always fall back to the contract default."
          : "Command is not on the contract's shell allow list.",
      );
    }

    case "web":
      return decide(contract.web, "Web access follows the contract's web setting.");

    case "mcp":
      return decide(contract.mcp, "MCP tool calls follow the contract's mcp setting.");

    case "unknown":
      return decide(contract.mcp === "deny" ? "deny" : "ask", "Unrecognised tool; a human must approve it.");

    case "internal":
      return decide("allow", "Host-internal tool with no direct file, shell, or network effect.");
  }
}

/** With an unreadable contract: reads stay possible except credentials; everything else is denied. */
export function evaluateWithInvalidContract(action: ObservedAction, message: string): SessionPolicyResult {
  const invariant = evaluateInvariants(action);
  if (invariant) return invariant;
  if (action.category === "internal") return decide("allow", message);
  if (action.category === "read" && !action.outsideProject && !anyMatch(action, DEFAULT_PROTECT)) {
    return decide("allow", message + " Reads remain allowed.");
  }
  return decide("deny", message + " A human must fix it before other actions run.");
}
