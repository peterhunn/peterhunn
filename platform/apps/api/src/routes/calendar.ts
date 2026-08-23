import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  calendarEventRepo,
  credentialRepo,
  syncStateRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { syncGoogleCalendar, type CalendarSyncCursor } from "@atelier/agents";
import { stripUndefined } from "../util.js";

const SyncBody = z
  .object({
    pastDays: z.number().int().positive().max(365).optional(),
    futureDays: z.number().int().positive().max(730).optional(),
  })
  .default({});

const ListQuery = z.object({
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const calendarRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const events = calendarEventRepo(db);
  const credentials = credentialRepo(db);
  const sync = syncStateRepo(db);

  const cursor: CalendarSyncCursor = {
    read: (h, provider) => {
      const row = sync.get(h, provider);
      if (!row) return null;
      const c = row.cursor as { syncToken?: string } | null;
      return c && typeof c.syncToken === "string" ? { syncToken: c.syncToken } : null;
    },
    save: (h, provider, next, lastResult) => sync.save(h, provider, next, lastResult),
    clear: (h, provider) => sync.clear(h, provider),
  };

  app.get<{ Params: { householdId: string }; Querystring: Record<string, string> }>(
    "/households/:householdId/calendar/events",
    {
      config: { audit: { action: "calendar.events.list", resourceType: "calendar_event" } },
    },
    async (req, reply) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) {
        return reply.code(400).send({ error: "invalid_query", issues: q.error.issues });
      }
      return {
        events: events.list(req.householdContext as HouseholdId, stripUndefined(q.data)),
      };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/calendar/sync",
    {
      config: {
        audit: {
          action: "calendar.sync",
          resourceType: "calendar_event",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const body = SyncBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const householdId = req.householdContext as HouseholdId;

      const result = await syncGoogleCalendar(
        {
          householdId,
          readCredential: (provider) => credentials.getSecret(householdId, provider),
          persistAccessToken: (id, at, exp) =>
            credentials.updateAccessToken(id, at, exp),
          logger: {
            info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
          },
        },
        { upsertEvent: (e) => events.upsertExternal(e) },
        { ...stripUndefined(body.data), cursorStore: cursor },
      );

      if (!result.consulted) {
        return reply.code(400).send({
          error: "google_calendar_not_connected",
          message:
            "No `google_calendar` credential is stored for this household. Connect Google to enable sync.",
        });
      }
      if (result.error) {
        return reply
          .code(502)
          .send({ error: "google_calendar_sync_failed", detail: result.error });
      }
      return { sync: result };
    },
  );
};
