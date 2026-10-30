import { z } from "zod";
import { ACTION_KINDS } from "./action-kind";

export const ActionKindSchema = z.enum(ACTION_KINDS);

export const AutonomyTierSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);

export const VerificationRequirementSchema = z.enum([
  "deterministic",
  "human_review",
  "either",
]);

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(128),
  description: z.string().min(1).max(1000),
  required: z.boolean(),
  verificationRequired: VerificationRequirementSchema,
}).strict();

export const TaskContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  ownerId: z.string().min(1).max(128),
  goal: z.string().min(1).max(5000),
  autonomyTier: AutonomyTierSchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(50),
  allowedActions: z.array(ActionKindSchema).max(20),
  allowedTargets: z.array(z.string().min(1).max(512)).max(100),
  budget: z.object({
    maxActions: z.number().int().min(1).max(500),
    maxDurationSeconds: z.number().int().min(1).max(86400),
    maxCostUsd: z.number().min(0).max(10000),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict().superRefine((contract, context) => {
  if (new Set(contract.allowedActions).size !== contract.allowedActions.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedActions"],
      message: "allowedActions must not contain duplicates",
    });
  }
  if (new Set(contract.allowedTargets).size !== contract.allowedTargets.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedTargets"],
      message: "allowedTargets must not contain duplicates",
    });
  }
  const criterionIds = contract.acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceCriteria"],
      message: "Acceptance criterion IDs must be unique within a task",
    });
  }
});

export const ActionRequestSchema = z.object({
  runId: z.string().min(1).max(128),
  kind: ActionKindSchema,
  target: z.string().min(1).max(512),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedAt: z.string().datetime(),
}).strict();

export const ApprovalGrantSchema = z.object({
  approvalId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  kind: ActionKindSchema,
  target: z.string().min(1).max(512),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().min(1).max(128),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
}).strict().superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "An approval must expire after it is granted",
    });
  }
  if (grant.consumedAt && Date.parse(grant.consumedAt) < Date.parse(grant.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["consumedAt"],
      message: "An approval cannot be consumed before it is granted",
    });
  }
  if (grant.consumedAt && Date.parse(grant.consumedAt) >= Date.parse(grant.expiresAt)) {
    context.addIssue({
      code: "custom",
      path: ["consumedAt"],
      message: "An approval cannot be consumed after expiry",
    });
  }
  if (grant.revokedAt && Date.parse(grant.revokedAt) < Date.parse(grant.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "An approval cannot be revoked before it is granted",
    });
  }
  if (grant.revokedAt && grant.consumedAt && Date.parse(grant.revokedAt) <= Date.parse(grant.consumedAt)) {
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation cannot predate or coincide with an approval claim",
    });
  }
});

export const ReceiptActionSchema = z.object({
  id: z.string().min(1).max(128),
  kind: ActionKindSchema,
  target: z.string().min(1).max(512),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyOutcome: z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"]),
  resultStatus: z.enum(["success", "failed", "denied", "unknown"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  approvalId: z.string().min(1).max(128).optional(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const ReceiptCheckSchema = z.object({
  id: z.string().min(1).max(128),
  criterionId: z.string().min(1).max(128),
  description: z.string().min(1).max(1000),
  method: z.enum(["deterministic", "human_review", "model_review"]),
  status: z.enum(["passed", "failed", "skipped"]),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100),
  checkedAt: z.string().datetime(),
}).strict();

export const ReceiptSourceSchema = z.object({
  id: z.string().min(1).max(128),
  uri: z.string().min(1).max(2048),
  title: z.string().min(1).max(1000),
  retrievedAt: z.string().datetime(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const ReceiptArtifactSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
}).strict();

export const WorkReceiptSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  ownerId: z.string().min(1).max(128),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  finalStatus: z.enum(["completed", "partial", "blocked", "failed"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  costUsd: z.number().min(0).max(10000),
  actions: z.array(ReceiptActionSchema).max(500),
  approvals: z.array(ApprovalGrantSchema).max(500),
  checks: z.array(ReceiptCheckSchema).max(200),
  sources: z.array(ReceiptSourceSchema).max(500),
  artifacts: z.array(ReceiptArtifactSchema).max(200),
  limitations: z.array(z.string().min(1).max(2000)).max(100),
}).strict().superRefine((receipt, context) => {
  const actionIds = receipt.actions.map((action) => action.id);
  const approvalIds = receipt.approvals.map((approval) => approval.approvalId);
  const checkIds = receipt.checks.map((check) => check.id);
  const sourceIds = receipt.sources.map((source) => source.id);
  const artifactIds = receipt.artifacts.map((artifact) => artifact.id);

  for (const [field, values] of [
    ["actions", actionIds],
    ["approvals", approvalIds],
    ["checks", checkIds],
    ["sources", sourceIds],
    ["artifacts", artifactIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "IDs must be unique within each receipt collection",
      });
    }
  }

  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "finishedAt must not precede startedAt",
    });
  }

  for (const action of receipt.actions) {
    if (action.finishedAt && Date.parse(action.finishedAt) < Date.parse(action.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["actions", action.id, "finishedAt"],
        message: "An action cannot finish before it starts",
      });
    }
  }
});

export type ActionKind = z.infer<typeof ActionKindSchema>;
export type AutonomyTier = z.infer<typeof AutonomyTierSchema>;
export type TaskContract = z.infer<typeof TaskContractSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;
export type WorkReceipt = z.infer<typeof WorkReceiptSchema>;
export type ReceiptCheck = z.infer<typeof ReceiptCheckSchema>;