import type { FastifyPluginAsync } from "fastify";
import {
  auditChainRepo,
  auditRepo,
  HOUSEHOLD_CHAIN_KEY,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Household-scoped read of the audit log. A customer requesting their
// own trail (via a manager) reads it here.
export const auditRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const audit = auditRepo(db);
  const chain = auditChainRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/audit",
    { config: { audit: { action: "audit.list", resourceType: "audit", sensitive: true } } },
    async (req) => {
      return { events: audit.listForHousehold(req.householdContext as HouseholdId) };
    },
  );

  // Current head of the household's Merkle DAG. The customer (via
  // their manager) receives this hash as the tamper-evidence
  // anchor for the household chain. A separate person head is
  // also exposed under /audit/chain/person/:principalId.
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/audit/chain/head",
    {
      config: {
        audit: {
          action: "audit.chain.head",
          resourceType: "audit_chain",
          sensitive: true,
        },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const head = chain.getHead(householdId, HOUSEHOLD_CHAIN_KEY);
      return { chain: "household", head };
    },
  );

  app.get<{ Params: { householdId: string; principalId: string } }>(
    "/households/:householdId/audit/chain/person/:principalId/head",
    {
      config: {
        audit: {
          action: "audit.chain.head.person",
          resourceType: "audit_chain",
          sensitive: true,
        },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const head = chain.getHead(householdId, req.params.principalId);
      return {
        chain: "person",
        principalId: req.params.principalId,
        head,
      };
    },
  );

  // Re-hash every event on the household chain and compare to the
  // stored hash + head. Response is small even for large chains —
  // { valid, eventCount, headHash, brokenAtEventId? }.
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/audit/chain/verify",
    {
      config: {
        audit: {
          action: "audit.chain.verify",
          resourceType: "audit_chain",
          sensitive: true,
        },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      return { result: chain.verifyHouseholdChain(householdId) };
    },
  );

  app.get<{ Params: { householdId: string; principalId: string } }>(
    "/households/:householdId/audit/chain/person/:principalId/verify",
    {
      config: {
        audit: {
          action: "audit.chain.verify.person",
          resourceType: "audit_chain",
          sensitive: true,
        },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      return {
        result: chain.verifyPersonChain(householdId, req.params.principalId),
      };
    },
  );
};
