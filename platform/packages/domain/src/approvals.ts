import { z } from "zod";
import type { HouseholdId, PolicyId } from "./ids.js";

// Approval queue items — the persistent representation of a proposed
// action that the policy engine demoted to draft (manager_review) or
// ask (customer_approval). See ../life-management/permissions.md
// §"Approvals".

export const ApprovalKind = z.enum(["manager_review", "customer_approval"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalState = z.enum([
  "pending",
  "approved",
  "approved_with_edit",
  "rejected",
  "expired",
  "canceled",
]);
export type ApprovalState = z.infer<typeof ApprovalState>;

export interface ApprovalItem {
  readonly id: string;
  readonly householdId: HouseholdId;
  readonly runId: string;
  readonly taskId: string;

  readonly kind: ApprovalKind;
  readonly approverType: "principal" | "manager";
  readonly approverId: string | undefined;

  readonly domain: string;
  readonly actionClass: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly toolInputs: Record<string, unknown>;
  readonly proposedAttrs: Record<string, unknown>;
  readonly subjectPrincipalId: string | undefined;
  readonly amountUsd: number | undefined;
  readonly summary: string;

  readonly authorityPolicyId: PolicyId | undefined;
  readonly proposedBy: { readonly agent: string; readonly agentVersion: string };
  readonly reasons: readonly string[];

  readonly state: ApprovalState;
  readonly resolvedByType: "principal" | "manager" | undefined;
  readonly resolvedById: string | undefined;
  readonly resolvedAt: string | undefined;
  readonly resolutionNote: string | undefined;
  readonly resultActionId: string | undefined;

  readonly deadlineAt: string | undefined;
  readonly createdAt: string;
}

export const ApproveInput = z.object({
  note: z.string().optional(),
  editedInputs: z.record(z.unknown()).optional(),
});
export type ApproveInput = z.infer<typeof ApproveInput>;

export const RejectInput = z.object({
  note: z.string().min(1),
});
export type RejectInput = z.infer<typeof RejectInput>;
