import { describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  hashAuditEvent,
  verifyAuditChain,
  type AuditEventInput,
} from "../audit-chain";

function input(eventId: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    eventId,
    runId: "run-audit-001",
    workspaceId: "workspace-audit-001",
    actorSubject: "orchestrator",
    eventType: "ACTION_FINISHED",
    actionKind: "read",
    target: "web:public",
    actionDigest: "a".repeat(64),
    policyOutcome: "ALLOW",
    resultStatus: "success",
    payload: { responseStatus: 200, outputBytes: 412 },
    createdAt: "2026-10-27T09:00:00.000Z",
    ...overrides,
  };
}

describe("hash-linked audit events", () => {
  it("creates a consistent chain from application-observed facts", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const second = appendAuditEvent(first, input("evt-2", {
      eventType: "VERIFICATION_PASSED",
      actionKind: undefined,
      target: undefined,
      actionDigest: undefined,
      policyOutcome: undefined,
      resultStatus: undefined,
      createdAt: "2026-10-27T09:00:01.000Z",
      payload: { checksPassed: 3, checksFailed: 0 },
    }));
    const third = appendAuditEvent(second, input("evt-3", {
      eventType: "WORK_RECEIPT_CREATED",
      actionKind: undefined,
      target: undefined,
      actionDigest: undefined,
      policyOutcome: undefined,
      resultStatus: undefined,
      createdAt: "2026-10-27T09:00:02.000Z",
      payload: { receiptDigest: "b".repeat(64) },
    }));

    expect(first.sequenceNo).toBe(1);
    expect(second.sequenceNo).toBe(2);
    expect(third.sequenceNo).toBe(3);
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(third.previousEventHash).toBe(second.eventHash);
    expect(verifyAuditChain([first, second, third])).toMatchObject({
      valid: true,
      checkedEvents: 3,
      failedIndex: null,
    });
  });

  it("detects changes to an event payload", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const tampered = { ...first, payload: { responseStatus: 200, outputBytes: 0 } };
    expect(verifyAuditChain([tampered])).toMatchObject({
      valid: false,
      failedIndex: 0,
    });
  });

  it("detects a broken predecessor link", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const second = appendAuditEvent(first, input("evt-2"));
    const tampered = { ...second, previousEventHash: "c".repeat(64) };
    const resealed = { ...tampered, eventHash: hashAuditEvent(tampered) };
    expect(verifyAuditChain([first, resealed])).toMatchObject({
      valid: false,
      failedIndex: 1,
      reason: "Previous event hash does not match the preceding event.",
    });
  });

  it("rejects missing or reordered sequence numbers", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const second = appendAuditEvent(first, input("evt-2"));
    expect(verifyAuditChain([second, first]).valid).toBe(false);
    expect(verifyAuditChain([first, { ...second, sequenceNo: 4 }]).valid).toBe(false);
  });

  it("rejects duplicate event IDs", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const duplicate = appendAuditEvent(first, input("evt-1"));
    expect(verifyAuditChain([first, duplicate])).toMatchObject({
      valid: false,
      failedIndex: 1,
    });
  });

  it("rejects chains crossing run or workspace boundaries", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    expect(() => appendAuditEvent(first, input("evt-2", { workspaceId: "other-workspace" })))
      .toThrow(/must not cross run or workspace boundaries/i);
    const unrelated = appendAuditEvent(undefined, input("evt-2", { runId: "other-run" }));
    expect(verifyAuditChain([first, unrelated])).toMatchObject({
      valid: false,
      failedIndex: 1,
      reason: "Audit chain crosses a run or workspace boundary.",
    });
  });
  it("refuses to extend a tampered prior event", () => {
    const first = appendAuditEvent(undefined, input("evt-1"));
    const tampered = { ...first, payload: { forged: true } };
    expect(() => appendAuditEvent(tampered, input("evt-2"))).toThrow(/modified/i);
  });
});