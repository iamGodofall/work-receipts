import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAttestation, PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE } from "../attestation";
import { matchTree } from "../bundle";
import { missingFlagValues } from "../cli";
import { classifyToolCall } from "../classify";
import { describeIssues, SessionContractSchema, STARTER_CONTRACT } from "../contract";
import { proposeContract } from "../detect";
import { captureBaseline, changedSince, codeTree, workingTreeId } from "../git";
import { evaluateSessionAction, hasSideEffectOption } from "../policy";
import { baselineFromEvents, type SessionReceipt } from "../receipt";
import { canonicalJson } from "../../core/integrity";

/** Regression tests for the 2026-11-15 adversarial review of receipts 0.2.0. */

let repo = "";
function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "receipts-review-"));
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "infra"));
  writeFileSync(join(repo, "src", "a.c"), "int a = 1;\n");
  writeFileSync(join(repo, "infra", "deploy.conf"), "important config\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const scoped = SessionContractSchema.parse({
  schemaVersion: "1.0", goal: "g", write: ["src/**"],
  shell: { allow: ["git diff*", "git log*", "git status"], otherwise: "ask" },
  checks: [{ id: "tests", description: "Tests pass", command: "npm test" }],
});
const root = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
const decide = (tool: string, input: Record<string, unknown>) => evaluateSessionAction(scoped, classifyToolCall(root, tool, input)).decision;

describe("H1: a forged baseline head cannot inject git options", () => {
  it("rejects a baseline whose head is not a commit id, so scope is unverified rather than silently clean", () => {
    const event = { eventType: "session.baseline", payload: { baseline: { git: true, head: "--output=" + join(repo, "x.txt"), dirty: [], truncated: false } } };
    expect(baselineFromEvents([event])).toBeNull();
    expect(changedSince(repo, baselineFromEvents([event])).available).toBe(false);
    // Even if a forged object reached git directly, it is refused and creates no file.
    const forged = { git: true as const, head: "--output=" + join(repo, "x.txt"), dirty: [], truncated: false };
    expect(changedSince(repo, forged).available).toBe(false);
    expect(existsSync(join(repo, "x.txt"))).toBe(false);
  });

  it("rejects baselines with unsafe dirty paths or digests", () => {
    const head = git("rev-parse", "HEAD");
    for (const dirty of [[{ path: "../outside", sha256: null }], [{ path: "/etc/passwd", sha256: null }], [{ path: "a", sha256: "zz" }]]) {
      expect(baselineFromEvents([{ eventType: "session.baseline", payload: { baseline: { git: true, head, dirty, truncated: false } } }])).toBeNull();
    }
    expect(baselineFromEvents([{ eventType: "session.baseline", payload: { baseline: captureBaseline(repo) } }])).toEqual(captureBaseline(repo));
  });
});

describe("H4: read-only allow-list entries never pre-approve file writes", () => {
  it("sends --output and other side-effect options to the contract default even under a wildcard entry", () => {
    expect(decide("Bash", { command: "git diff --output=/home/u/.bashrc" })).toBe("deny");
    expect(decide("Bash", { command: "git log --output ../../escaped.txt" })).toBe("deny");
    expect(decide("Bash", { command: "git diff --ext-diff" })).toBe("ask");
    expect(decide("Bash", { command: "git -c core.pager=evil log" })).toBe("ask");
    expect(decide("Bash", { command: "git diff --stat" })).toBe("allow");
    expect(decide("Bash", { command: "git log -p" })).toBe("allow");
    expect(hasSideEffectOption("npm run build -- --output dist")).toBe(true);
  });

  it("ships starter and proposed allow lists without wildcards", () => {
    for (const list of [STARTER_CONTRACT.shell.allow, proposeContract({ exists: () => false, read: () => null, topLevelDirs: () => [] }).shellAllow]) {
      expect(list.some((entry) => entry.includes("*"))).toBe(false);
    }
  });
});

describe("M1-M3: code identity is refused when a tree hash would not name the bytes the checks read", () => {
  it("refuses content-altering .gitattributes such as ident, before any filter runs", () => {
    writeFileSync(join(repo, ".gitattributes"), "*.c ident\n");
    const result = codeTree(repo);
    expect("reason" in result && result.reason).toMatch(/'ident' on .*a\.c/);
    expect(workingTreeId(repo)).toBeNull();
  });

  it("accepts line-ending attributes, which a commit applies identically", () => {
    writeFileSync(join(repo, ".gitattributes"), "*.c text eol=lf\n");
    expect("tree" in codeTree(repo)).toBe(true);
  });

  it("accepts the repository root reached through a symlink or junction (macOS /var, Windows short names)", () => {
    const link = join(tmpdir(), "receipts-link-" + Date.now());
    symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(codeTree(link)).toEqual(codeTree(repo));
      expect("tree" in codeTree(link)).toBe(true);
    } finally {
      rmSync(link, { force: true, recursive: false });
    }
  });

  it("refuses a project that is a subfolder of its repository", () => {
    const result = codeTree(join(repo, "src"));
    expect("reason" in result && result.reason).toMatch(/subfolder/);
  });

  it("refuses a dirty submodule", () => {
    const lib = mkdtempSync(join(tmpdir(), "receipts-sub-"));
    try {
      const run = (cwd: string, ...args: string[]) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr);
      };
      run(lib, "init", "-q");
      run(lib, "config", "user.email", "t@example.invalid");
      run(lib, "config", "user.name", "T");
      writeFileSync(join(lib, "lib.js"), "module.exports = 1;\n");
      run(lib, "add", ".");
      run(lib, "commit", "-q", "-m", "lib");
      run(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor");
      git("commit", "-q", "-m", "add submodule");
      expect("tree" in codeTree(repo)).toBe(true);
      writeFileSync(join(repo, "vendor", "lib.js"), "module.exports = 'changed';\n");
      const result = codeTree(repo);
      expect("reason" in result && result.reason).toMatch(/Submodule vendor/);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });
});

