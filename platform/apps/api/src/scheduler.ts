import {
  credentialRepo,
  householdRepo,
  inboxRepo,
  syncStateRepo,
  type Db,
} from "@atelier/db";
import { syncGmailInbox, type GmailSyncCursor } from "@atelier/agents";
import type { HouseholdId } from "@atelier/domain";

// Background sync scheduler. Every intervalSeconds it walks every
// household with a stored gmail credential and runs the incremental
// sync — new mail lands in the inbox without a manager clicking
// anything. Overlapping ticks are prevented by an in-flight flag.
// Errors on one household never stop the loop for the others.

export interface SchedulerOptions {
  readonly intervalSeconds: number;
  readonly logger: {
    info: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
  readonly enabled?: boolean;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  runOnce(): Promise<{
    householdsChecked: number;
    householdsSynced: number;
    perHousehold: Array<{ householdId: string; result: unknown }>;
  }>;
}

export const buildScheduler = (db: Db, opts: SchedulerOptions): Scheduler => {
  const households = householdRepo(db);
  const credentials = credentialRepo(db);
  const inbox = inboxRepo(db);
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
      const cursor = gmailCursor();
      const allHouseholds = households.list();
      let synced = 0;
      const perHousehold: Array<{ householdId: string; result: unknown }> = [];

      for (const hh of allHouseholds) {
        const hasGmail =
          credentials
            .list(hh.id)
            .some((c) => c.provider === "gmail" && !c.revokedAt);
        if (!hasGmail) continue;
        try {
          const result = await syncGmailInbox(
            {
              householdId: hh.id as HouseholdId,
              readCredential: (provider) => credentials.getSecret(hh.id, provider),
              persistAccessToken: (id, at, exp) =>
                credentials.updateAccessToken(id, at, exp),
              logger: opts.logger,
            },
            { upsertMessage: (i) => inbox.upsertExternal(i) },
            { cursorStore: cursor },
          );
          synced++;
          perHousehold.push({ householdId: hh.id, result });
          if (result.error) {
            opts.logger.error("scheduler gmail sync error", {
              householdId: hh.id,
              error: result.error,
            });
          } else if (result.inserted > 0) {
            opts.logger.info("scheduler gmail sync inserted", {
              householdId: hh.id,
              inserted: result.inserted,
              mode: result.mode,
            });
          }
        } catch (err) {
          opts.logger.error("scheduler gmail sync threw", {
            householdId: hh.id,
            error: (err as Error).message,
          });
          perHousehold.push({
            householdId: hh.id,
            result: { error: (err as Error).message },
          });
        }
      }

      return {
        householdsChecked: allHouseholds.length,
        householdsSynced: synced,
        perHousehold,
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
