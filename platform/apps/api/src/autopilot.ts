import type { Orchestrator } from "@atelier/agents";
import type {
  CalendarEventRow,
  Db,
  InboxMessageRow,
} from "@atelier/db";
import { householdRepo } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "./runtime.js";

// The autopilot turns fresh sync activity into proactive agent runs
// so a manager reviews proposed actions in the approval queue instead
// of clicking "Run intent" for every new email or event.
//
// Contract with the scheduler: after a Gmail or Calendar sync, hand
// this module the newly-inserted rows and the household id. It builds
// the orchestrator, dispatches the matching intent per item, and
// reports what ran. Errors are logged and swallowed per item so one
// bad message doesn't stop the batch.
//
// A per-household autopilot toggle (households.autopilotEnabled) is
// respected — a frozen or opted-out household is skipped silently.

export interface AutopilotOptions {
  readonly maxParallel?: number;
  readonly logger?: {
    info: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

export interface AutopilotSummary {
  readonly dispatched: number;
  readonly skipped: number;
  readonly errors: number;
  readonly reasons: readonly string[];
}

const AUTOPILOT_ACTOR = {
  type: "system" as const,
  id: "autopilot",
  displayName: "Autopilot",
};

export const buildAutopilot = (db: Db, opts: AutopilotOptions = {}) => {
  const logger = opts.logger ?? { info: () => {}, error: () => {} };
  const households = householdRepo(db);

  const isReady = (
    householdId: HouseholdId,
  ): { ready: boolean; reason?: string } => {
    const hh = households.get(householdId);
    if (!hh) return { ready: false, reason: "household_missing" };
    if (!hh.autopilotEnabled) return { ready: false, reason: "autopilot_disabled" };
    if (hh.frozenAt) return { ready: false, reason: "household_frozen" };
    return { ready: true };
  };

  const buildRunSurface = (householdId: HouseholdId) => ({
    orch: buildOrchestrator(db) as Orchestrator,
    graph: buildGraphView(db, householdId),
    writer: buildGraphWriter(db, householdId, "system:autopilot"),
  });

  const onNewInboxMessages = async (
    householdId: HouseholdId,
    rows: readonly InboxMessageRow[],
  ): Promise<AutopilotSummary> => {
    if (rows.length === 0) return { dispatched: 0, skipped: 0, errors: 0, reasons: [] };
    const gate = isReady(householdId);
    if (!gate.ready) {
      logger.info("autopilot skipped inbox batch", {
        householdId,
        reason: gate.reason,
        rows: rows.length,
      });
      return { dispatched: 0, skipped: rows.length, errors: 0, reasons: [gate.reason ?? "unknown"] };
    }
    const { orch, graph, writer } = buildRunSurface(householdId);

    let dispatched = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        await orch.run({
          householdId,
          actor: AUTOPILOT_ACTOR,
          graph,
          writer,
          intent: {
            kind: "inbox.message.process",
            attrs: {
              messageId: row.id,
              fromName: row.fromName,
              fromAddress: row.fromAddress,
              subject: row.subject,
              body: row.body,
              receivedAt: row.receivedAt,
            },
            subjectPrincipalId: row.recipientPrincipalId ?? "any_principal",
            origin: { source: "proactive", by: "autopilot:inbox" },
          },
        });
        dispatched++;
      } catch (err) {
        errors++;
        logger.error("autopilot inbox dispatch threw", {
          householdId,
          messageId: row.id,
          error: (err as Error).message,
        });
      }
    }
    logger.info("autopilot inbox batch complete", {
      householdId,
      dispatched,
      errors,
    });
    return { dispatched, skipped: 0, errors, reasons: [] };
  };

  const onNewCalendarEvents = async (
    householdId: HouseholdId,
    rows: readonly CalendarEventRow[],
  ): Promise<AutopilotSummary> => {
    if (rows.length === 0) return { dispatched: 0, skipped: 0, errors: 0, reasons: [] };
    const gate = isReady(householdId);
    if (!gate.ready) {
      logger.info("autopilot skipped calendar batch", {
        householdId,
        reason: gate.reason,
        rows: rows.length,
      });
      return { dispatched: 0, skipped: rows.length, errors: 0, reasons: [gate.reason ?? "unknown"] };
    }
    const { orch, graph, writer } = buildRunSurface(householdId);

    let dispatched = 0;
    let errors = 0;
    for (const row of rows) {
      // Cancellations are noise for conflict detection; skip.
      if (row.status === "cancelled") continue;
      try {
        await orch.run({
          householdId,
          actor: AUTOPILOT_ACTOR,
          graph,
          writer,
          intent: {
            kind: "calendar.event.observe",
            attrs: {
              eventRef: row.externalEventId,
              calendarId: row.externalCalendarId,
              title: row.title,
              startAt: row.startAt,
              ...(row.endAt ? { endAt: row.endAt } : {}),
              ...(row.location ? { location: row.location } : {}),
            },
            subjectPrincipalId: "any_principal",
            origin: { source: "proactive", by: "autopilot:calendar" },
          },
        });
        dispatched++;
      } catch (err) {
        errors++;
        logger.error("autopilot calendar dispatch threw", {
          householdId,
          eventRef: row.externalEventId,
          error: (err as Error).message,
        });
      }
    }
    logger.info("autopilot calendar batch complete", {
      householdId,
      dispatched,
      errors,
    });
    return { dispatched, skipped: 0, errors, reasons: [] };
  };

  return { onNewInboxMessages, onNewCalendarEvents };
};

export type Autopilot = ReturnType<typeof buildAutopilot>;
