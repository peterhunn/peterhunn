import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  policyRepo,
  graphRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let hh: HouseholdId;

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;

  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  policyRepo(db).create({
    householdId: hh,
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
      label: "Household vendor scheduling",
    },
    provenance: { source: "customer_direct", assertedBy: m.id, confidence: 1 },
  });

  graphRepo(db).createNode(hh, {
    type: "org.vendor",
    data: { name: "Acme HVAC", notes: "HVAC quarterly" },
    provenance: {
      source: "customer_direct",
      assertedBy: m.id,
      assertedAt: new Date().toISOString(),
      confidence: 1,
      status: "confirmed",
    },
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("orchestrator end-to-end", () => {
  it("runs a household vendor.schedule intent through policy, tool, and ledger", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/orchestrator/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "household.vendor.schedule",
        subjectPrincipalId: "any_principal",
        attrs: { propertyNodeId: "nod_home", serviceType: "HVAC" },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(res.statusCode).toBe(200);
    const run = res.json().run;
    expect(run.state).toBe("completed");
    expect(run.tasks[0].state).toBe("completed");

    const actions = await app.inject({
      method: "GET",
      url: `/households/${hh}/actions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const list: Array<{ actionClass: string; outcome: string; policyIdAuthorizing: string | null }> =
      actions.json().actions;
    const scheduled = list.find((a) => a.actionClass === "vendor.schedule");
    expect(scheduled?.outcome).toBe("succeeded");
    expect(scheduled?.policyIdAuthorizing).not.toBeNull();

    const tasks = await app.inject({
      method: "GET",
      url: `/households/${hh}/tasks`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tasks.json().tasks.length).toBeGreaterThan(0);
  });
});
