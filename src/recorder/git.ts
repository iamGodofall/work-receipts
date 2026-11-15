import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTRACT_FILE, RECEIPTS_DIR } from "./contract";

const MAX_DIRTY_FILES = 500;

export type GitBaseline =
  | { git: false }
  | { git: true; head: string | null; dirty: { path: string; sha256: string | null }[]; truncated: boolean }
  | { git: true; fingerprintVersion: 2; head: string | null; dirty: { path: string; fingerprint: string | null }[]; truncated: boolean };

export type GitChanges =
  | { available: false; reason: string }
  | { available: true; changed: string[]; contractChanged: boolean };

function git(projectDir: string, args: string[], env?: Record<string, string>, timeout = 5000, input?: string): string | null {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined,
    input,
  });
  return result.status === 0 ? result.stdout : null;
}

/** A full commit id. Anything else from a log or receipt is refused before it reaches git. */
export const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Identity of the code a receipt covers: the git tree hash of the content
 * `git add -A` would commit, minus the recorder's own `.receipts` folder.
 * Gitignored files are not part of it, exactly as they are not part of a commit.
 */
export type CodeIdentity =
  | { available: false; reason: string }
  | {
      available: true;
      /** Tree the acceptance checks ran against. */
      tree: string;
      /** Tree after the checks finished; differs when a check rewrote files. */
      treeAfterChecks: string;
      /** Commit checked out when the receipt was generated, if any. */
      head: string | null;
    };

/** Run `steps` against a throwaway index so the real index and working tree are untouched. */
function withScratchIndex(projectDir: string, seed: string | null, steps: (env: Record<string, string>) => string | null): string | null {
  const scratch = join(tmpdir(), "work-receipts-index-" + randomBytes(8).toString("hex"));
  try {
    if (seed) {
      copyFileSync(seed, scratch);
      // git's racy-clean protection compares file times with the index file's own
      // time. A fresh copy would look newer than every entry, so a same-size edit
      // made in the same second as the index was written would be trusted as
      // unchanged and hashed as its old content. Keep the original time.
      const original = statSync(seed);
      utimesSync(scratch, original.atime, original.mtime);
    }
    return steps({ GIT_INDEX_FILE: scratch });
  } catch {
    return null;
  } finally {
    rmSync(scratch, { force: true });
  }
}

const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Commit names, branches, and `~`/`^` ancestry; never a leading dash, so never an option. */
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]{0,199}$/;

/** Attributes that make committed content differ from the bytes on disk beyond line endings. */
const CONTENT_ALTERING_ATTRIBUTES = ["ident", "filter", "working-tree-encoding"];

/**
 * Same directory, after resolving symlinks and Windows short names: macOS
 * temp folders live under the /var -> /private/var symlink, and GitHub's
 * Windows runners use C:\Users\RUNNER~1 for C:\Users\runneradmin.
 */
function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const norm = (path: string) => real(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/**
 * Why a git tree hash would not name the bytes the checks read, or null when it does.
 * Line-ending normalisation (`core.autocrlf`, `text`, `eol`) is accepted: it is
 * applied exactly as a commit would apply it and does not change program meaning.
 */
export function codeIdentityObstacle(projectDir: string): string | null {
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return "The project is not a git repository.";
  const top = git(projectDir, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top || !samePath(top, projectDir)) {
    return "The project is a subfolder of its git repository, so a repository tree hash would not name exactly what the checks read.";
  }
  const files = git(projectDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], undefined, 60_000);
  if (files === null) return "git could not list the project's files.";
  if (files.length > 0) {
    const attrs = git(projectDir, ["check-attr", "-z", "--stdin", ...CONTENT_ALTERING_ATTRIBUTES], undefined, 60_000, files);
    if (attrs === null) return "git could not read the project's attributes.";
    const fields = attrs.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (fields[index + 2] !== "unspecified" && fields[index + 2] !== "unset") {
        return "The .gitattributes rule '" + fields[index + 1] + "' on " + fields[index] + " makes committed content differ from the bytes the checks read.";
      }
    }
  }
  const withSubmodules = git(projectDir, ["diff", "--name-only", "-z", "--ignore-submodules=none"]);
  const withoutSubmodules = git(projectDir, ["diff", "--name-only", "-z", "--ignore-submodules=all"]);
  if (withSubmodules === null || withoutSubmodules === null) return "git could not compare submodules.";
  const plain = new Set(splitNul(withoutSubmodules));
  const dirtySubmodules = splitNul(withSubmodules).filter((path) => !plain.has(path));
  if (dirtySubmodules.length) {
    return "Submodule " + dirtySubmodules[0] + " has uncommitted changes, which a tree hash does not capture.";
  }
  return null;
}

