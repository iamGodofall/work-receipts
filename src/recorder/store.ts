import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendAuditEvent, type AuditEvent, type AuditEventInput } from "../core/audit-chain";
import { sha256Hex } from "../core/integrity";
import { RECEIPTS_DIR } from "./contract";

const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 15000;

export function safeSessionId(sessionId: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(sessionId) ? sessionId : "s-" + sha256Hex(sessionId).slice(0, 32);
}

export function workspaceIdFor(projectDir: string): string {
  return "local:" + sha256Hex(resolve(projectDir).toLowerCase()).slice(0, 16);
}

export function sessionsRoot(projectDir: string): string {
  return join(projectDir, RECEIPTS_DIR, "sessions");
}

export function sessionDir(projectDir: string, sessionId: string): string {
  return join(sessionsRoot(projectDir), safeSessionId(sessionId));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Hooks for parallel tool calls run concurrently; a directory lock serializes appends. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock);
      } catch {
        // Lock released between checks.
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the receipt log lock.");
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already removed as stale by another process; nothing to release.
    }
  }
}

export function readEvents(dir: string): unknown[] {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export type NewEvent = Omit<AuditEventInput, "eventId" | "runId" | "workspaceId" | "createdAt">;

/**
 * Append one event. When the session log is empty, `firstEvent` is written
 * before it inside the same lock, so concurrent first calls record it once.
 */
export function appendEvent(
  projectDir: string,
  sessionId: string,
  event: NewEvent,
  firstEvent?: () => NewEvent,
): AuditEvent {
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    let previous = readEvents(dir).at(-1) as AuditEvent | undefined;
    const pending = !previous && firstEvent ? [firstEvent(), event] : [event];
    let lines = "";
    for (const item of pending) {
      previous = appendAuditEvent(previous, {
        ...item,
        eventId: randomUUID(),
        runId: safeSessionId(sessionId),
        workspaceId: workspaceIdFor(projectDir),
        createdAt: new Date().toISOString(),
      });
      lines += JSON.stringify(previous) + "\n";
    }
    appendFileSync(join(dir, "events.jsonl"), lines, "utf8");
    return previous as AuditEvent;
  });
}

/** Tools that only invoke commands (such as /receipt itself) and do no work of their own. */
const COMMAND_ONLY_TOOLS = new Set(["Skill", "SlashCommand"]);
/** Shell commands that run the recorder itself. */
const RECORDER_COMMAND = /plugin[\\/]+bin[\\/]+cli\.js|work-receipts.*cli\.js/i;

/** True when a session log records at least one agent action beyond running the recorder's own commands. */
export function hasAgentWork(events: unknown[]): boolean {
  return events.some((event) => {
    const record = event as { eventType?: unknown; payload?: { tool?: unknown; commandPreview?: unknown } } | null;
    if (!record || record.eventType !== "tool.requested") return false;
    const tool = typeof record.payload?.tool === "string" ? record.payload.tool : "";
    if (COMMAND_ONLY_TOOLS.has(tool)) return false;
    const preview = typeof record.payload?.commandPreview === "string" ? record.payload.commandPreview : "";
    return !RECORDER_COMMAND.test(preview);
  });
}

/**
 * The most recent session that did real work, for commands run without a
 * session id. Running /receipt in a new Claude Code session starts a session
 * of its own; without this, the receipt would describe that empty session
 * instead of the work. Returns how many newer sessions were skipped.
 */
export function latestWorkSession(projectDir: string): { sessionId: string; skipped: number } | null {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return null;
  const sessions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(root, entry.name, "events.jsonl");
      return { name: entry.name, mtime: existsSync(file) ? statSync(file).mtimeMs : 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (let index = 0; index < sessions.length; index += 1) {
    let events: unknown[] = [];
    try {
      events = readEvents(join(root, sessions[index].name));
    } catch {
      continue;
    }
    if (hasAgentWork(events)) return { sessionId: sessions[index].name, skipped: index };
  }
  return null;
}

/** Most recently modified session directory, used when no session is named. */
export function latestSessionId(projectDir: string): string | null {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return null;
  const sessions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(root, entry.name, "events.jsonl");
      return { name: entry.name, mtime: existsSync(file) ? statSync(file).mtimeMs : 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return sessions[0]?.name ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling a tool may use for one absolute path: native, forward slashes, and Git Bash (/d/...). */
function pathSpellings(absolute: string): string[] {
  const forward = resolve(absolute).replace(/\\/g, "/").replace(/\/+$/, "");
  const spellings = new Set([forward, forward.replace(/\//g, "\\")]);
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) spellings.add("/" + drive[1].toLowerCase() + forward.slice(2));
  return [...spellings].filter((spelling) => spelling.length > 3).sort((a, b) => b.length - a.length);
}

/**
 * Receipts promise no absolute paths or user names. Replace the project
 * directory with "." and the home directory with "~" in text that is stored in
 * the log, in every spelling, before anything else sees it.
 */
export function scrubLocalPaths(text: string, projectDir: string, home: string = homedir()): string {
  let out = text;
  const flags = process.platform === "win32" || process.platform === "darwin" ? "gi" : "g";
  for (const [root, replacement] of [[projectDir, "."], [home, "~"]] as const) {
    if (!root) continue;
    for (const spelling of pathSpellings(root)) {
      out = out.replace(new RegExp(escapeRegExp(spelling) + "(?=[\\\\/\"'\\s]|$)", flags), replacement);
    }
  }
  return out;
}

const SECRET_ASSIGNMENT = /\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z_]*)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const LONG_OPAQUE = /[A-Za-z0-9+_-]{32,}={0,2}/g;

/**
 * Best-effort redaction for command previews stored in the log. The full
 * command is represented only by its digest. Redaction is heuristic and is
 * listed as a limitation on every receipt.
 */
export function redactPreview(text: string, maxLength = 200): string {
  const redacted = text
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => key + separator + "[REDACTED]")
    .replace(LONG_OPAQUE, "[REDACTED]");
  return redacted.length > maxLength ? redacted.slice(0, maxLength) + "…" : redacted;
}
