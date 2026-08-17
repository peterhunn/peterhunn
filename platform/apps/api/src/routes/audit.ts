import type { FastifyPluginAsync } from "fastify";
import { auditRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Household-scoped read of the audit log. A customer requesting their
// own trail (via a manager) reads it here.
export const auditRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const audit = auditRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/audit",
    { config: { audit: { action: "audit.list", resourceType: "audit", sensitive: true } } },
    async (req) => {
      return { events: audit.listForHousehold(req.householdContext as HouseholdId) };
    },
  );
};
