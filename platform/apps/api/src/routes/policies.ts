import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  approvalRepo,
  policyRepo,
  actionRepo,
  householdRepo,
  type Db,
} from "@atelier/db";
import {
  ActionRequest,
  PolicySpec,
  type HouseholdId,
  type PolicyId,
} from "@atelier/domain";
import { evaluate } from "@atelier/policy";
import {
  adoptSuggestion,
  computeSuggestions,
  dismissSuggestion,
} from "../policy-suggestions.js";

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

  // Lineage drill-in — resolve the ids stamped in
  // suggestion_lineage into the actual basis policy + basis
  // approvals. An auditor answering "why does this execute policy
  // exist?" reads the lineage tag on the row, then fetches this
  // to walk the full chain of custody in one round-trip.
  app.get<{ Params: { householdId: string; policyId: string } }>(
    "/households/:householdId/policies/:policyId/lineage",
    {
      config: {
        audit: {
          action: "policy.lineage.read",
          resourceType: "policy",
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const policy = policies.get(req.params.policyId as PolicyId);
      if (!policy || policy.householdId !== householdId) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Always return the policy details; lineage + basis are
      // populated only when the policy was adopted from a
      // suggestion. This lets the same endpoint back the reverse-
      // audit case (action → authorizing policy) where the policy
      // may be hand-written — the console renders the "manual"
      // variant instead of a spurious error.
      const lineage = policy.suggestionLineage ?? null;
      const basis =
        lineage ? policies.get(lineage.basisPolicyId) : null;
      const approvalsRepo = approvalRepo(db);
      const basisApprovals = lineage
        ? lineage.basisApprovalIds
            .map((id) => approvalsRepo.get(id))
            .filter((a): a is NonNullable<typeof a> => a !== null)
        : [];
      return {
        policy: {
          id: policy.id,
          label: policy.spec.label,
          autonomy: policy.spec.autonomy,
          actionClass: policy.spec.actionClass,
          domain: policy.spec.domain,
          subject: policy.spec.subject,
          effect: policy.spec.effect,
          createdAt: policy.createdAt,
          revokedAt: policy.revokedAt ?? null,
        },
        lineage,
        basisPolicy: basis
          ? {
              id: basis.id,
              label: basis.spec.label,
              autonomy: basis.spec.autonomy,
              actionClass: basis.spec.actionClass,
              domain: basis.spec.domain,
              subject: basis.spec.subject,
              revokedAt: basis.revokedAt ?? null,
            }
          : null,
        basisApprovals: basisApprovals.map((a) => ({
          id: a.id,
          state: a.state,
          summary: a.summary,
          actionClass: a.actionClass,
          subjectPrincipalId: a.subjectPrincipalId ?? null,
          resolvedAt: a.resolvedAt ?? null,
          resolvedByType: a.resolvedByType ?? null,
          resolvedById: a.resolvedById ?? null,
          amountUsd: a.amountUsd ?? null,
        })),
      };
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
      const { subjectPrincipalId, outputsHash, amountUsd, policyIdAuthorizing, approverId, approvalChannel, ...rest } = body.data;
      const row = actions.record({
        householdId: req.householdContext as HouseholdId,
        ...rest,
        domain: body.data.domain as never,
        ...(subjectPrincipalId !== undefined && { subjectPrincipalId }),
        ...(outputsHash !== undefined && { outputsHash }),
        ...(amountUsd !== undefined && { amountUsd }),
        ...(policyIdAuthorizing !== undefined && {
          policyIdAuthorizing: policyIdAuthorizing as PolicyId,
        }),
        ...(approverId !== undefined && { approverId }),
        ...(approvalChannel !== undefined && { approvalChannel }),
      });
      return reply.code(201).send({ action: row });
    },
  );

  // Autonomy ladder — suggest promoting an established approval
  // pattern to auto-execute. See apps/api/src/policy-suggestions.ts
  // and docs/33-permissions-and-autonomy.md §"Promotion loop".
  app.get<{
    Params: { householdId: string };
    Querystring: { threshold?: string; windowDays?: string };
  }>(
    "/households/:householdId/policies/suggestions",
    {
      config: {
        audit: {
          action: "policy.suggestions.list",
          resourceType: "policy",
        },
      },
    },
    async (req) => {
      const opts: { threshold?: number; windowDays?: number } = {};
      if (req.query.threshold) {
        const n = Number(req.query.threshold);
        if (Number.isFinite(n) && n >= 1) opts.threshold = Math.floor(n);
      }
      if (req.query.windowDays) {
        const n = Number(req.query.windowDays);
        if (Number.isFinite(n) && n >= 1) opts.windowDays = Math.floor(n);
      }
      const suggestions = computeSuggestions(
        db,
        req.householdContext as HouseholdId,
        opts,
      );
      return { suggestions };
    },
  );

  const AdoptSuggestionBody = z.object({
    actionClass: z.string().min(1),
    subjectPrincipalId: z.string().nullable().optional(),
    // Optional discriminator so a demotion adopt never accidentally
    // picks up a promotion suggestion for the same pattern (they
    // can't both exist today, but future config could produce
    // overlapping kinds — pin what the manager clicked).
    kind: z.enum(["promote", "demote"]).optional(),
  });

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/policies/suggestions/adopt",
    {
      config: {
        audit: {
          action: "policy.suggestions.adopt",
          resourceType: "policy",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const body = AdoptSuggestionBody.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: body.error.issues });
      }
      const result = adoptSuggestion(db, {
        householdId: req.householdContext as HouseholdId,
        actionClass: body.data.actionClass,
        subjectPrincipalId: body.data.subjectPrincipalId ?? null,
        assertedBy: req.actor.id,
        ...(body.data.kind !== undefined && { kind: body.data.kind }),
      });
      if ("error" in result) {
        return reply.code(404).send({ error: result.error });
      }
      return reply.code(201).send({ policy: result.adopted });
    },
  );

  const DismissSuggestionBody = z.object({
    actionClass: z.string().min(1),
    subjectPrincipalId: z.string().nullable().optional(),
  });

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/policies/suggestions/dismiss",
    {
      config: {
        audit: {
          action: "policy.suggestions.dismiss",
          resourceType: "policy",
        },
      },
    },
    async (req, reply) => {
      const body = DismissSuggestionBody.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: body.error.issues });
      }
      const result = dismissSuggestion(db, {
        householdId: req.householdContext as HouseholdId,
        actionClass: body.data.actionClass,
        subjectPrincipalId: body.data.subjectPrincipalId ?? null,
        dismissedBy: req.actor.id,
      });
      if ("error" in result) {
        return reply.code(404).send({ error: result.error });
      }
      return reply.code(204).send();
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
