import type { AuditEvent } from "../core/audit-chain";

export type TimelineStatus = "done" | "failed" | "blocked" | "approved" | "not_run" | "pending";

export type TimelineEntry = {
  at: string;
  /** "claude-code" or "claude-code:<subagent type>". */
  actor: string;
  tool: string;
  /** Command preview for shell calls, otherwise the target. */
  subject: string;
  status: TimelineStatus;
  /** Why the recorder blocked or escalated it, when it did. */
  reason: string | null;
  durationMs: number | null;
};

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/**
 * One entry per tool call, in order, pairing each request with its outcome.
 * Derived only from the recorded events, so it can be rebuilt from any bundle.
 */
export function buildTimeline(events: AuditEvent[]): TimelineEntry[] {
  const outcomes = new Map<string, AuditEvent>();
  for (const event of events) {
    if (event.eventType !== "tool.completed" && event.eventType !== "tool.failed") continue;
    const key = text(event.payload, "toolUseId") ?? event.actionDigest;
    if (key && !outcomes.has(key)) outcomes.set(key, event);
  }

  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (event.eventType !== "tool.requested") continue;
    const key = text(event.payload, "toolUseId") ?? event.actionDigest;
    const outcome = key ? outcomes.get(key) : undefined;
    if (key) outcomes.delete(key);

    let status: TimelineStatus;
    if (event.policyOutcome === "DENY") status = "blocked";
    else if (outcome?.eventType === "tool.failed") status = "failed";
    else if (outcome) status = event.policyOutcome === "REQUIRE_APPROVAL" ? "approved" : "done";
    else status = event.policyOutcome === "REQUIRE_APPROVAL" ? "not_run" : "pending";

    entries.push({
      at: event.createdAt,
      actor: event.actorSubject,
      tool: text(event.payload, "tool") ?? "unknown",
      subject: text(event.payload, "commandPreview") ?? event.target ?? "",
      status,
      reason: event.policyOutcome === "ALLOW" ? null : text(event.payload, "reason"),
      durationMs: outcome ? Math.max(0, Date.parse(outcome.createdAt) - Date.parse(event.createdAt)) : null,
    });
  }
  return entries;
}
