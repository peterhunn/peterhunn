import { randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import {
  nowIso,
  type ApprovalItem,
  type ApprovalKind,
  type ApprovalState,
  type HouseholdId,
  type PolicyId,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { approvals, type ApprovalRow } from "../schema/approvals.js";

const newApprovalId = (): string => `apr_${randomBytes(12).toString("hex")}`;

const toItem = (r: ApprovalRow): ApprovalItem => ({
  id: r.id,
  householdId: r.householdId as HouseholdId,
  runId: r.runId,
  taskId: r.taskId,
  kind: r.kind,
  approverType: r.approverType,
  approverId: r.approverId ?? undefined,
  domain: r.domain,
  actionClass: r.actionClass,
  toolName: r.toolName,
  toolVersion: r.toolVersion,
  toolInputs: (r.toolInputs ?? {}) as Record<string, unknown>,
  proposedAttrs: (r.proposedAttrs ?? {}) as Record<string, unknown>,
  subjectPrincipalId: r.subjectPrincipalId ?? undefined,
  amountUsd: r.amountUsd ?? undefined,
  summary: r.summary,
  authorityPolicyId: (r.authorityPolicyId ?? undefined) as PolicyId | undefined,
  proposedBy: { agent: r.proposedByAgent, agentVersion: r.proposedByAgentVersion },
  origin: r.origin ?? undefined,
  originBy: r.originBy ?? undefined,
  reasons: (r.reasons as string[]) ?? [],
  state: r.state,
  resolvedByType: r.resolvedByType ?? undefined,
  resolvedById: r.resolvedById ?? undefined,
  resolvedAt: r.resolvedAt ?? undefined,
  resolutionNote: r.resolutionNote ?? undefined,
  resultActionId: r.resultActionId ?? undefined,
  deadlineAt: r.deadlineAt ?? undefined,
  createdAt: r.createdAt,
});

export interface CreateApprovalInput {
  readonly householdId: HouseholdId;
  readonly runId: string;
  readonly taskId: string;
  readonly kind: ApprovalKind;
  readonly approverType: "principal" | "manager";
  readonly approverId?: string;
  readonly domain: string;
  readonly actionClass: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly toolInputs: Record<string, unknown>;
  readonly proposedAttrs: Record<string, unknown>;
  readonly subjectPrincipalId?: string;
  readonly amountUsd?: number;
  readonly summary: string;
  readonly authorityPolicyId?: PolicyId;
  readonly proposedBy: { agent: string; agentVersion: string };
  readonly origin?: "customer" | "manager" | "proactive" | "system";
  readonly originBy?: string;
  readonly reasons: readonly string[];
  readonly deadlineAt?: string;
}

export interface ResolveApprovalInput {
  readonly state: Exclude<ApprovalState, "pending">;
  readonly resolvedByType: "principal" | "manager";
  readonly resolvedById: string;
  readonly resolutionNote?: string;
  readonly resultActionId?: string;
  readonly editedInputs?: Record<string, unknown>;
}

export const approvalRepo = (db: Db) => ({
  create(input: CreateApprovalInput): ApprovalItem {
    const id = newApprovalId();
    db.insert(approvals)
      .values({
        id,
        householdId: input.householdId,
        runId: input.runId,
        taskId: input.taskId,
        kind: input.kind,
        approverType: input.approverType,
        approverId: input.approverId ?? null,
        domain: input.domain,
        actionClass: input.actionClass,
        toolName: input.toolName,
        toolVersion: input.toolVersion,
        toolInputs: input.toolInputs,
        proposedAttrs: input.proposedAttrs,
        subjectPrincipalId: input.subjectPrincipalId ?? null,
        amountUsd: input.amountUsd ?? null,
        summary: input.summary,
        authorityPolicyId: input.authorityPolicyId ?? null,
        proposedByAgent: input.proposedBy.agent,
        proposedByAgentVersion: input.proposedBy.agentVersion,
        origin: input.origin ?? null,
        originBy: input.originBy ?? null,
        reasons: input.reasons,
        state: "pending",
        deadlineAt: input.deadlineAt ?? null,
        createdAt: nowIso(),
      })
      .run();
    const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row) throw new Error("approval insert did not return");
    return toItem(row);
  },

  get(id: string): ApprovalItem | null {
    const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
    return row ? toItem(row) : null;
  },

  listPending(householdId: HouseholdId): ApprovalItem[] {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.householdId, householdId), eq(approvals.state, "pending")))
      .orderBy(desc(approvals.createdAt))
      .all()
      .map(toItem);
  },

  listAll(householdId: HouseholdId, limit = 100): ApprovalItem[] {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.householdId, householdId))
      .orderBy(desc(approvals.createdAt))
      .limit(limit)
      .all()
      .map(toItem);
  },

  listPendingAcross(householdIds: readonly HouseholdId[]): ApprovalItem[] {
    if (householdIds.length === 0) return [];
    const rows: ApprovalRow[] = [];
    for (const h of householdIds) {
      const r = db
        .select()
        .from(approvals)
        .where(and(eq(approvals.householdId, h), eq(approvals.state, "pending")))
        .orderBy(desc(approvals.createdAt))
        .all();
      rows.push(...r);
    }
    return rows
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(toItem);
  },

  // Pending approvals whose deadline has slipped — the caller
  // walks these to auto-expire each and shelve its escalated task.
  // Cross-household read; the sweeper caller aggregates by household
  // for its own logging + attention rollups. Empty when nothing is
  // due.
  listExpirable(nowIsoTs: string, limit = 500): ApprovalItem[] {
    return db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.state, "pending"),
          isNotNull(approvals.deadlineAt),
          lte(approvals.deadlineAt, nowIsoTs),
        ),
      )
      .orderBy(desc(approvals.deadlineAt))
      .limit(limit)
      .all()
      .map(toItem);
  },

  // Currently-pending approvals whose deadline lands between `nowIso`
  // and `nowIso + horizonMs` — the attention view surfaces these so
  // a manager sees "there are 3 approvals about to expire in the
  // next 24h" before the sweeper acts. Includes already-past-
  // deadline pending rows too (deadlineAt <= nowIso) — those are
  // slipping and haven't been swept yet.
  listPendingWithDeadlineWithin(
    householdId: HouseholdId,
    horizonIso: string,
  ): ApprovalItem[] {
    return db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.householdId, householdId),
          eq(approvals.state, "pending"),
          isNotNull(approvals.deadlineAt),
          lte(approvals.deadlineAt, horizonIso),
        ),
      )
      .orderBy(desc(approvals.deadlineAt))
      .all()
      .map(toItem);
  },

  resolve(id: string, input: ResolveApprovalInput): void {
    db.update(approvals)
      .set({
        state: input.state,
        resolvedByType: input.resolvedByType,
        resolvedById: input.resolvedById,
        resolvedAt: nowIso(),
        resolutionNote: input.resolutionNote ?? null,
        resultActionId: input.resultActionId ?? null,
        toolInputs: input.editedInputs ?? undefined,
      })
      .where(eq(approvals.id, id))
      .run();
  },
});