/**
 * Tree hash of the working tree as `git add -A` would record it, excluding
 * `.receipts`, or the reason no trustworthy hash exists. Writes blob objects
 * into the repository's object store (as `git add` does) but never changes the
 * real index or any file. Attribute checks run first, so no filter executes.
 */
export function codeTree(projectDir: string): { tree: string } | { reason: string } {
  const obstacle = codeIdentityObstacle(projectDir);
  if (obstacle) return { reason: obstacle };
  const indexPath = git(projectDir, ["rev-parse", "--path-format=absolute", "--git-path", "index"])?.trim();
  // Seeding from the real index reuses its stat cache, so unchanged files are not re-hashed.
  const seed = indexPath && existsSync(indexPath) ? indexPath : null;
  const tree = withScratchIndex(projectDir, seed, (env) => {
    if (git(projectDir, ["add", "-A", "--", ":/"], env, 120_000) === null) return null;
    if (git(projectDir, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ":/" + RECEIPTS_DIR], env) === null) return null;
    return git(projectDir, ["write-tree"], env, 60_000);
  })?.trim();
  return tree && TREE_ID.test(tree) ? { tree } : { reason: "git could not hash the working tree." };
}

/** `codeTree` as a bare hash, or null when the code cannot be identified. */
export function workingTreeId(projectDir: string): string | null {
  const result = codeTree(projectDir);
  return "tree" in result ? result.tree : null;
}