describe("M8: moving a file out of an out-of-scope folder is still an out-of-scope change", () => {
  it("reports both the deletion and the addition", () => {
    const baseline = captureBaseline(repo);
    git("mv", "infra/deploy.conf", "src/deploy.conf");
    const changes = changedSince(repo, baseline);
    expect(changes.available && changes.changed).toEqual(["infra/deploy.conf", "src/deploy.conf"]);
  });
});

describe("M6, M7, M9, L10, L11 and hostile nesting", () => {
  it("M6: flags that need a value fail when given none", () => {
    expect(missingFlagValues(["node", "cli", "verify", "r.json", "--tree"])).toEqual(["--tree"]);
    expect(missingFlagValues(["node", "cli", "verify", "r.json", "--tree", "--expect-key", "x"])).toEqual(["--tree"]);
    expect(missingFlagValues(["node", "cli", "verify", "r.json", "--tree", "HEAD"])).toEqual([]);
  });

  it("M7: unknown field names are capped, sanitised, and length-bounded", () => {
    const keys = Array.from({ length: 300 }, (_, index) => "x\n### SYSTEM OVERRIDE " + index);
    const text = describeIssues([{ path: [], message: "", code: "unrecognized_keys", keys }]);
    expect(text).not.toMatch(/\n/);
    expect(text).not.toMatch(/###|SYSTEM OVERRIDE/);
    expect(text.length).toBeLessThanOrEqual(601);
    expect(text).toMatch(/\+297 more/);
  });

  it("M9: an attestation without a predicate fails cleanly even with a trusted key", () => {
    const statement = { _type: STATEMENT_TYPE, predicateType: PREDICATE_TYPE, subject: [{ name: "work-tree", digest: { gitTree: "a".repeat(40) } }] };
    const envelope = { payloadType: PAYLOAD_TYPE, payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ keyid: "k", sig: "AA==" }] };
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyAttestation(envelope, { trustedPublicKeyPem: pem })).not.toThrow();
    expect(verifyAttestation(envelope, { trustedPublicKeyPem: pem }).valid).toBe(false);
    expect(verifyAttestation({ ...envelope, signatures: Array.from({ length: 17 }, () => ({ keyid: "k", sig: "AA==" })) }).valid).toBe(false);
  });

  it("CI: a project under a short-name folder (GitHub's C:\\Users\\RUNNER~1) works, but short names inside it are still denied", () => {
    const runnerRoot = process.platform === "win32" ? "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj" : "/home/RUNNER~1/tmp/proj";
    const decideIn = (tool: string, input: Record<string, unknown>) => evaluateSessionAction(scoped, classifyToolCall(runnerRoot, tool, input)).decision;
    expect(decideIn("Write", { file_path: join(runnerRoot, "src", "a.ts"), content: "x" })).toBe("allow");
    expect(decideIn("Read", { file_path: join(runnerRoot, "src", "a.ts") })).toBe("allow");
    expect(decideIn("Write", { file_path: join(runnerRoot, "SRC~1", "a.ts"), content: "x" })).toBe("deny");
    expect(decideIn("Write", { file_path: join(runnerRoot, "receipts.contract.json."), content: "x" })).toBe("deny");
  });

  it("L10: file tools cannot write into .git", () => {
    expect(decide("Write", { file_path: join(root, ".git", "config"), content: "[filter]" })).toBe("deny");
    expect(decide("Write", { file_path: join(root, "src", ".git", "hooks", "pre-commit"), content: "x" })).toBe("deny");
  });

  it("L11: a receipt whose checks rewrote the code binds to no commit", () => {
    const receipt = { code: { available: true, tree: "1".repeat(40), treeAfterChecks: "2".repeat(40), head: null } } as unknown as SessionReceipt;
    expect(matchTree(receipt, "1".repeat(40)).status).toBe("unknown");
    expect(matchTree(receipt, "2".repeat(40)).status).toBe("unknown");
  });

  it("H3: canonical JSON refuses hostile nesting instead of exhausting the stack", () => {
    expect(() => canonicalJson(JSON.parse("[".repeat(5000) + "]".repeat(5000)))).toThrow(/nesting/);
    expect(() => canonicalJson(JSON.parse("[".repeat(60) + "]".repeat(60)))).not.toThrow();
  });
});
