import {
  calendarEventRepo,
  credentialRepo,
  householdRepo,
  inboxRepo,
  syncStateRepo,
  type CalendarEventRow,
  type Db,
  type InboxMessageRow,
} from "@atelier/db";
import {
  syncGmailInbox,
  syncGoogleCalendar,
  type CalendarSyncCursor,
  type GmailSyncCursor,
} from "@atelier/agents";
import type { HouseholdId } from "@atelier/domain";
import type { Autopilot } from "./autopilot.js";
import type { PlaybookRunner } from "./playbook-runner.js";
import { runExpirationPass } from "./approval-expiry.js";

// Background sync scheduler. Every intervalSeconds it walks every
// household and, per provider it has an unrevoked credential for,
// runs the incremental sync — Gmail via History API into
// inbox_messages, Google Calendar via events.list syncToken into
// calendar_events. New activity lands without a manager clicking
// anything. Overlapping ticks are prevented by an in-flight flag,
// and an error on one household (or one provider) never stops the
// loop for the others.

export interface SchedulerOptions {
  readonly intervalSeconds: number;
  readonly logger: {
    info: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
  readonly enabled?: boolean;
  // Optional. When passed, freshly-inserted inbox messages and
  // calendar events are handed to the autopilot after each sync, so
  // proposed actions land in the approval queue without a manager
  // clicking Run intent. Absent = pure sync only.
  readonly autopilot?: Autopilot;
  // Optional. Fires playbooks whose next_fire_at has passed after
  // per-household sync + autopilot completes. Absent = no playbook
  // scheduling on this scheduler instance (useful in tests).
  readonly playbookRunner?: PlaybookRunner;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  runOnce(): Promise<{
    householdsChecked: number;
    householdsSynced: number;
    perHousehold: Array<{ householdId: string; result: unknown }>;
    playbooksFired?: number;
  }>;
}

export const buildScheduler = (db: Db, opts: SchedulerOptions): Scheduler => {
  const households = householdRepo(db);
  const credentials = credentialRepo(db);
  const inbox = inboxRepo(db);
  const calendarEvents = calendarEventRepo(db);
  const sync = syncStateRepo(db);

  let handle: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const gmailCursor = (): GmailSyncCursor => ({
    read: (h, provider) => {
      const row = sync.get(h, provider);
      if (!row) return null;
      const c = row.cursor as { historyId?: string } | null;
      return c && typeof c.historyId === "string" ? { historyId: c.historyId } : null;
    },
    save: (h, provider, cursor, lastResult) =>
      sync.save(h, provider, cursor, lastResult),
    clear: (h, provider) => sync.clear(h, provider),
  });

  const calendarCursor = (): CalendarSyncCursor => ({
    read: (h, provider) => {
      const row = sync.get(h, provider);
      if (!row) return null;
      const c = row.cursor as { syncToken?: string } | null;
      return c && typeof c.syncToken === "string" ? { syncToken: c.syncToken } : null;
    },
    save: (h, provider, cursor, lastResult) =>
      sync.save(h, provider, cursor, lastResult),
    clear: (h, provider) => sync.clear(h, provider),
  });

  const runOnce = async (): Promise<{
    householdsChecked: number;
    householdsSynced: number;
    perHousehold: Array<{ householdId: string; result: unknown }>;
  }> => {
    if (inFlight) {
      opts.logger.info("scheduler tick skipped — previous run still in flight");
      return { householdsChecked: 0, householdsSynced: 0, perHousehold: [] };
    }
    inFlight = true;
    try {
      const gmail = gmailCursor();
      const calendar = calendarCursor();
      const allHouseholds = households.list();
      let synced = 0;
      const perHousehold: Array<{ householdId: string; result: unknown }> = [];

      for (const hh of allHouseholds) {
        const providers = credentials
          .list(hh.id)
          .filter((c) => !c.revokedAt)
          .map((c) => c.provider);
        const hasGmail = providers.includes("gmail");
        const hasCalendar = providers.includes("google_calendar");
        if (!hasGmail && !hasCalendar) continue;

        const ctx = {
          householdId: hh.id as HouseholdId,
          readCredential: (provider: string) => credentials.getSecret(hh.id, provider),
          persistAccessToken: (id: string, at: string, exp: string) =>
            credentials.updateAccessToken(id, at, exp),
          logger: opts.logger,
        };

        const result: {
          gmail?: unknown;
          calendar?: unknown;
          errors: string[];
        } = { errors: [] };

        const newInboxRows: InboxMessageRow[] = [];
        const newCalendarRows: CalendarEventRow[] = [];

        if (hasGmail) {
          try {
            const r = await syncGmailInbox(
              ctx,
              {
                upsertMessage: (i) => {
                  const out = inbox.upsertExternal(i);
                  if (out.inserted) newInboxRows.push(out.row);
                  return { inserted: out.inserted };
                },
              },
              { cursorStore: gmail },
            );
            result.gmail = r;
            if (r.error) {
              result.errors.push(`gmail: ${r.error}`);
              opts.logger.error("scheduler gmail sync error", {
                householdId: hh.id,
                error: r.error,
              });
            } else if (r.inserted > 0) {
              opts.logger.info("scheduler gmail sync inserted", {
                householdId: hh.id,
                inserted: r.inserted,
                mode: r.mode,
              });
            }
          } catch (err) {
            result.errors.push(`gmail: ${(err as Error).message}`);
            opts.logger.error("scheduler gmail sync threw", {
              householdId: hh.id,
              error: (err as Error).message,
            });
          }
        }

        if (hasCalendar) {
          try {
            const r = await syncGoogleCalendar(
              ctx,
              {
                upsertEvent: (e) => {
                  const out = calendarEvents.upsertExternal(e);
                  if (out.inserted) newCalendarRows.push(out.row);
                  return { inserted: out.inserted, updated: out.updated };
                },
              },
              { cursorStore: calendar },
            );
            result.calendar = r;
            if (r.error) {
              result.errors.push(`calendar: ${r.error}`);
              opts.logger.error("scheduler calendar sync error", {
                householdId: hh.id,
                error: r.error,
              });
            } else if (r.inserted + r.updated > 0) {
              opts.logger.info("scheduler calendar sync applied", {
                householdId: hh.id,
                inserted: r.inserted,
                updated: r.updated,
                cancelled: r.cancelled,
                mode: r.mode,
              });
            }
          } catch (err) {
            result.errors.push(`calendar: ${(err as Error).message}`);
            opts.logger.error("scheduler calendar sync threw", {
              householdId: hh.id,
              error: (err as Error).message,
            });
          }
        }

        if (opts.autopilot && (newInboxRows.length > 0 || newCalendarRows.length > 0)) {
          try {
            const inboxSummary = await opts.autopilot.onNewInboxMessages(
              hh.id as HouseholdId,
              newInboxRows,
            );
            const calSummary = await opts.autopilot.onNewCalendarEvents(
              hh.id as HouseholdId,
              newCalendarRows,
            );
            (result as { autopilot?: unknown }).autopilot = {
              inbox: inboxSummary,
              calendar: calSummary,
            };
          } catch (err) {
            result.errors.push(`autopilot: ${(err as Error).message}`);
            opts.logger.error("scheduler autopilot threw", {
              householdId: hh.id,
              error: (err as Error).message,
            });
          }
        }

        synced++;
        perHousehold.push({ householdId: hh.id, result });
      }

      // Sweep expired approvals before playbook fires so a
      // playbook can't pick up an already-slipped ask this tick.
      // Failures inside runExpirationPass log per-row and the
      // sweep continues; a whole-sweep exception is caught and
      // the tick moves on.
      try {
        const exp = runExpirationPass(db, { logger: opts.logger });
        if (exp.expired > 0) {
          opts.logger.info("scheduler approval expiry applied", {
            expired: exp.expired,
            households: Object.keys(exp.byHousehold).length,
          });
        }
      } catch (err) {
        opts.logger.error("scheduler approval expiry threw", {
          error: (err as Error).message,
        });
      }

      let playbooksFired = 0;
      if (opts.playbookRunner) {
        try {
          const fires = await opts.playbookRunner.runDue();
          playbooksFired = fires.filter((f) => f.outcome === "fired").length;
          if (fires.length > 0) {
            opts.logger.info("scheduler playbook runner completed", {
              total: fires.length,
              fired: playbooksFired,
              skipped: fires.filter((f) => f.outcome === "skipped").length,
              errors: fires.filter((f) => f.outcome === "error").length,
            });
          }
        } catch (err) {
          opts.logger.error("scheduler playbook runner threw", {
            error: (err as Error).message,
          });
        }
      }

      return {
        householdsChecked: allHouseholds.length,
        householdsSynced: synced,
        perHousehold,
        ...(opts.playbookRunner ? { playbooksFired } : {}),
      };
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (handle) return;
      if (opts.enabled === false) {
        opts.logger.info("scheduler start requested but disabled");
        return;
      }
      const ms = Math.max(opts.intervalSeconds * 1000, 5_000);
      opts.logger.info("scheduler starting", { intervalMs: ms });
      // First tick immediately so a manager doesn't wait a full interval
      // for the first sync after starting the API.
      void runOnce().catch((err) =>
        opts.logger.error("scheduler initial run failed", {
          error: (err as Error).message,
        }),
      );
      handle = setInterval(() => {
        void runOnce().catch((err) =>
          opts.logger.error("scheduler tick failed", {
            error: (err as Error).message,
          }),
        );
      }, ms);
      handle.unref?.();
    },
    stop(): void {
      if (handle) {
        clearInterval(handle);
        handle = null;
        opts.logger.info("scheduler stopped");
      }
    },
    runOnce,
  };
};