/** Tree hash of a commit or tree, excluding `.receipts`, comparable with `workingTreeId`. */
export function treeOfRevision(projectDir: string, revision: string): string | null {
  // Refuse anything that could be read as an option or a revision range.
  if (!SAFE_REVISION.test(revision) || revision.includes("..")) return null;
  const tree = withScratchIndex(projectDir, null, (env) => {
    if (git(projectDir, ["read-tree", revision + "^{tree}"], env, 60_000) === null) return null;
    if (git(projectDir, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", RECEIPTS_DIR], env) === null) return null;
    return git(projectDir, ["write-tree"], env, 60_000);
  })?.trim();
  return tree && TREE_ID.test(tree) ? tree : null;
}

const MAX_ATTRIBUTED_FILE_BYTES = 1024 * 1024;

/**
 * Lines added to each path relative to `baseCommit` (or the whole file when it
 * is new or there is no base commit). Binary and very large files are skipped.
 * Content stays in memory; the caller keeps only counts.
 */
export function addedLines(projectDir: string, baseCommit: string | null, paths: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (baseCommit !== null && !COMMIT_ID.test(baseCommit)) return result;
  for (const path of paths.slice(0, 2000)) {
    const absolute = join(projectDir, path);
    let size = 0;
    try {
      size = statSync(absolute).size;
    } catch {
      continue; // Deleted: nothing was added.
    }
    if (size > MAX_ATTRIBUTED_FILE_BYTES) continue;
    const tracked = baseCommit !== null && git(projectDir, ["cat-file", "-e", baseCommit + ":" + path]) !== null;
    if (tracked) {
      const diff = git(projectDir, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--end-of-options", baseCommit as string, "--", path], undefined, 30_000);
      if (diff === null || diff.includes("\nBinary files ")) continue;
      result.set(path, diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)));
    } else {
      let content: Buffer;
      try {
        content = readFileSync(absolute);
      } catch {
        continue;
      }
      if (content.includes(0)) continue;
      result.set(path, content.toString("utf8").split(/\r?\n/));
    }
  }
  return result;
}

/** Files a commit stores under `.receipts`, with their git modes; null when the revision cannot be read. */
export function receiptsEntries(projectDir: string, revision: string): { path: string; mode: string }[] | null {
  if (!SAFE_REVISION.test(revision) || revision.includes("..")) return null;
  const listing = git(projectDir, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", revision, "--", RECEIPTS_DIR], undefined, 30_000);
  if (listing === null) return null;
  return splitNul(listing).map((line) => {
    const tab = line.indexOf("\t");
    return { mode: line.slice(0, line.indexOf(" ")), path: line.slice(tab + 1) };
  });
}

/**
 * Content of a file as stored in a commit, never from the working tree, so a
 * verifier judges exactly what the commit carries. Null when missing or larger
 * than git()'s 20 MB output cap.
 */
export function readCommittedFile(projectDir: string, revision: string, path: string): string | null {
  if (!SAFE_REVISION.test(revision) || revision.includes("..") || path.includes("\0") || path.startsWith("-")) return null;
  return git(projectDir, ["cat-file", "blob", revision + ":" + path], undefined, 30_000);
}

/** Commit checked out in the project, or null outside git or before the first commit. */
export function currentHead(projectDir: string): string | null {
  return git(projectDir, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
}

function hashFile(projectDir: string, path: string): string | null {
  const absolute = join(projectDir, path);
  try {
    return existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : null;
  } catch {
    return null;
  }
}

/**
 * Version 2 path-state fingerprint. Git scope evidence must cover more than file
 * bytes: Git records symlink targets and the executable bit in its tree. lstat
 * avoids following symlinks, and a missing path is distinct from an unreadable
 * one. The format is hashed so receipts retain only a fixed-size fingerprint.
 */
export function pathStateFingerprint(projectDir: string, path: string): string | null {
  const absolute = join(projectDir, path);
  const digest = (state: Record<string, string | number | boolean | null>) =>
    createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex");

  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return digest({ version: 2, type: "unavailable", error: code ?? "unknown" });
  }

  if (info.isSymbolicLink()) {
    try {
      return digest({ version: 2, type: "symlink", target: readlinkSync(absolute) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return digest({ version: 2, type: "symlink-unavailable", error: code ?? "unknown" });
    }
  }

  if (info.isFile()) {
    try {
      return digest({
        version: 2,
        type: "file",
        executable: (info.mode & 0o111) !== 0,
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return digest({ version: 2, type: "file-unavailable", executable: (info.mode & 0o111) !== 0, error: code ?? "unknown" });
    }
  }

  if (info.isDirectory()) return digest({ version: 2, type: "directory" });

  return digest({
    version: 2,
    type: "other",
    mode: info.mode & 0o777,
  });
}

function splitNul(output: string | null): string[] {
  return (output ?? "").split("\0").filter((entry) => entry.length > 0);
}

/** Paths that differ from a commit: modified, staged, deleted, or untracked (respecting .gitignore). */
function pathsDifferingFrom(projectDir: string, ref: string | null): string[] | null {
  // The ref comes from a log; only a full commit id may reach git, and never as an option.
  if (ref !== null && !COMMIT_ID.test(ref)) return null;
  // Without rename detection, a file moved out of an out-of-scope folder still shows as changed there.
  const diff = ref ? git(projectDir, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--end-of-options", ref]) : "";
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
    fingerprintVersion: 2,
    head,
    dirty: paths.slice(0, MAX_DIRTY_FILES).map((path) => ({ path, fingerprint: pathStateFingerprint(projectDir, path) })),
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

  const versioned = "fingerprintVersion" in baseline && baseline.fingerprintVersion === 2;
  const before = new Map(baseline.dirty.map((entry) => [
    entry.path,
    "fingerprint" in entry ? entry.fingerprint : entry.sha256,
  ]));
  const currentState = (path: string) => versioned
    ? pathStateFingerprint(projectDir, path)
    : hashFile(projectDir, path);
  const candidates = new Set([...current, ...before.keys()]);
  const changed = [...candidates]
    .filter((path) => !isRecorderPath(path))
    .filter((path) => (before.has(path) ? before.get(path) !== currentState(path) : true))
    .sort();

  return {
    available: true,
    changed: changed.filter((path) => path !== CONTRACT_FILE),
    contractChanged: changed.includes(CONTRACT_FILE),
  };
}

const SEARCH_SCAN_LIMIT = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", RECEIPTS_DIR]);

/**
 * Project-relative files under `relativeDir` that a content search would read.
 * In a git repository that is every file not excluded by .gitignore (Claude
 * Code's Grep skips ignored files); elsewhere a bounded walk of the folder.
 */
export function searchableFiles(projectDir: string, relativeDir: string): string[] {
  const listed = git(projectDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relativeDir === "." ? "." : relativeDir]);
  if (listed !== null) return splitNul(listed);

  const found: string[] = [];
  const walk = (rel: string) => {
    if (found.length >= SEARCH_SCAN_LIMIT) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(projectDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel === "." ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child);
      } else {
        found.push(child);
      }
      if (found.length >= SEARCH_SCAN_LIMIT) return;
    }
  };
  walk(relativeDir);
  return found;
}
