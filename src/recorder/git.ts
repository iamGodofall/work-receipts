import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, RECEIPTS_DIR } from "./contract";

const MAX_DIRTY_FILES = 500;

export type GitBaseline =
  | { git: false }
  | { git: true; head: string | null; dirty: { path: string; sha256: string | null }[]; truncated: boolean };

export type GitChanges =
  | { available: false; reason: string }
  | { available: true; changed: string[]; contractChanged: boolean };

function git(projectDir: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function hashFile(projectDir: string, path: string): string | null {
  const absolute = join(projectDir, path);
  try {
    return existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : null;
  } catch {
    return null;
  }
}

function splitNul(output: string | null): string[] {
  return (output ?? "").split("\0").filter((entry) => entry.length > 0);
}

/** Paths that differ from a commit: modified, staged, deleted, or untracked (respecting .gitignore). */
function pathsDifferingFrom(projectDir: string, ref: string | null): string[] | null {
  const diff = ref ? git(projectDir, ["diff", "--name-only", "-z", ref]) : "";
  const untracked = git(projectDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || untracked === null) return null;
  return [...new Set([...splitNul(diff), ...splitNul(untracked)])];
}

function isRecorderPath(path: string): boolean {
  return path === RECEIPTS_DIR || path.startsWith(RECEIPTS_DIR + "/");
}

/** Snapshot the working tree before the agent's first action in a session. */
export function captureBaseline(projectDir: string): GitBaseline {
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return { git: false };
  const head = git(projectDir, ["rev-parse", "HEAD"])?.trim() || null;
  const paths = (pathsDifferingFrom(projectDir, head) ?? []).filter((path) => !isRecorderPath(path));
  return {
    git: true,
    head,
    dirty: paths.slice(0, MAX_DIRTY_FILES).map((path) => ({ path, sha256: hashFile(projectDir, path) })),
    truncated: paths.length > MAX_DIRTY_FILES,
  };
}

/**
 * Files whose content changed since the baseline, by any means: file tools,
 * shell commands, or the user's own editor. Files already modified at the
 * baseline count only if their content changed again.
 */
export function changedSince(projectDir: string, baseline: GitBaseline | null): GitChanges {
  if (!baseline) return { available: false, reason: "No baseline was recorded for this session." };
  if (!baseline.git) return { available: false, reason: "The project is not a git repository." };
  if (baseline.truncated) return { available: false, reason: "Too many files were already modified when the session started." };

  const current = pathsDifferingFrom(projectDir, baseline.head);
  if (current === null) return { available: false, reason: "git could not compare the working tree with the baseline." };

  const before = new Map(baseline.dirty.map((entry) => [entry.path, entry.sha256]));
  const candidates = new Set([...current, ...before.keys()]);
  const changed = [...candidates]
    .filter((path) => !isRecorderPath(path))
    .filter((path) => (before.has(path) ? before.get(path) !== hashFile(projectDir, path) : true))
    .sort();

  return {
    available: true,
    changed: changed.filter((path) => path !== CONTRACT_FILE),
    contractChanged: changed.includes(CONTRACT_FILE),
  };
}
