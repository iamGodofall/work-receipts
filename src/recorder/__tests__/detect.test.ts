import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeValidation, renderProposal, runCheck } from "../cli";
import { CONTRACT_FILE, describeIssues, loadContract, SessionContractSchema } from "../contract";
import { contractFromProposal, fileSystemReader, PLACEHOLDER_CHECK, proposeContract, type ProjectReader } from "../detect";
import { commandMatches, evaluateSessionAction } from "../policy";
import { classifyToolCall } from "../classify";

function memoryReader(files: Record<string, string>, dirs: string[] = []): ProjectReader {
  return {
    exists: (path) => path in files || dirs.includes(path),
    read: (path) => files[path] ?? null,
    topLevelDirs: () => dirs,
  };
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("project-aware contract proposal", () => {
  it("uses the project's own npm scripts in a stable order", () => {
    const proposal = proposeContract(memoryReader(
      { "package.json": pkg({ build: "next build", test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" }) },
      ["src", "app", "node_modules"],
    ));
    expect(proposal.detected).toEqual(["Node.js (npm)"]);
    expect(proposal.checks.map((check) => check.command)).toEqual(["npm run typecheck", "npm run lint", "npm test", "npm run build"]);
    expect(proposal.write).toEqual(["src/**", "app/**"]);
  });

  it("follows the lockfile's package manager", () => {
    const pnpm = proposeContract(memoryReader({ "package.json": pkg({ test: "vitest" }), "pnpm-lock.yaml": "" }));
    expect(pnpm.checks[0].command).toBe("pnpm test");
    const bun = proposeContract(memoryReader({ "package.json": pkg({ test: "vitest" }), "bun.lock": "" }));
    // `bun test` would run Bun's own runner instead of the project's script.
    expect(bun.checks[0].command).toBe("bun run test");
  });

  it("ignores npm's always-failing placeholder test script", () => {
    const proposal = proposeContract(memoryReader({ "package.json": pkg({ test: "echo \"Error: no test specified\" && exit 1" }) }));
    expect(proposal.checks).toEqual([PLACEHOLDER_CHECK]);
    expect(proposal.notes.join(" ")).toMatch(/placeholder test script/);
  });

  it("detects Python, Rust, and Go toolchains", () => {
    const python = proposeContract(memoryReader({ "pyproject.toml": "[tool.ruff]\n[tool.pytest.ini_options]\n", "uv.lock": "" }, ["tests"]));
    expect(python.checks.map((check) => check.command)).toEqual(["uv run ruff check", "uv run pytest"]);
    expect(proposeContract(memoryReader({ "Cargo.toml": "" })).checks[0].command).toBe("cargo test");
    expect(proposeContract(memoryReader({ "go.mod": "" })).checks.map((check) => check.command)).toEqual(["go vet ./...", "go test ./..."]);
  });

  it("uses a Makefile test target only when nothing else is recognised", () => {
    expect(proposeContract(memoryReader({ Makefile: "build:\n\tcc\ntest:\n\t./run\n" })).checks[0].command).toBe("make test");
    const node = proposeContract(memoryReader({ Makefile: "test:\n\tx\n", "package.json": pkg({ test: "jest" }) }));
    expect(node.checks.map((check) => check.command)).toEqual(["npm test"]);
  });

  it("keeps check ids unique across ecosystems", () => {
    const proposal = proposeContract(memoryReader({ "package.json": pkg({ test: "jest" }), "Cargo.toml": "" }));
    expect(proposal.checks.map((check) => check.id)).toEqual(["tests", "tests-2"]);
  });

  it("never proposes a check that can pass without configuration", () => {
    const proposal = proposeContract(memoryReader({}, []));
    expect(proposal.checks).toEqual([PLACEHOLDER_CHECK]);
    expect(proposal.write).toEqual(["src/**"]);
    expect(proposal.shellAllow).not.toContain(PLACEHOLDER_CHECK.command);
    const result = runCheck(mkdtempSync(join(tmpdir(), "wr-placeholder-")), { ...PLACEHOLDER_CHECK });
    expect(result.status).toBe("failed");
  });

  it("drops script names that would be unsafe on the allow list", () => {
    const proposal = proposeContract(memoryReader({ "package.json": "{ not json" }));
    expect(proposal.notes.join(" ")).toMatch(/not valid JSON/);
    for (const files of <Record<string, string>[]>[
      { "package.json": pkg({ test: "a", lint: "b", typecheck: "c", build: "d" }), "yarn.lock": "" },
      { "pyproject.toml": "[tool.mypy]\npytest", "poetry.lock": "" },
    ]) {
      for (const command of proposeContract(memoryReader(files)).shellAllow) {
        expect(command).not.toMatch(/[;&|`$<>(){}"'\\]/);
      }
    }
  });

  it("produces a schema-valid contract whose checks are pre-approved and whose root files stay out of scope", () => {
    const proposal = proposeContract(memoryReader({ "package.json": pkg({ test: "vitest", lint: "eslint" }) }, ["src", "tests"]));
    const contract = SessionContractSchema.parse(contractFromProposal(proposal, "  Fix the login bug  "));
    expect(contract.goal).toBe("Fix the login bug");
    const root = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    const decide = (tool: string, input: Record<string, unknown>) =>
      evaluateSessionAction(contract, classifyToolCall(root, tool, input)).decision;
    for (const check of contract.checks) {
      expect(decide("Bash", { command: check.command })).toBe("allow");
    }
    expect(commandMatches("git diff --stat", contract.shell.allow)).toBe(true);
    const write = (target: string) => decide("Edit", { file_path: join(root, target) });
    expect(write("src/login.ts")).toBe("allow");
    expect(write("package.json")).toBe("deny");
    expect(write(".github/workflows/ci.yml")).toBe("deny");
  });

  it("caps proposals at the schema's check limit", () => {
    const proposal = proposeContract(memoryReader({
      "package.json": pkg({ test: "a", lint: "b", typecheck: "c", build: "d" }),
      "pyproject.toml": "[tool.ruff]\n[tool.mypy]\npytest", "Cargo.toml": "", "go.mod": "",
    }));
    expect(() => SessionContractSchema.parse(contractFromProposal(proposal))).not.toThrow();
  });
});

describe("init, validate, and contract errors on disk", () => {
  let project = "";
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function makeProject(): string {
    project = mkdtempSync(join(tmpdir(), "wr-detect-"));
    mkdirSync(join(project, "src"));
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "package.json"), pkg({ test: "vitest run" }));
    return project;
  }

  it("reads the real filesystem without descending into hidden or dependency folders", () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".git"));
    const reader = fileSystemReader(dir);
    expect(reader.topLevelDirs().sort()).toEqual(["node_modules", "src"]);
    expect(reader.read("src")).toBeNull();
    expect(reader.read("missing.txt")).toBeNull();
    const proposal = proposeContract(reader);
    expect(proposal.write).toEqual(["src/**"]);
    expect(renderProposal(proposal)).toMatch(/tests: npm test/);
  });

  it("validate warns about placeholders and names the exact invalid field", () => {
    const dir = makeProject();
    expect(describeValidation(dir)).toMatch(/^No receipts\.contract\.json/);
    writeFileSync(join(dir, CONTRACT_FILE), JSON.stringify(contractFromProposal(proposeContract(memoryReader({}, [])))));
    const placeholder = describeValidation(dir);
    expect(placeholder).toMatch(/^OK/);
    expect(placeholder).toMatch(/goal is still the placeholder/);
    expect(placeholder).toMatch(/placeholder check is still present/);

    const broken = { ...JSON.parse(readFileSync(join(dir, CONTRACT_FILE), "utf8")), write: [], checks: [{ id: "Bad Id", description: "x", command: "x" }], extra: true };
    writeFileSync(join(dir, CONTRACT_FILE), JSON.stringify(broken));
    const loaded = loadContract(dir);
    expect(loaded.status).toBe("invalid");
    const message = loaded.status === "invalid" ? loaded.message : "";
    expect(message).toMatch(/checks\[0\]\.id: has an invalid format/);
    expect(message).toMatch(/write: needs at least 1 entry/);
    expect(message).toMatch(/unknown field extra/);
    expect(describeValidation(dir)).toMatch(/^INVALID/);
  });

  it("never echoes contract values in validation messages", () => {
    const issues = SessionContractSchema.safeParse({ schemaVersion: "1.0", goal: 42, write: ["SECRET-VALUE-123"], checks: [] });
    expect(issues.success).toBe(false);
    const text = issues.success ? "" : describeIssues(issues.error.issues);
    expect(text).toMatch(/goal: expected string/);
    expect(text).toMatch(/checks: needs at least 1 entry/);
    expect(text).not.toMatch(/SECRET-VALUE-123/);
    const many = describeIssues(Array.from({ length: 7 }, (_, index) => ({ path: ["write", index], message: "bad" })));
    expect(many).toMatch(/\(\+3 more\)/);
  });
});
