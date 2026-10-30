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

export function loadContract(projectDir: string): ContractLoadResult {
  const path = join(projectDir, CONTRACT_FILE);
  if (!existsSync(path)) return { status: "absent" };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = SessionContractSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "invalid", message: CONTRACT_FILE + " failed schema validation." };
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
    allow: ["npm test", "npm run typecheck", "npm run build", "ls", "ls *", "pwd", "git status", "git diff*", "git log*"],
    otherwise: "ask",
  },
  web: "allow",
  mcp: "ask",
  checks: [
    { id: "tests", description: "Unit tests pass", command: "npm test", timeoutSeconds: 300 },
  ],
};
