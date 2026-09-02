import type { Intent } from "./types.js";

// Playbooks are packaged autonomy templates — a named recipe that
// bundles a schedule, an intent shape, and default per-household
// configuration. They ship as code (like the model registry and the
// planner) so a household enabling a playbook doesn't require any
// manager-authored DSL: pick one, review the defaults, click enable.
//
// Contract:
// - `id` is a stable slug. The scheduler stores enabled playbooks by
//   id in household_playbooks; renaming the playbook without changing
//   the slug preserves the enablement.
// - `defaultConfig` is what a household starts with when it enables
//   the playbook. Managers can override any field via
//   POST /households/:id/playbooks/:playbookId (config).
// - `buildIntent(config)` produces the intent the runner dispatches
//   through the orchestrator on each firing.
// - `schedule` is a simple recurrence rule the playbook runner walks
//   on every scheduler tick.

export type PlaybookSchedule =
  | { readonly kind: "interval_hours"; readonly hours: number }
  | { readonly kind: "weekly"; readonly dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; readonly hourUtc: number }
  | { readonly kind: "monthly"; readonly dayOfMonth: number; readonly hourUtc: number };

export interface PlaybookDefinition<Config extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  readonly schedule: PlaybookSchedule;
  readonly defaultConfig: Config;
  buildIntent(config: Config): Omit<Intent, "origin">;
}

// ── Registry ───────────────────────────────────────────────────────

class PlaybookRegistry {
  private readonly byId = new Map<string, PlaybookDefinition>();

  register<C extends Record<string, unknown>>(def: PlaybookDefinition<C>): void {
    if (this.byId.has(def.id)) {
      throw new Error(`Duplicate playbook id: ${def.id}`);
    }
    this.byId.set(def.id, def as PlaybookDefinition);
  }

  get(id: string): PlaybookDefinition | undefined {
    return this.byId.get(id);
  }

  list(): readonly PlaybookDefinition[] {
    return Array.from(this.byId.values());
  }
}

// ── First-class playbooks ─────────────────────────────────────────

interface WeeklyRenewalsConfig extends Record<string, unknown> {
  readonly windowDays: number;
}

const weeklyRenewalsReview: PlaybookDefinition<WeeklyRenewalsConfig> = {
  id: "admin.weekly-renewals-review",
  name: "Weekly renewals review",
  description:
    "Every Monday morning, scan every document.* node with an expiresAt inside a rolling window and queue an obligation.deadline candidate for anything expiring soon. Missed renewals are one of the most-common household failures; the manager just reviews what the batch turned up.",
  domain: "admin",
  schedule: { kind: "weekly", dayOfWeek: 1, hourUtc: 14 }, // Monday 14:00 UTC = 07:00 PT
  defaultConfig: { windowDays: 60 },
  buildIntent(config) {
    return {
      kind: "admin.renewals.review",
      attrs: { windowDays: config.windowDays },
      subjectPrincipalId: "any_principal",
    };
  },
};

interface TravelPrepConfig extends Record<string, unknown> {
  readonly leadDays: number;
}

const travelPrepSweep: PlaybookDefinition<TravelPrepConfig> = {
  id: "travel.prep-sweep",
  name: "Travel prep sweep",
  description:
    "Every Sunday evening, look at the next few weeks on the calendar for anything travel-shaped (multi-day away, out-of-town keywords) and run the trip planner over it — identity doc validity check, coverage plan, ground transport. Anything actionable lands in the approval queue.",
  domain: "travel",
  schedule: { kind: "weekly", dayOfWeek: 0, hourUtc: 2 }, // Sunday 02:00 UTC = Sat 18:00 PT
  defaultConfig: { leadDays: 21 },
  buildIntent(config) {
    // A generic weekly sweep — no specific destination. The travel
    // agent's planner tolerates a bare prompt and uses graph state
    // to find upcoming trips.
    return {
      kind: "travel.trip.plan",
      attrs: {
        destination: "(weekly sweep)",
        startAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        endAt: new Date(
          Date.now() + (7 + config.leadDays) * 86400_000,
        ).toISOString(),
        notes: `Weekly travel prep sweep — scan the next ${config.leadDays} days for anything trip-shaped and surface concerns.`,
      },
      subjectPrincipalId: "any_principal",
    };
  },
};

interface FamilyCoverageConfig extends Record<string, unknown> {
  readonly horizonDays: number;
}

const familyCoverageCheck: PlaybookDefinition<FamilyCoverageConfig> = {
  id: "family.coverage-check",
  name: "Family coverage check",
  description:
    "Monthly on the 1st, propose a coverage plan across household members, staff, and trusted contacts for the coming period so that gaps (nobody around when a principal is traveling) surface before they matter.",
  domain: "family",
  schedule: { kind: "monthly", dayOfMonth: 1, hourUtc: 15 },
  defaultConfig: { horizonDays: 30 },
  buildIntent(config) {
    const now = Date.now();
    return {
      kind: "family.coverage.propose",
      attrs: {
        startAt: new Date(now).toISOString(),
        endAt: new Date(now + config.horizonDays * 86400_000).toISOString(),
        notes: `Monthly coverage check — ${config.horizonDays}-day horizon.`,
      },
      subjectPrincipalId: "any_principal",
    };
  },
};

export const buildPlaybookRegistry = (): PlaybookRegistry => {
  const registry = new PlaybookRegistry();
  registry.register(weeklyRenewalsReview);
  registry.register(travelPrepSweep);
  registry.register(familyCoverageCheck);
  return registry;
};

export type { PlaybookRegistry };

// ── Scheduler-side helper ──────────────────────────────────────────

// Compute the next firing time (UTC ISO) strictly greater than `from`
// for a schedule. Simple ceil-to-next-slot semantics: no calendar
// libraries, no cron parsing. If a household's playbook was firing
// every Monday and we skip a Monday (API down), the next tick picks
// it up on the following Monday — this is coarser than a proper
// cron scheduler but appropriate at phase-0 fidelity.
export const computeNextFireAt = (
  schedule: PlaybookSchedule,
  from: Date,
): Date => {
  if (schedule.kind === "interval_hours") {
    return new Date(from.getTime() + schedule.hours * 3600_000);
  }
  if (schedule.kind === "weekly") {
    const next = new Date(from.getTime());
    next.setUTCHours(schedule.hourUtc, 0, 0, 0);
    const currentDay = next.getUTCDay();
    let dayDelta = (schedule.dayOfWeek - currentDay + 7) % 7;
    if (dayDelta === 0 && next <= from) dayDelta = 7;
    next.setUTCDate(next.getUTCDate() + dayDelta);
    return next;
  }
  // monthly
  const next = new Date(from.getTime());
  next.setUTCHours(schedule.hourUtc, 0, 0, 0);
  next.setUTCDate(schedule.dayOfMonth);
  if (next <= from) {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};
