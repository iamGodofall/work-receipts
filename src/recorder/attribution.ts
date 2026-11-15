import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyDir } from "./signing";

/**
 * Agent authorship of changed lines, without storing or sharing code. When a
 * file tool writes, the hook computes keyed digests (HMAC-SHA-256, truncated)
 * of the lines it wrote and appends them to a private sidecar file next to the
 * session log. The chained log event records only a hash of that digest list,
 * so the sidecar cannot be swapped, and neither the digests nor the sidecar
 * ever enter a receipt bundle. When the receipt is generated, each line added
 * since the session's base commit is digested the same way and counted as
 * agent-written when it matches. Receipts carry only counts.
 *
 * The key is derived per session from a user secret kept with the signing key,
 * which the agent cannot read, so digests from different sessions or
 * repositories cannot be matched against each other.
 */

export const ATTRIBUTION_SIDECAR = "attribution.jsonl";

/** 64 bits per line: collisions are negligible at the line counts of one session. */
const DIGEST_HEX = 16;
/** Digests kept per tool call, so one huge file cannot bloat the log. */
export const MAX_DIGESTS_PER_WRITE = 5000;
const MAX_FILES_LISTED = 200;

export type Attribution =
  | { available: false; reason: string }
  | {
      available: true;
      /** Meaningful added lines that match lines an agent file tool wrote. */
      agentLines: number;
      /** Meaningful added lines that did not: shell commands, formatters, generators, or a person. */
      otherLines: number;
      files: { path: string; agentLines: number; otherLines: number }[];
      filesTruncated: boolean;
    };

/** Load the user's attribution key, creating it on first use next to the signing key. */
export function loadOrCreateAttributionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const dir = keyDir(env);
  const path = join(dir, "attribution.key");
  if (existsSync(path)) {
    const hex = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error("The attribution key file is malformed.");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

/** A key unique to one session, so digests never link sessions or repositories. */
export function sessionAttributionKey(master: Buffer, sessionId: string): Buffer {
  return createHmac("sha256", master).update("work-receipts/attribution/v1/" + sessionId, "utf8").digest();
}

/** Commits the chained event to the exact digest list kept in the sidecar. */
export function digestListHash(digests: readonly string[]): string {
  return createHash("sha256").update(digests.join("\n"), "utf8").digest("hex");
}

/**
 * Record the lines one file-tool call wrote: digests go to the private sidecar,
 * and the returned fields (count and list hash) go into the chained event.
 */
export function recordAgentLines(sessionDirectory: string, key: Buffer, text: string): { lineDigestCount: number; lineDigestsHash: string } | Record<string, never> {
  const digests = lineDigests(key, text);
  if (digests.length === 0) return {};
  mkdirSync(sessionDirectory, { recursive: true });
  appendFileSync(join(sessionDirectory, ATTRIBUTION_SIDECAR), JSON.stringify({ digests }) + "\n", "utf8");
  return { lineDigestCount: digests.length, lineDigestsHash: digestListHash(digests) };
}

/**
 * Digests from sidecar entries whose list hash a completed, chained event
 * recorded. Anything else in the sidecar is ignored, so editing it cannot add
 * authorship.
 */
export function agentDigests(sidecar: string, events: unknown[]): Set<string> {
  const committed = new Set<string>();
  for (const event of events) {
    const record = event as { eventType?: unknown; payload?: { lineDigestsHash?: unknown } } | null;
    if (record && record.eventType === "tool.completed" && typeof record.payload?.lineDigestsHash === "string") {
      committed.add(record.payload.lineDigestsHash);
    }
  }
  const digests = new Set<string>();
  for (const line of sidecar.split("\n")) {
    if (!line.trim()) continue;
    let entry: { digests?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(entry?.digests) || entry.digests.length > MAX_DIGESTS_PER_WRITE) continue;
    const list = entry.digests.filter((digest): digest is string => typeof digest === "string" && /^[0-9a-f]{16}$/.test(digest));
    if (list.length !== entry.digests.length || !committed.has(digestListHash(list))) continue;
    for (const digest of list) digests.add(digest);
  }
  return digests;
}

/**
 * Whitespace-insensitive at the ends, so re-indentation and CRLF do not change
 * authorship. Lines with fewer than three letters or digits (`}`, `);`, blank)
 * are too generic to attribute and are excluded from both counts.
 */
export function meaningfulLine(line: string): string | null {
  const trimmed = line.trim();
  return (trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3 ? trimmed : null;
}

export function lineDigest(key: Buffer, normalized: string): string {
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex").slice(0, DIGEST_HEX);
}

export function lineDigests(key: Buffer, text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const normalized = meaningfulLine(line);
    if (normalized === null) continue;
    out.add(lineDigest(key, normalized));
    if (out.size >= MAX_DIGESTS_PER_WRITE) break;
  }
  return [...out];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The text a file tool call writes, from its documented input fields. */
export function writtenText(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Write":
      return str(toolInput.content);
    case "Edit":
      return str(toolInput.new_string);
    case "MultiEdit":
      return Array.isArray(toolInput.edits)
        ? toolInput.edits.map((edit) => (edit && typeof edit === "object" ? str((edit as Record<string, unknown>).new_string) : "")).join("\n")
        : null;
    case "NotebookEdit":
      return str(toolInput.new_source);
    default:
      return null;
  }
}

/** Pure: count added lines per file that match agent-written digests. */
export function attribute(addedByFile: Map<string, string[]>, agentWritten: Set<string>, key: Buffer): Attribution {
  const files: { path: string; agentLines: number; otherLines: number }[] = [];
  let agentLines = 0;
  let otherLines = 0;
  for (const [path, lines] of [...addedByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let agent = 0;
    let other = 0;
    for (const line of lines) {
      const normalized = meaningfulLine(line);
      if (normalized === null) continue;
      if (agentWritten.has(lineDigest(key, normalized))) agent += 1;
      else other += 1;
    }
    if (agent + other === 0) continue;
    agentLines += agent;
    otherLines += other;
    files.push({ path, agentLines: agent, otherLines: other });
  }
  return {
    available: true,
    agentLines,
    otherLines,
    files: files.slice(0, MAX_FILES_LISTED),
    filesTruncated: files.length > MAX_FILES_LISTED,
  };
}

export function describeAttribution(attribution: Attribution): string {
  if (!attribution.available) return "Not measured (" + attribution.reason + ")";
  const total = attribution.agentLines + attribution.otherLines;
  if (total === 0) return "No meaningful lines were added.";
  const percent = Math.round((attribution.agentLines / total) * 100);
  return percent + "% of added lines (" + attribution.agentLines + " of " + total + ") match lines written by agent file tools; " +
    attribution.otherLines + " came from elsewhere (shell commands, formatters, generators, or a person).";
}
