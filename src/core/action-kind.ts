/**
 * The action vocabulary, as plain data so lightweight modules (the audit chain
 * and the Claude Code hook) can share it without loading full schema modules.
 */
export const ACTION_KINDS = [
  "read",
  "create_artifact",
  "write",
  "send",
  "purchase",
  "delete",
  "publish",
  "deploy",
  "permission_change",
  "execute_code",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];
