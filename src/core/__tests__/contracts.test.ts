import { describe, expect, it } from "vitest";
import {
  ApprovalGrantSchema,
  TaskContractSchema,
  type TaskContract,
} from "../contracts";

const validContract: TaskContract = {
  schemaVersion: "1.0",
  runId: "contract-test-001",
  workspaceId: "workspace-001",
  ownerId: "user-001",
  goal: "Produce a structured report",
  autonomyTier: "L1",
  acceptanceCriteria: [{
    id: "report-exists",
    description: "A report artifact exists",
    required: true,
    verificationRequired: "deterministic",
  }],
  allowedActions: ["read", "create_artifact"],
  allowedTargets: ["web:public", "artifact:report"],
  budget: { maxActions: 10, maxDurationSeconds: 600, maxCostUsd: 0.5 },
  createdAt: "2026-10-27T09:00:00.000Z",
};

describe("task and approval contract schemas", () => {
  it("accepts a well-formed bounded task contract", () => {
    expect(TaskContractSchema.safeParse(validContract).success).toBe(true);
  });

  it("rejects duplicate allowed actions", () => {
    const result = TaskContractSchema.safeParse({
      ...validContract,
      allowedActions: ["read", "read"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate acceptance criterion IDs", () => {
    const result = TaskContractSchema.safeParse({
      ...validContract,
      acceptanceCriteria: [
        ...validContract.acceptanceCriteria,
        ...validContract.acceptanceCriteria,
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a task contract with an unknown property", () => {
    const result = TaskContractSchema.safeParse({
      ...validContract,
      modelApproved: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an approval with an invalid action digest", () => {
    const result = ApprovalGrantSchema.safeParse({
      approvalId: "approval-001",
      runId: validContract.runId,
      workspaceId: validContract.workspaceId,
      kind: "send",
      target: "mail:recipient",
      actionDigest: "not-a-sha256",
      approvedBy: validContract.ownerId,
      approvedAt: "2026-10-27T09:01:00.000Z",
      expiresAt: "2026-10-27T09:10:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a revocation timestamp before approval consumption", () => {
    const result = ApprovalGrantSchema.safeParse({
      approvalId: "approval-001",
      runId: validContract.runId,
      workspaceId: validContract.workspaceId,
      kind: "send",
      target: "mail:recipient",
      actionDigest: "a".repeat(64),
      approvedBy: validContract.ownerId,
      approvedAt: "2026-10-27T09:01:00.000Z",
      expiresAt: "2026-10-27T09:10:00.000Z",
      consumedAt: "2026-10-27T09:02:00.000Z",
      revokedAt: "2026-10-27T09:01:30.000Z",
    });
    expect(result.success).toBe(false);
  });
  it("rejects an approval expiry at or before the grant timestamp", () => {
    const result = ApprovalGrantSchema.safeParse({
      approvalId: "approval-001",
      runId: validContract.runId,
      workspaceId: validContract.workspaceId,
      kind: "send",
      target: "mail:recipient",
      actionDigest: "a".repeat(64),
      approvedBy: validContract.ownerId,
      approvedAt: "2026-10-27T09:01:00.000Z",
      expiresAt: "2026-10-27T09:01:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});