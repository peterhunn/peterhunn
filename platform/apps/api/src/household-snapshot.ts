import {
  actionRepo,
  approvalRepo,
  auditChainRepo,
  auditRepo,
  contactEndpointRepo,
  graphRepo,
  householdRepo,
  messagingEventRepo,
  policyRepo,
  HOUSEHOLD_CHAIN_KEY,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Household health snapshot — a single-page overview a manager can
// share with a customer as "here's what's happening across your
// household right now". Every field is computed from live state,
// nothing stored. Meant to be safe to render as a screenshot —
// no ids or free-form summaries that would leak sensitive detail.
//
// Consumed by /households/:id/snapshot and the console
// /households/[id]/snapshot page.

export interface HouseholdSnapshot {
  readonly household: {
    readonly id: string;
    readonly name: string;
    readonly tier: string;
    readonly frozen: boolean;
    readonly frozenReason: string | null;
    readonly autopilotEnabled: boolean;
    readonly instantAckEnabled: boolean;
    readonly agentSendingEnabled: boolean;
  };
  readonly auditChain: {
    readonly headHash: string | null;
    readonly eventCount: number;
    readonly headAt: string | null;
    readonly valid: boolean;
    readonly brokenAtEventId: string | null;
  };
  readonly approvals: {
    readonly pending: number;
    readonly staleWithinDay: number;
    readonly overdue: number;
    readonly oldestPendingAt: string | null;
  };
  readonly weekActivity: {
    readonly windowDays: number;
    readonly totalActions: number;
    readonly byOutcome: Record<string, number>;
    readonly topActionClasses: Array<{ actionClass: string; count: number }>;
    readonly topPolicies: Array<{
      policyId: string;
      label: string;
      count: number;
    }>;
  };
  readonly messaging: {
    readonly unreadThreads: number;
    readonly deliveryFailuresLast24h: number;
    readonly lastInboundAt: string | null;
    readonly lastOutboundAt: string | null;
  };
  readonly obligations: {
    readonly upcoming14d: number;
    readonly top: Array<{ title: string; dueAt: string; daysLeft: number }>;
  };
  readonly policies: {
    readonly totalActive: number;
    readonly executeCount: number;
  };
  readonly generatedAt: string;
  readonly lastActivityAt: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FORTNIGHT_MS = 14 * DAY_MS;

export const buildHouseholdSnapshot = (
  db: Db,
  householdId: HouseholdId,
  opts: { readonly now?: Date } = {},
): HouseholdSnapshot | null => {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const households = householdRepo(db);
  const hh = households.get(householdId);
  if (!hh) return null;

  const approvals = approvalRepo(db);
  const actions = actionRepo(db);
  const policies = policyRepo(db);
  const graph = graphRepo(db);
  const audit = auditRepo(db);
  const chain = auditChainRepo(db);
  const events = messagingEventRepo(db);
  const endpoints = contactEndpointRepo(db);

  // Audit chain: getHead is cheap; verify walks the whole chain
  // and is O(n) — worth it for the snapshot because "chain is
  // intact" is the whole point of the customer-facing "your trail
  // is verified" line.
  const head = chain.getHead(householdId, HOUSEHOLD_CHAIN_KEY);
  const verify = chain.verifyHouseholdChain(householdId);

  // Approvals — pending + staleness classification.
  const pending = approvals.listPending(householdId);
  const dayAheadIso = new Date(nowMs + DAY_MS).toISOString();
  const nowIsoTs = now.toISOString();
  const stale = approvals.listPendingWithDeadlineWithin(
    householdId,
    dayAheadIso,
  );
  const overdue = stale.filter(
    (a) => a.deadlineAt !== undefined && a.deadlineAt <= nowIsoTs,
  );
  const oldestPending = pending
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

  // Actions in the last 7 days — outcome mix + top classes + top
  // authority policies. Cap the scan at 500 rows to bound the
  // snapshot cost on chatty households.
  const recentActions = actions.list(householdId, 500);
  const windowStartIso = new Date(nowMs - WEEK_MS).toISOString();
  const inWindow = recentActions.filter((a) => a.createdAt >= windowStartIso);
  const byOutcome: Record<string, number> = {};
  const classCounts = new Map<string, number>();
  const policyCounts = new Map<string, number>();
  for (const a of inWindow) {
    byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
    classCounts.set(a.actionClass, (classCounts.get(a.actionClass) ?? 0) + 1);
    if (a.policyIdAuthorizing) {
      policyCounts.set(
        a.policyIdAuthorizing,
        (policyCounts.get(a.policyIdAuthorizing) ?? 0) + 1,
      );
    }
  }
  const topClasses = Array.from(classCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([actionClass, count]) => ({ actionClass, count }));

  // Hydrate top policy ids into { label } — the raw id isn't
  // useful in a screenshot. Fall back to "(revoked)" for any
  // policy that's been revoked since it authored the action.
  const livePolicies = policies.list(householdId);
  const policyIndex = new Map(livePolicies.map((p) => [p.id, p]));
  const topPolicies = Array.from(policyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([policyId, count]) => ({
      policyId,
      label: policyIndex.get(policyId as never)?.spec.label ?? "(revoked)",
      count,
    }));
  const executeCount = livePolicies.filter(
    (p) => p.spec.autonomy === "execute" || p.spec.autonomy === "manage_autonomously",
  ).length;

  // Messaging — pull recent events and classify. dedupe delivery
  // failures on eventId (same event doesn't count twice).
  const dayAgoIso = new Date(nowMs - DAY_MS).toISOString();
  const recentEvents = events.list(householdId, 200);
  const lastOutboundByEndpoint = new Map<string, string>();
  let deliveryFailuresLast24h = 0;
  let lastInboundAt: string | null = null;
  let lastOutboundAt: string | null = null;
  for (const e of recentEvents) {
    if (e.direction === "outbound") {
      if (e.endpointId) {
        const prev = lastOutboundByEndpoint.get(e.endpointId);
        if (!prev || e.receivedAt > prev) {
          lastOutboundByEndpoint.set(e.endpointId, e.receivedAt);
        }
      }
      if (!lastOutboundAt || e.receivedAt > lastOutboundAt) {
        lastOutboundAt = e.receivedAt;
      }
      if (
        e.receivedAt >= dayAgoIso &&
        (e.deliveryStatus === "failed" || e.deliveryStatus === "undelivered")
      ) {
        deliveryFailuresLast24h++;
      }
    } else if (e.direction === "inbound") {
      if (!lastInboundAt || e.receivedAt > lastInboundAt) {
        lastInboundAt = e.receivedAt;
      }
    }
  }
  const epIndex = new Map(
    endpoints.list(householdId).map((ep) => [ep.id, ep]),
  );
  void epIndex;
  let unreadThreads = 0;
  for (const e of recentEvents) {
    if (e.direction !== "inbound") continue;
    if (e.receivedAt < dayAgoIso) continue;
    if (!e.endpointId) continue;
    const lastOut = lastOutboundByEndpoint.get(e.endpointId);
    if (!lastOut || lastOut < e.receivedAt) unreadThreads++;
  }

  // Upcoming obligations in the next 14 days — top 3 by dueAt.
  const obligationNodes = graph.listNodes(householdId, {
    type: "obligation.deadline",
  });
  const upcoming: Array<{ title: string; dueAt: string; daysLeft: number }> = [];
  for (const n of obligationNodes) {
    const d = n.data as { dueAt?: string; title?: string };
    if (!d.dueAt) continue;
    const due = Date.parse(d.dueAt);
    if (!Number.isFinite(due)) continue;
    if (due < nowMs - 30 * DAY_MS) continue;
    if (due - nowMs > FORTNIGHT_MS) continue;
    upcoming.push({
      title: d.title ?? "(untitled)",
      dueAt: d.dueAt,
      daysLeft: Math.round((due - nowMs) / DAY_MS),
    });
  }
  upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  // Last activity — the newest audit event's `at`. The audit log
  // captures every state change, so this doubles as "when did
  // anything at all last happen in this household". Falls back to
  // the household createdAt when there's been no activity yet.
  const lastEvents = audit.listForHousehold(householdId, 1);
  const lastActivityAt = lastEvents[0]?.at ?? hh.createdAt ?? null;

  return {
    household: {
      id: hh.id,
      name: hh.name,
      tier: hh.tier,
      frozen: Boolean(hh.frozenAt),
      frozenReason: hh.frozenReason ?? null,
      autopilotEnabled: hh.autopilotEnabled,
      instantAckEnabled: hh.instantAckEnabled,
      agentSendingEnabled: hh.agentSendingEnabled,
    },
    auditChain: {
      headHash: head?.headHash ?? null,
      eventCount: head?.eventCount ?? 0,
      headAt: head?.headAt ?? null,
      valid: verify.valid,
      brokenAtEventId: verify.valid ? null : verify.brokenAtEventId ?? null,
    },
    approvals: {
      pending: pending.length,
      staleWithinDay: stale.length,
      overdue: overdue.length,
      oldestPendingAt: oldestPending?.createdAt ?? null,
    },
    weekActivity: {
      windowDays: 7,
      totalActions: inWindow.length,
      byOutcome,
      topActionClasses: topClasses,
      topPolicies,
    },
    messaging: {
      unreadThreads,
      deliveryFailuresLast24h,
      lastInboundAt,
      lastOutboundAt,
    },
    obligations: {
      upcoming14d: upcoming.length,
      top: upcoming.slice(0, 3),
    },
    policies: {
      totalActive: livePolicies.length,
      executeCount,
    },
    generatedAt: now.toISOString(),
    lastActivityAt,
  };
};
