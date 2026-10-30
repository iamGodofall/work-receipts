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
