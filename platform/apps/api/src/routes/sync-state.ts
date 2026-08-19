import type { FastifyPluginAsync } from "fastify";
import { syncStateRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Read-only view of every sync cursor stored for a household — one
// row per provider. Useful for the console to show "last synced"
// timestamps and for operators debugging a stuck cursor.
export const syncStateRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const sync = syncStateRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/sync-state",
    {
      config: {
        audit: { action: "sync_state.list", resourceType: "sync_state" },
      },
    },
    async (req) => ({
      syncState: sync.list(req.householdContext as HouseholdId),
    }),
  );
};
