import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { policyRepo, actionRepo, householdRepo, type Db } from "@atelier/db";
import {
  ActionRequest,
  PolicySpec,
  type HouseholdId,
  type PolicyId,
} from "@atelier/domain";
import { evaluate } from "@atelier/policy";

const CreatePolicyBody = z.object({
  spec: PolicySpec,
});

const EvaluateBody = ActionRequest;

const RecordActionBody = z.object({
  subjectPrincipalId: z.string().optional(),
  agent: z.string(),
  agentVersion: z.string().default("0"),
  tool: z.string(),
  toolVersion: z.string().default("0"),
  actionClass: z.string(),
  domain: z.string(),
  inputsHash: z.string(),
  outputsHash: z.string().optional(),
  amountUsd: z.number().nonnegative().optional(),
  policyIdAuthorizing: z.string().optional(),
  approverId: z.string().optional(),
  approvalChannel: z.string().optional(),
  outcome: z.enum([
    "planned",
    "in_flight",
    "succeeded",
    "failed_transient",
    "failed_permanent",
    "rolled_back",
  ]),
  summary: z.string(),
});

const FreezeBody = z.object({
  reason: z.string().min(1),
});

export const policyRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const policies = policyRepo(db);
  const actions = actionRepo(db);
  const households = householdRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/policies",
    { config: { audit: { action: "policy.list", resourceType: "policy" } } },
    async (req) => ({ policies: policies.list(req.householdContext as HouseholdId) }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/policies",
    { config: { audit: { action: "policy.create", resourceType: "policy", sensitive: true } } },
    async (req, reply) => {
      const body = CreatePolicyBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
      }
      const policy = policies.create({
        householdId: req.householdContext as HouseholdId,
        spec: body.data.spec,
        provenance: {
          source: "manager_observed",
          assertedBy: req.actor.id,
          confidence: 1,
        },
      });
      return reply.code(201).send({ policy });
    },
  );

  app.delete<{ Params: { householdId: string; policyId: string } }>(
    "/households/:householdId/policies/:policyId",
    { config: { audit: { action: "policy.revoke", resourceType: "policy", sensitive: true } } },
    async (req, reply) => {
      policies.revoke(req.params.policyId as PolicyId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/policies/evaluate",
    { config: { audit: { action: "policy.evaluate", resourceType: "policy" } } },
    async (req, reply) => {
      const body = EvaluateBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const decision = evaluate(
        {
          policies: {
            match: (i) => policies.match(i),
          },
          rollups: {
            amountRollup: (h, ac, r) => actions.amountRollup(h, ac, r),
            countRollup: (h, ac, r) => actions.countRollup(h, ac, r),
          },
          household: {
            isFrozen: (h) => households.get(h)?.frozenAt !== undefined,
          },
        },
        { householdId, request: body.data },
      );
      return { decision };
    },
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/actions",
    { config: { audit: { action: "action.list", resourceType: "action" } } },
    async (req) => ({ actions: actions.list(req.householdContext as HouseholdId) }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/actions",
    { config: { audit: { action: "action.record", resourceType: "action" } } },
    async (req, reply) => {
      const body = RecordActionBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
      }
      const row = actions.record({
        householdId: req.householdContext as HouseholdId,
        ...body.data,
        policyIdAuthorizing: body.data.policyIdAuthorizing as PolicyId | undefined,
        domain: body.data.domain as never,
      });
      return reply.code(201).send({ action: row });
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/freeze",
    { config: { audit: { action: "household.freeze", resourceType: "household", sensitive: true } } },
    async (req, reply) => {
      const body = FreezeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      households.freeze(req.householdContext as HouseholdId, body.data.reason);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/unfreeze",
    { config: { audit: { action: "household.unfreeze", resourceType: "household", sensitive: true } } },
    async (req, reply) => {
      households.unfreeze(req.householdContext as HouseholdId);
      return reply.code(204).send();
    },
  );
};
