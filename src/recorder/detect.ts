import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROTECT } from "./contract";

/**
 * Proposes a starter session contract from the project's own files, so the
 * first receipt reflects the project's real checks instead of failing on an
 * npm default that does not exist. Everything here is a proposal: the human
 * reviews and edits the contract, and nothing detected grants a permission
 * the host would not.
 */

export type ProjectReader = {
  /** True when a project-relative file or directory exists. */
  exists(path: string): boolean;
  /** Text of a project-relative file, or null when it is missing or unreadable. */
  read(path: string): string | null;
  /** Names of top-level directories. */
  topLevelDirs(): string[];
};

export type ProposedCheck = { id: string; description: string; command: string; timeoutSeconds: number };

export type ProjectProposal = {
  /** Human-readable names of what was recognised, e.g. "Node.js (pnpm)". */
  detected: string[];
  checks: ProposedCheck[];
  write: string[];
  shellAllow: string[];
  /** Things the human should know before relying on the proposal. */
  notes: string[];
};

/** Fails on purpose, so an unconfigured contract can never yield a verified receipt. */
export const PLACEHOLDER_CHECK: ProposedCheck = {
  id: "replace-me",
  description: "Placeholder: replace with a command that proves the work is done",
  command: "exit 1",
  timeoutSeconds: 60,
};

/** Read-only commands pre-approved so routine exploration needs no prompt. */
// Exact commands only: `git diff*` would also match `git diff --output=<file>`, which overwrites files.
export const READ_ONLY_SHELL = ["ls", "pwd", "git status", "git diff", "git diff --stat", "git diff --cached", "git log --oneline", "git log --oneline -n 20"];

/** Conventional source, test, and documentation folders, in display order. */
const SOURCE_DIRS = [
  "src", "app", "lib", "pages", "components", "packages", "apps",
  "cmd", "internal", "pkg", "crates", "include",
  "test", "tests", "__tests__", "spec", "e2e", "docs",
];

