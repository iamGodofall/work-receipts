// zod/mini keeps this module light: the Claude Code hook loads it on every tool call.
import * as z from "zod/mini";
import { ACTION_KINDS } from "./action-kind";
import { sha256Object } from "./integrity";

const boundedString = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const sha256 = () => z.string().check(z.regex(/^[a-f0-9]{64}$/));

const auditEventInputShape = {
  eventId: boundedString(128),
  runId: boundedString(128),
  workspaceId: boundedString(128),
  actorSubject: boundedString(128),
  eventType: boundedString(128),
  actionKind: z.optional(z.enum(ACTION_KINDS)),
  target: z.optional(boundedString(512)),
  actionDigest: z.optional(sha256()),
  policyOutcome: z.optional(z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"])),
  resultStatus: z.optional(z.enum(["success", "failed", "denied", "unknown"])),
  approvalId: z.optional(boundedString(128)),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
};

export const AuditEventInputSchema = z.strictObject(auditEventInputShape);

export const AuditEventSchema = z.strictObject({
  ...auditEventInputShape,
  schemaVersion: z.literal("1.0"),
  sequenceNo: z.int().check(z.positive()),
  previousEventHash: z.nullable(sha256()),
  eventHash: sha256(),
});

export type AuditEventInput = z.infer<typeof AuditEventInputSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export type AuditChainAssessment = {
  valid: boolean;
  checkedEvents: number;
  failedIndex: number | null;
  reason: string | null;
};

/**
 * Append one application-observed event to a hash-linked sequence. Store action
 * facts and policy decisions, not hidden model reasoning or secret values.
 */
export function appendAuditEvent(
  previous: AuditEvent | undefined,
  input: AuditEventInput,
): AuditEvent {
  const parsedInput = AuditEventInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new TypeError("Audit event failed schema validation.");
  }

  let sequenceNo = 1;
  let previousEventHash: string | null = null;

  if (previous) {
    const parsedPrevious = AuditEventSchema.safeParse(previous);
    if (!parsedPrevious.success || hashAuditEvent(previous) !== previous.eventHash) {
      throw new TypeError("Previous audit event is invalid or has been modified.");
    }
    if (
      previous.runId !== parsedInput.data.runId ||
      previous.workspaceId !== parsedInput.data.workspaceId
    ) {
      throw new TypeError("Audit chains must not cross run or workspace boundaries.");
    }
    sequenceNo = previous.sequenceNo + 1;
    previousEventHash = previous.eventHash;
  }

  const withoutHash = {
    ...parsedInput.data,
    schemaVersion: "1.0" as const,
    sequenceNo,
    previousEventHash,
  };
  const definedFields = Object.fromEntries(
    Object.entries(withoutHash).filter(([, value]) => value !== undefined),
  );
  return {
    ...withoutHash,
    eventHash: sha256Object(definedFields),
  };
}

/**
 * A digest detects changes to the canonical event fields. Verification proves
 * only internal chain consistency, not the truth of an event's payload.
 */
export function hashAuditEvent(event: AuditEvent): string {
  const { eventHash: _ignored, ...withoutHash } = event;
  const definedFields = Object.fromEntries(
    Object.entries(withoutHash).filter(([, value]) => value !== undefined),
  );
  return sha256Object(definedFields);
}

export function verifyAuditChain(eventsInput: unknown): AuditChainAssessment {
  if (!Array.isArray(eventsInput)) {
    return {
      valid: false,
      checkedEvents: 0,
      failedIndex: 0,
      reason: "Audit chain must be an array.",
    };
  }

  const events: AuditEvent[] = [];
  for (let index = 0; index < eventsInput.length; index += 1) {
    const parsed = AuditEventSchema.safeParse(eventsInput[index]);
    if (!parsed.success) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Audit event failed schema validation.",
      };
    }
    events.push(parsed.data);
  }

  const eventIds = new Set<string>();
  const firstEvent = events[0];
  let expectedPreviousHash: string | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (
      firstEvent &&
      (event.runId !== firstEvent.runId || event.workspaceId !== firstEvent.workspaceId)
    ) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Audit chain crosses a run or workspace boundary.",
      };
    }

    if (event.sequenceNo !== index + 1) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Audit sequence numbers must be contiguous and start at one.",
      };
    }

    if (event.previousEventHash !== expectedPreviousHash) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Previous event hash does not match the preceding event.",
      };
    }

    if (eventIds.has(event.eventId)) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Audit event IDs must be unique within a chain.",
      };
    }

    if (hashAuditEvent(event) !== event.eventHash) {
      return {
        valid: false,
        checkedEvents: index,
        failedIndex: index,
        reason: "Audit event hash does not match its canonical contents.",
      };
    }

    eventIds.add(event.eventId);
    expectedPreviousHash = event.eventHash;
  }

  return {
    valid: true,
    checkedEvents: events.length,
    failedIndex: null,
    reason: null,
  };
}