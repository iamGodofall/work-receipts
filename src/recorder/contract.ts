import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";

export const CONTRACT_FILE = "receipts.contract.json";
export const RECEIPTS_DIR = ".receipts";

/** Files that commonly hold credentials. Reads and writes are denied. */
export const DEFAULT_PROTECT = [
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
];

const DecisionSchema = z.enum(["allow", "ask", "deny"]);

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const list = <T extends z.ZodMiniType>(item: T, min: number, max: number) =>
  z.array(item).check(z.minLength(min), z.maxLength(max));

export const SessionCheckSchema = z.strictObject({
  id: z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  description: text(500),
  command: text(1000),
  timeoutSeconds: z._default(z.int().check(z.minimum(1), z.maximum(3600)), 300),
});

/**
 * A human-authored scope for one coding session. The agent can read this file
 * but the recorder denies any tool attempt to modify it. Uses zod/mini because
 * the Claude Code hook validates it on every tool call.
 */
export const SessionContractSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  goal: text(2000),
  write: list(text(256), 1, 100),
  protect: z._default(list(text(256), 0, 100), DEFAULT_PROTECT),
  shell: z._default(
    z.strictObject({
      allow: z._default(list(text(256), 0, 100), []),
      otherwise: z._default(DecisionSchema, "ask"),
    }),
    { allow: [], otherwise: "ask" as const },
  ),
  web: z._default(DecisionSchema, "allow"),
  mcp: z._default(DecisionSchema, "ask"),
  /**
   * Paths the human excludes from working-tree scope verification, such as
   * logs written by trusted tools. Ignored changes are still listed on the
   * receipt; they just cannot fail it.
   */
  ignore: z._default(list(text(256), 0, 50), []),
  checks: list(SessionCheckSchema, 1, 20),
});

export type SessionContract = z.infer<typeof SessionContractSchema>;
export type SessionCheck = z.infer<typeof SessionCheckSchema>;

export type ContractLoadResult =
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "loaded"; contract: SessionContract; raw: unknown };

type Issue = {
  path: PropertyKey[];
  message: string;
  code?: string;
  keys?: string[];
  expected?: unknown;
  origin?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  values?: unknown[];
};

/** A field name reduced to identifier characters, at most 40 of them. */
function safeName(key: unknown): string {
  const cleaned = String(key).replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40);
  return cleaned || "?";
}

const MAX_ISSUE_TEXT = 600;

/** zod/mini ships no messages ("Invalid input"), so explain from the issue code and schema limits only. */
function explain(issue: Issue): string {
  const count = (n: unknown, one: string, many: string) => String(n) + " " + (n === 1 ? one : many);
  switch (issue.code) {
    case "unrecognized_keys": {
      // Key names are chosen by whoever wrote the file and reach the model's context: keep them short and inert.
      const keys = issue.keys ?? [];
      const shown = keys.slice(0, 3).map(safeName).join(", ");
      return "unknown field" + (keys.length > 1 ? "s " : " ") + shown + (keys.length > 3 ? " (+" + (keys.length - 3) + " more)" : "");
    }
    case "invalid_type":
      return "expected " + String(issue.expected);
    case "too_small":
      return issue.origin === "array" ? "needs at least " + count(issue.minimum, "entry", "entries")
        : issue.origin === "string" ? (issue.minimum === 1 ? "must not be empty" : "must be at least " + count(issue.minimum, "character", "characters"))
        : "must be at least " + String(issue.minimum);
    case "too_big":
      return issue.origin === "array" ? "allows at most " + count(issue.maximum, "entry", "entries")
        : issue.origin === "string" ? "must be at most " + count(issue.maximum, "character", "characters")
        : "must be at most " + String(issue.maximum);
    case "invalid_format":
      return "has an invalid format (check ids use lowercase letters, digits, and hyphens)";
    case "invalid_value":
      return "must be one of " + (issue.values ?? []).map((value) => JSON.stringify(value)).join(", ");
    default:
      return issue.message.slice(0, 120);
  }
}

/**
 * Names the fields a human must fix, e.g. `checks[0].id`. Only field names and
 * the validator's fixed messages are included, never contract values, because
 * this text reaches the model's context and every receipt.
 */
export function describeIssues(issues: readonly Issue[], limit = 4): string {
  const parts = issues.slice(0, limit).map((issue) => {
    const where = issue.path.reduce<string>(
      (acc, key) => (typeof key === "number" ? acc + "[" + key + "]" : acc ? acc + "." + safeName(key) : safeName(key)),
      "",
    );
    return (where || "(top level)") + ": " + explain(issue);
  });
  const more = issues.length > limit ? " (+" + (issues.length - limit) + " more)" : "";
  const text = parts.join("; ") + more + ".";
  return text.length > MAX_ISSUE_TEXT ? text.slice(0, MAX_ISSUE_TEXT) + "…" : text;
}

export function loadContract(projectDir: string): ContractLoadResult {
  const path = join(projectDir, CONTRACT_FILE);
  if (!existsSync(path)) return { status: "absent" };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = SessionContractSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "invalid", message: CONTRACT_FILE + " failed schema validation: " + describeIssues(parsed.error.issues) };
    }
    return { status: "loaded", contract: parsed.data, raw };
  } catch {
    return { status: "invalid", message: CONTRACT_FILE + " is not valid JSON." };
  }
}

export const STARTER_CONTRACT = {
  schemaVersion: "1.0",
  goal: "Describe the outcome this session must deliver.",
  write: ["src/**", "app/**", "docs/**"],
  protect: DEFAULT_PROTECT,
  shell: {
    // Read-only commands, so routine exploration does not need approval.
    // Exact commands: `git diff*` would also match `git diff --output=<file>`, which overwrites files.
    allow: ["npm test", "npm run typecheck", "npm run build", "ls", "pwd", "git status", "git diff", "git diff --stat", "git log --oneline"],
    otherwise: "ask",
  },
  web: "allow",
  mcp: "ask",
  checks: [
    { id: "tests", description: "Unit tests pass", command: "npm test", timeoutSeconds: 300 },
  ],
};