/** Same characters the policy refuses on the allow list; detected commands must be clean. */
const UNSAFE_COMMAND = /[;&|`$<>\r\n(){}[\]@,#%^!*?~"'\\]|[^\x20-\x7e]/;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function packageManager(reader: ProjectReader): PackageManager {
  if (reader.exists("pnpm-lock.yaml")) return "pnpm";
  if (reader.exists("yarn.lock")) return "yarn";
  if (reader.exists("bun.lock") || reader.exists("bun.lockb")) return "bun";
  return "npm";
}

function scriptCommand(manager: PackageManager, script: string): string {
  if (script === "test" && manager !== "bun") return manager + " test";
  return manager + " run " + script;
}

/** npm's generated placeholder, which always fails. */
function isPlaceholderTestScript(body: string): boolean {
  return /no test specified/i.test(body);
}

function nodeChecks(reader: ProjectReader, notes: string[]): { name: string; checks: ProposedCheck[] } | null {
  const text = reader.read("package.json");
  if (text === null) return null;
  let scripts: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "scripts" in parsed) {
      const value = (parsed as { scripts: unknown }).scripts;
      if (value && typeof value === "object") scripts = value as Record<string, unknown>;
    }
  } catch {
    notes.push("package.json is not valid JSON, so no npm scripts were detected.");
  }
  const manager = packageManager(reader);
  const has = (name: string) => typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0;
  const checks: ProposedCheck[] = [];
  const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find(has);
  if (typecheck) checks.push({ id: "typecheck", description: "Type check passes", command: scriptCommand(manager, typecheck), timeoutSeconds: 300 });
  if (has("lint")) checks.push({ id: "lint", description: "Lint is clean", command: scriptCommand(manager, "lint"), timeoutSeconds: 300 });
  if (has("test")) {
    if (isPlaceholderTestScript(scripts.test as string)) {
      notes.push("package.json has npm's placeholder test script, which always fails; it was not used as a check.");
    } else {
      checks.push({ id: "tests", description: "Tests pass", command: scriptCommand(manager, "test"), timeoutSeconds: 600 });
    }
  }
  if (has("build")) checks.push({ id: "build", description: "Production build succeeds", command: scriptCommand(manager, "build"), timeoutSeconds: 900 });
  return { name: "Node.js (" + manager + ")", checks };
}

function pythonChecks(reader: ProjectReader): { name: string; checks: ProposedCheck[] } | null {
  const pyproject = reader.read("pyproject.toml") ?? "";
  const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini"];
  if (!markers.some((file) => reader.exists(file))) return null;
  const runner = reader.exists("uv.lock") ? "uv run " : reader.exists("poetry.lock") ? "poetry run " : "python -m ";
  const usesPytest = reader.exists("pytest.ini") || /\bpytest\b/.test(pyproject) || /\bpytest\b/.test(reader.read("requirements.txt") ?? "")
    || /\bpytest\b/.test(reader.read("setup.cfg") ?? "") || reader.exists("tests") || reader.exists("conftest.py");
  const checks: ProposedCheck[] = [];
  if (/\[tool\.ruff/.test(pyproject)) {
    checks.push({ id: "lint", description: "Ruff lint is clean", command: runner === "python -m " ? "python -m ruff check" : runner + "ruff check", timeoutSeconds: 300 });
  }
  if (/\[tool\.mypy/.test(pyproject)) {
    checks.push({ id: "typecheck", description: "Mypy type check passes", command: runner === "python -m " ? "python -m mypy" : runner + "mypy", timeoutSeconds: 600 });
  }
  if (usesPytest) checks.push({ id: "tests", description: "Tests pass", command: runner + "pytest", timeoutSeconds: 600 });
  return { name: "Python", checks };
}

function rustChecks(reader: ProjectReader): { name: string; checks: ProposedCheck[] } | null {
  if (!reader.exists("Cargo.toml")) return null;
  return {
    name: "Rust (cargo)",
    checks: [{ id: "tests", description: "Cargo tests pass", command: "cargo test", timeoutSeconds: 900 }],
  };
}

function goChecks(reader: ProjectReader): { name: string; checks: ProposedCheck[] } | null {
  if (!reader.exists("go.mod")) return null;
  return {
    name: "Go",
    checks: [
      { id: "vet", description: "go vet is clean", command: "go vet ./...", timeoutSeconds: 300 },
      { id: "tests", description: "Go tests pass", command: "go test ./...", timeoutSeconds: 900 },
    ],
  };
}

function makeChecks(reader: ProjectReader): { name: string; checks: ProposedCheck[] } | null {
  const makefile = reader.read("Makefile") ?? reader.read("makefile");
  if (makefile === null || !/^test\s*:/m.test(makefile)) return null;
  return { name: "Makefile", checks: [{ id: "tests", description: "make test passes", command: "make test", timeoutSeconds: 900 }] };
}

/** Give each check a unique, schema-valid id when several ecosystems propose the same one. */
function uniqueIds(checks: ProposedCheck[]): ProposedCheck[] {
  const seen = new Map<string, number>();
  return checks.map((check) => {
    const count = (seen.get(check.id) ?? 0) + 1;
    seen.set(check.id, count);
    return count === 1 ? check : { ...check, id: (check.id + "-" + count).slice(0, 64) };
  });
}

export function proposeContract(reader: ProjectReader): ProjectProposal {
  const notes: string[] = [];
  const detected: string[] = [];
  let checks: ProposedCheck[] = [];

  for (const found of [nodeChecks(reader, notes), pythonChecks(reader), rustChecks(reader), goChecks(reader)]) {
    if (!found) continue;
    detected.push(found.name);
    checks.push(...found.checks);
  }
  // A Makefile test target is a fallback, not an addition to a recognised toolchain.
  if (checks.length === 0) {
    const make = makeChecks(reader);
    if (make) {
      detected.push(make.name);
      checks.push(...make.checks);
    }
  }

  checks = uniqueIds(checks.filter((check) => !UNSAFE_COMMAND.test(check.command))).slice(0, 20);
  if (checks.length === 0) {
    checks = [PLACEHOLDER_CHECK];
    notes.push("No test, lint, type-check, or build command was found. The placeholder check fails on purpose until you replace it.");
  }

  const dirs = new Set(reader.topLevelDirs());
  let write = SOURCE_DIRS.filter((dir) => dirs.has(dir)).map((dir) => dir + "/**");
  if (write.length === 0) {
    write = ["src/**"];
    notes.push("No conventional source folder was found; the write scope defaults to src/**. Edit it to match your layout.");
  }
  notes.push("Root files such as package.json, lockfiles, and CI config are outside the write scope, so the agent cannot change what the checks run.");

  const shellAllow = [...new Set([...checks.filter((check) => check !== PLACEHOLDER_CHECK).map((check) => check.command), ...READ_ONLY_SHELL])];

  return { detected, checks, write, shellAllow, notes };
}

/** Starter contract JSON built from a proposal and an optional goal. */
export function contractFromProposal(proposal: ProjectProposal, goal?: string) {
  return {
    schemaVersion: "1.0",
    goal: goal && goal.trim() ? goal.trim().slice(0, 2000) : "Describe the outcome this session must deliver.",
    write: proposal.write,
    protect: DEFAULT_PROTECT,
    shell: { allow: proposal.shellAllow, otherwise: "ask" },
    web: "allow",
    mcp: "ask",
    checks: proposal.checks,
  };
}

/** Reads the real filesystem. Never follows the project into node_modules or other deep trees. */
export function fileSystemReader(projectDir: string): ProjectReader {
  return {
    exists: (path) => existsSync(join(projectDir, path)),
    read: (path) => {
      try {
        const absolute = join(projectDir, path);
        if (!statSync(absolute).isFile() || statSync(absolute).size > 1024 * 1024) return null;
        return readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
    topLevelDirs: () => {
      try {
        return readdirSync(projectDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
  };
}
