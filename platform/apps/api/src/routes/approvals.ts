import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  actionRepo,
  approvalRepo,
  credentialRepo,
  identityRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import {
  ApproveInput,
  RejectInput,
  type ActionOutcome,
  type Domain,
  type HouseholdId,
  type PolicyId,
} from "@atelier/domain";
import { buildToolRegistry } from "../runtime.js";

const hash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

export const approvalRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const approvals = approvalRepo(db);
  const actions = actionRepo(db);
  const tasks = taskRepo(db);
  const identity = identityRepo(db);
  const credentials = credentialRepo(db);
  const tools = buildToolRegistry();

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/approvals",
    { config: { audit: { action: "approval.list", resourceType: "approval" } } },
    async (req) => ({
      approvals: approvals.listAll(req.householdContext as HouseholdId),
    }),
  );

  // Cross-household inbox for a manager. Uses the actor's grants.
  app.get("/approvals/inbox", async (req) => {
    if (req.actor.type !== "manager") return { approvals: [] };
    return { approvals: approvals.listPendingAcross(req.actor.householdIds) };
  });

  app.post<{ Params: { householdId: string; approvalId: string } }>(
    "/households/:householdId/approvals/:approvalId/approve",
    { config: { audit: { action: "approval.approve", resourceType: "approval", sensitive: true } } },
    async (req, reply) => {
      const parsed = ApproveInput.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const item = approvals.get(req.params.approvalId);
      if (!item) return reply.code(404).send({ error: "not_found" });
      if (item.householdId !== req.householdContext) {
        return reply.code(403).send({ error: "household_mismatch" });
      }
      if (item.state !== "pending") {
        return reply.code(409).send({ error: "not_pending", state: item.state });
      }

      // A customer-approval item requires customer authorization to
      // release. Phase-0 shim: a manager may proxy approval and it's
      // audited as such. Real customer identity replaces this.
      const isCustomerApproval = item.kind === "customer_approval";
      const proxied = isCustomerApproval && req.actor.type === "manager";

      const toolInputs = parsed.data.editedInputs ?? item.toolInputs;
      const tool = tools.get(item.toolName);

      let outcome: ActionOutcome;
      let outputs: unknown;
      let summary: string;
      let amountUsd: number | undefined;
      try {
        const invocation = await tool.invoke(
          {
            householdId: item.householdId,
            authorityId: item.authorityPolicyId,
            proposedBy: {
              actor: item.proposedBy.agent,
              version: item.proposedBy.agentVersion,
            },
            readCredential: (provider) =>
              credentials.getSecret(item.householdId, provider),
            logger: { info: () => {} },
          },
          {
            inputs: toolInputs,
            ...(item.amountUsd !== undefined && { amountUsd: item.amountUsd }),
            summary: item.summary,
          },
        );
        outcome = invocation.outcome;
        outputs = invocation.outputs;
        summary = invocation.summary;
        amountUsd = invocation.amountUsd;
      } catch (err) {
        outcome = "failed_permanent";
        outputs = null;
        summary = `Tool threw: ${(err as Error).message}`;
      }

      const record = actions.record({
        householdId: item.householdId as HouseholdId,
        ...(item.subjectPrincipalId !== undefined && {
          subjectPrincipalId: item.subjectPrincipalId,
        }),
        agent: item.proposedBy.agent,
        agentVersion: item.proposedBy.agentVersion,
        tool: item.toolName,
        toolVersion: item.toolVersion,
        actionClass: item.actionClass,
        domain: item.domain as Domain,
        inputsHash: hash(toolInputs),
        outputsHash: hash(outputs),
        ...(amountUsd !== undefined && { amountUsd }),
        ...(item.authorityPolicyId !== undefined && {
          policyIdAuthorizing: item.authorityPolicyId as PolicyId,
        }),
        approverId: req.actor.id,
        approvalChannel: proxied ? "manager_proxy" : req.actor.type,
        outcome,
        summary,
      });

      approvals.resolve(item.id, {
        state: parsed.data.editedInputs ? "approved_with_edit" : "approved",
        resolvedByType: req.actor.type === "manager" ? "manager" : "principal",
        resolvedById: req.actor.id,
        ...(parsed.data.note !== undefined && { resolutionNote: parsed.data.note }),
        resultActionId: record.id,
        ...(parsed.data.editedInputs !== undefined && { editedInputs: parsed.data.editedInputs }),
      });

      // Also close the task that spawned this approval.
      tasks.updateTask(item.taskId, {
        state: outcome === "succeeded" ? "completed" : "failed",
        decisionSummary: summary,
        outputs: { approvalId: item.id, actionId: record.id, outcome },
        ...(outcome !== "succeeded" && {
          errorMessage: `Tool outcome: ${outcome}`,
        }),
      });

      return { approval: approvals.get(item.id), action: record };
    },
  );

  app.post<{ Params: { householdId: string; approvalId: string } }>(
    "/households/:householdId/approvals/:approvalId/reject",
    { config: { audit: { action: "approval.reject", resourceType: "approval", sensitive: true } } },
    async (req, reply) => {
      const parsed = RejectInput.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const item = approvals.get(req.params.approvalId);
      if (!item) return reply.code(404).send({ error: "not_found" });
      if (item.householdId !== req.householdContext) {
        return reply.code(403).send({ error: "household_mismatch" });
      }
      if (item.state !== "pending") {
        return reply.code(409).send({ error: "not_pending", state: item.state });
      }

      approvals.resolve(item.id, {
        state: "rejected",
        resolvedByType: req.actor.type === "manager" ? "manager" : "principal",
        resolvedById: req.actor.id,
        resolutionNote: parsed.data.note,
      });

      tasks.updateTask(item.taskId, {
        state: "rejected",
        decisionSummary: `Rejected by ${req.actor.type}: ${parsed.data.note}`,
        outputs: { approvalId: item.id },
      });

      return { approval: approvals.get(item.id) };
    },
  );

  // Handy for the seed script to verify identity path is loaded.
  void identity;
};
