import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let managerToken: string;
let householdId: HouseholdId;

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });

  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@example.com" });
  managerToken = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;

  const hh = householdRepo(db).create({ name: "TestHH", tier: "life" });
  householdId = hh.id;
  identity.grantHousehold({
    managerId: m.id,
    householdId: hh.id,
    role: "primary",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

const authed = { authorization: () => `Bearer ${managerToken}` };

describe("policy lifecycle", () => {
  it("creates, lists, and evaluates a policy end to end", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/households/${householdId}/policies`,
      headers: { authorization: authed.authorization() },
      payload: {
        spec: {
          effect: "allow",
          kind: "standing",
          subject: "any_principal",
          domain: "household",
          actionClass: "vendor.schedule",
          scope: {},
          autonomy: "execute",
          limits: {},
          approval: { conditions: [], fallbackApprover: "manager" },
          window: {},
          label: "vendor scheduling — established vendors",
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const policyId = create.json().policy.id;

    const list = await app.inject({
      method: "GET",
      url: `/households/${householdId}/policies`,
      headers: { authorization: authed.authorization() },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().policies).toHaveLength(1);

    const evalRes = await app.inject({
      method: "POST",
      url: `/households/${householdId}/policies/evaluate`,
      headers: { authorization: authed.authorization() },
      payload: {
        subjectPrincipalId: "any_principal",
        domain: "household",
        actionClass: "vendor.schedule",
        sideEffectClass: "write_reversible",
        attrs: {},
        proposedBy: { actor: "test", version: "0" },
      },
    });
    expect(evalRes.statusCode).toBe(200);
    const decision = evalRes.json().decision;
    expect(decision.decision).toBe("auto_execute");
    expect(decision.authorityId).toBe(policyId);
  });

  it("freeze produces a shelved decision on subsequent evaluate", async () => {
    await app.inject({
      method: "POST",
      url: `/households/${householdId}/freeze`,
      headers: { authorization: authed.authorization() },
      payload: { reason: "customer requested pause" },
    });
    const evalRes = await app.inject({
      method: "POST",
      url: `/households/${householdId}/policies/evaluate`,
      headers: { authorization: authed.authorization() },
      payload: {
        subjectPrincipalId: "any_principal",
        domain: "household",
        actionClass: "vendor.schedule",
        sideEffectClass: "write_reversible",
        attrs: {},
        proposedBy: { actor: "test", version: "0" },
      },
    });
    expect(evalRes.json().decision.decision).toBe("shelved");

    await app.inject({
      method: "POST",
      url: `/households/${householdId}/unfreeze`,
      headers: { authorization: authed.authorization() },
    });
  });

  it("records an action with the authorizing policy id", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/households/${householdId}/policies`,
      headers: { authorization: authed.authorization() },
    });
    const policyId = list.json().policies[0].id;

    const rec = await app.inject({
      method: "POST",
      url: `/households/${householdId}/actions`,
      headers: { authorization: authed.authorization() },
      payload: {
        agent: "household_agent",
        agentVersion: "0.1.0",
        tool: "vendor.schedule",
        toolVersion: "0.1.0",
        actionClass: "vendor.schedule",
        domain: "household",
        inputsHash: "abc123",
        policyIdAuthorizing: policyId,
        outcome: "succeeded",
        summary: "Scheduled quarterly HVAC service with Acme HVAC",
      },
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().action.policyIdAuthorizing).toBe(policyId);
  });
});
