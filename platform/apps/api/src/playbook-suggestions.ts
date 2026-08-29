import {
  actionRepo,
  graphRepo,
  householdPlaybookRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId, NodeType } from "@atelier/domain";
import { buildPlaybookRegistry } from "@atelier/agents";

// Playbook suggestions — mirror of the policy autonomy ladder for
// packaged playbooks. Watch the household's graph and action log
// for signals that a shipped playbook would earn its keep, and
// surface a suggestion to enable it.
//
// The heuristics are deliberately conservative — a playbook fires
// forever once enabled, and the manager pays the cost of every
// stray run. Wrong suggestion is worse than no suggestion.
//
// Enablement happens through the existing PUT /households/:id/
// playbooks/:playbookId route, so this file returns only the read
// side. No dismissal yet — an enabled playbook shows up under
// Playbooks and drops out of suggestions automatically.
//
// See docs/33-permissions-and-autonomy.md §"Playbook suggestions".

export interface PlaybookSuggestion {
  readonly playbookId: string;
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  // Human-readable one-liner explaining what signal fired the
  // suggestion — rendered in the console next to the Enable button.
  readonly reason: string;
  // The numeric signal that crossed the threshold, plus what
  // threshold it crossed. Kept generic so different playbooks can
  // measure different things and still render uniformly.
  readonly signal: {
    readonly count: number;
    readonly threshold: number;
    readonly unit: string;
  };
}

export interface PlaybookSuggestOpts {
  readonly windowDays?: number;
  readonly now?: Date;
}

const DEFAULT_WINDOW_DAYS = 60;

// Per-playbook signal check. Each function returns null when no
// signal fires, or the suggestion body when it does. Keeping the
// heuristics here rather than on the playbook definitions means
// suggestions can be tuned without touching the playbook contracts
// downstream code depends on.
type SignalCheck = (
  db: Db,
  householdId: HouseholdId,
  ctx: { windowStart: string },
) => Omit<PlaybookSuggestion, "playbookId" | "name" | "description" | "domain"> | null;

const SIGNAL_CHECKS: Record<string, SignalCheck> = {
  // Weekly renewals review — earns its keep when the household has
  // enough documents around that manually tracking expiries turns
  // into a real cost.
  "admin.weekly-renewals-review": (db, householdId) => {
    const graph = graphRepo(db);
    const DOC_TYPES: NodeType[] = [
      "document.identity",
      "document.legal",
      "document.policy",
      "document.record",
      "document.receipt",
    ];
    let count = 0;
    for (const t of DOC_TYPES) count += graph.listNodes(householdId, { type: t }).length;
    const threshold = 3;
    if (count < threshold) return null;
    return {
      reason: `${count} documents on file — a weekly renewals scan catches expiring identity, insurance, and legal docs before the customer notices.`,
      signal: { count, threshold, unit: "documents" },
    };
  },

  // Travel prep sweep — earns its keep when the household actually
  // travels. Counts actions in the travel domain (bookings, trip
  // plans) in the window.
  "travel.prep-sweep": (db, householdId, ctx) => {
    const actions = actionRepo(db);
    // 200 is comfortably above what a phase-0 household produces in
    // 60 days; enough to notice a travel pattern.
    const recent = actions
      .list(householdId, 200)
      .filter((a) => a.createdAt >= ctx.windowStart);
    const travelActions = recent.filter((a) => a.domain === "travel").length;
    const threshold = 2;
    if (travelActions < threshold) return null;
    return {
      reason: `${travelActions} travel actions in the last window — a Sunday sweep flags identity-doc validity, coverage gaps, and ground transport for the coming trips.`,
      signal: { count: travelActions, threshold, unit: "travel actions" },
    };
  },

  // Family coverage check — earns its keep when there's a family
  // to coordinate. A single principal has nothing to cover; two or
  // more participants (principal + member/staff/contact) does.
  "family.coverage-check": (db, householdId) => {
    const graph = graphRepo(db);
    const PARTICIPANT_TYPES: NodeType[] = [
      "person.principal",
      "person.member",
      "person.staff",
      "person.contact",
    ];
    let count = 0;
    for (const t of PARTICIPANT_TYPES) {
      count += graph.listNodes(householdId, { type: t }).length;
    }
    const threshold = 2;
    if (count < threshold) return null;
    return {
      reason: `${count} people on record — a monthly coverage plan surfaces gaps (nobody around when a principal travels) before they matter.`,
      signal: { count, threshold, unit: "people" },
    };
  },
};

export const computePlaybookSuggestions = (
  db: Db,
  householdId: HouseholdId,
  opts: PlaybookSuggestOpts = {},
): PlaybookSuggestion[] => {
  const registry = buildPlaybookRegistry();
  const enabled = new Set(
    householdPlaybookRepo(db)
      .list(householdId)
      .filter((r) => r.enabled === "yes")
      .map((r) => r.playbookId),
  );
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const windowStart = new Date(
    now.getTime() - windowDays * 86_400_000,
  ).toISOString();

  const out: PlaybookSuggestion[] = [];
  for (const def of registry.list()) {
    // Already enabled — no point suggesting.
    if (enabled.has(def.id)) continue;
    const check = SIGNAL_CHECKS[def.id];
    if (!check) continue;
    const signalBody = check(db, householdId, { windowStart });
    if (!signalBody) continue;
    out.push({
      playbookId: def.id,
      name: def.name,
      description: def.description,
      domain: def.domain,
      ...signalBody,
    });
  }
  return out;
};
