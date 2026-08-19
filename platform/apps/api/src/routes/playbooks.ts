import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { householdPlaybookRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildPlaybookRegistry, computeNextFireAt } from "@atelier/agents";
import { buildPlaybookRunner } from "../playbook-runner.js";

// Playbooks — packaged autonomy templates. GET returns the catalog
// with each entry annotated by this household's enablement state.
// Enable-or-update via PUT with an optional per-household config
// override (defaults come from the definition). Manual fire via
// POST /:playbookId/run for testing or a "run it now" button.

const EnableBody = z.object({
  config: z.record(z.unknown()).optional(),
});

export const playbookRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const registry = buildPlaybookRegistry();
  const repo = householdPlaybookRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/playbooks",
    { config: { audit: { action: "playbook.list", resourceType: "household_playbook" } } },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const enabled = new Map(
        repo.list(householdId).map((r) => [r.playbookId, r] as const),
      );
      return {
        playbooks: registry.list().map((def) => {
          const state = enabled.get(def.id);
          return {
            id: def.id,
            name: def.name,
            description: def.description,
            domain: def.domain,
            schedule: def.schedule,
            defaultConfig: def.defaultConfig,
            enabled: state?.enabled === "yes",
            registered: Boolean(state),
            config: state?.config ?? def.defaultConfig,
            lastFireAt: state?.lastFireAt ?? null,
            nextFireAt: state?.nextFireAt ?? null,
            lastRunId: state?.lastRunId ?? null,
          };
        }),
      };
    },
  );

  app.put<{ Params: { householdId: string; playbookId: string } }>(
    "/households/:householdId/playbooks/:playbookId",
    {
      config: {
        audit: { action: "playbook.enable", resourceType: "household_playbook" },
      },
    },
    async (req, reply) => {
      const def = registry.get(req.params.playbookId);
      if (!def) return reply.code(404).send({ error: "unknown_playbook" });
      const parsed = EnableBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const config = { ...def.defaultConfig, ...(parsed.data.config ?? {}) };
      const nextFireAt = computeNextFireAt(def.schedule, new Date()).toISOString();
      const row = repo.upsert({
        householdId: req.householdContext as HouseholdId,
        playbookId: def.id,
        config,
        nextFireAt,
      });
      return { playbook: row };
    },
  );

  app.delete<{ Params: { householdId: string; playbookId: string } }>(
    "/households/:householdId/playbooks/:playbookId",
    {
      config: {
        audit: { action: "playbook.disable", resourceType: "household_playbook" },
      },
    },
    async (req, reply) => {
      const def = registry.get(req.params.playbookId);
      if (!def) return reply.code(404).send({ error: "unknown_playbook" });
      repo.setEnabled(req.householdContext as HouseholdId, def.id, false);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { householdId: string; playbookId: string } }>(
    "/households/:householdId/playbooks/:playbookId/run",
    {
      config: {
        audit: {
          action: "playbook.run",
          resourceType: "household_playbook",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const def = registry.get(req.params.playbookId);
      if (!def) return reply.code(404).send({ error: "unknown_playbook" });
      const state = repo.get(req.householdContext as HouseholdId, def.id);
      if (!state) {
        return reply
          .code(400)
          .send({ error: "not_enabled", message: "Enable this playbook first." });
      }
      const runner = buildPlaybookRunner(db, {
        logger: {
          info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
          error: (msg, ctx) => req.log.error({ ...(ctx as object) }, msg),
        },
      });
      const result = await runner.fireById(
        req.householdContext as HouseholdId,
        def.id,
      );
      return { fire: result };
    },
  );
};
