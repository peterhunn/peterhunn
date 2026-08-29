import {
  approvalRepo,
  auditRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import { nowIso } from "@atelier/domain";

// Approval-expiration sweeper.
//
// Approvals carry an optional deadlineAt today (set by the caller
// when creating an approval that has a customer-facing "reply by"
// horizon or a policy-mandated turnaround). Nothing enforced that
// deadline before this: an approval could sit pending forever.
//
// This module walks every pending approval whose deadline has
// slipped and:
//   1. Transitions the approval to state="expired" with a system
//      resolver stamp and a resolutionNote pointing at the deadline.
//   2. Shelves the escalated task (state = "shelved") with a
//      decisionSummary explaining why — the run is closed, no
//      further work will be done for this ask.
//   3. Writes an audit event `approval.expired` so the trail
//      matches the state change (auditRepo.record automatically
//      appends to the household + per-person Merkle chains).
//
// Idempotent: a second call moments later finds no more pending-
// past-deadline rows and returns { expired: 0 }.
//
// The sweeper is called from the scheduler tick. Callers that
// want it run at test time (or from a debug endpoint) can invoke
// runExpirationPass directly.

export interface ExpirationSummary {
  readonly expired: number;
  readonly byHousehold: Record<string, number>;
}

export const runExpirationPass = (
  db: Db,
  opts: {
    readonly now?: Date;
    readonly logger?: {
      info: (msg: string, ctx?: unknown) => void;
      error: (msg: string, ctx?: unknown) => void;
    };
  } = {},
): ExpirationSummary => {
  const approvals = approvalRepo(db);
  const tasks = taskRepo(db);
  const audit = auditRepo(db);

  const now = opts.now ?? new Date();
  const nowIsoTs = now.toISOString();
  const stale = approvals.listExpirable(nowIsoTs);
  if (stale.length === 0) return { expired: 0, byHousehold: {} };

  const byHousehold: Record<string, number> = {};
  for (const a of stale) {
    try {
      approvals.resolve(a.id, {
        state: "expired",
        // The system did this, not a manager — mint a synthetic
        // stamp so the audit trail attributes it correctly.
        resolvedByType: "manager",
        resolvedById: "system:approval-expiry",
        resolutionNote: `Auto-expired at deadline ${a.deadlineAt ?? "(unset)"}`,
      });
      tasks.updateTask(a.taskId, {
        state: "shelved",
        decisionSummary: `Escalated approval ${a.id} expired without resolution before ${a.deadlineAt ?? "(deadline unset)"}.`,
      });
      audit.record({
        householdId: a.householdId,
        actor: {
          type: "manager",
          id: "system:approval-expiry",
          displayName: "System — approval expiry",
          householdIds: [a.householdId],
        },
        action: "approval.expired",
        resourceType: "approval",
        resourceId: a.id,
        metadata: {
          deadlineAt: a.deadlineAt ?? null,
          actionClass: a.actionClass,
          subjectPrincipalId: a.subjectPrincipalId ?? null,
          runId: a.runId,
          taskId: a.taskId,
          expiredAt: nowIsoTs,
          sweepAt: nowIso(),
        },
      });
      byHousehold[a.householdId] = (byHousehold[a.householdId] ?? 0) + 1;
    } catch (err) {
      opts.logger?.error("approval expiry — row sweep failed", {
        approvalId: a.id,
        error: (err as Error).message,
      });
    }
  }

  const total = Object.values(byHousehold).reduce((n, x) => n + x, 0);
  if (total > 0) {
    opts.logger?.info("approval expiry sweep applied", {
      total,
      households: Object.keys(byHousehold).length,
    });
  }
  return { expired: total, byHousehold };
};
