import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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

export const SessionCheckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1).max(500),
  command: z.string().min(1).max(1000),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
}).strict();

/**
 * A human-authored scope for one coding session. The agent can read this file
 * but the recorder denies any tool attempt to modify it.
 */
export const SessionContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  goal: z.string().min(1).max(2000),
  write: z.array(z.string().min(1).max(256)).min(1).max(100),
  protect: z.array(z.string().min(1).max(256)).max(100).default(DEFAULT_PROTECT),
  shell: z.object({
    allow: z.array(z.string().min(1).max(256)).max(100).default([]),
    otherwise: DecisionSchema.default("ask"),
  }).strict().default({ allow: [], otherwise: "ask" }),
  web: DecisionSchema.default("allow"),
  mcp: DecisionSchema.default("ask"),
  /**
   * Paths the human excludes from working-tree scope verification, such as
   * logs written by trusted tools. Ignored changes are still listed on the
   * receipt; they just cannot fail it.
   */
  ignore: z.array(z.string().min(1).max(256)).max(50).default([]),
  checks: z.array(SessionCheckSchema).min(1).max(20),
}).strict();

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
