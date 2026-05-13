#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createFacilitatorApp } from "./app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
} from "./store.js";

const PORT = Number(process.env["PORT"] ?? 4901);
const BASE_URL = process.env["BASE_URL"] ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env["DATABASE_URL"];

async function buildStores() {
  if (DATABASE_URL) {
    // Production: Postgres-backed stores
    const { default: postgres } = await import("postgres");
    const {
      PostgresTenantStore,
      PostgresTemplateStore,
      PostgresAgreementStore,
      PostgresRequirementsStore,
    } = await import("./store-postgres.js");

    const sql = postgres(DATABASE_URL, {
      max: Number(process.env["DB_POOL_SIZE"] ?? "10"),
      idle_timeout: 30,
      connect_timeout: 10,
    });

    return {
      tenants: new PostgresTenantStore(sql),
      templates: new PostgresTemplateStore(sql),
      agreements: new PostgresAgreementStore(sql),
      requirements: new PostgresRequirementsStore(sql),
    };
  }

  // Development / demo: in-memory (data lost on restart)
  console.warn("⚠️  No DATABASE_URL — using in-memory stores. Data will not persist.");
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    agreements: new InMemoryAgreementStore(),
    requirements: new InMemoryRequirementsStore(),
  };
}

const stores = await buildStores();
const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL });

serve({ fetch: app.fetch, port: PORT }, () => {
  const backend = DATABASE_URL ? "postgres" : "in-memory";
  console.log(`x490 facilitator (${backend}) listening on ${BASE_URL}`);
  console.log(`  POST   ${BASE_URL}/v1/tenants               sign up`);
  console.log(`  POST   ${BASE_URL}/v1/templates              register template`);
  console.log(`  POST   ${BASE_URL}/v1/requirements           build ContractRequirements`);
  console.log(`  GET    ${BASE_URL}/v1/agreements             list agreements`);
  console.log(`  POST   ${BASE_URL}/v1/apikeys                create API key`);
  console.log(`  DELETE ${BASE_URL}/v1/apikeys/:keyId         revoke API key`);
  console.log(`  POST   ${BASE_URL}/v1/:tenantId/accept       accept (agent-facing)`);
  console.log(`  GET    ${BASE_URL}/v1/:tenantId/verify       verify (server-facing)`);
});
