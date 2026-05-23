#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createFacilitatorApp } from "./app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
  InMemoryEventStore,
  InMemoryPendingContractStore,
  InMemoryWebhookDeliveryStore,
} from "./store.js";

const PORT = Number(process.env["PORT"] ?? 4901);
const BASE_URL = process.env["BASE_URL"] ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env["DATABASE_URL"];
const AUTH0_DOMAIN = process.env["AUTH0_DOMAIN"];
const AUTH0_AUDIENCE = process.env["AUTH0_AUDIENCE"];

async function buildStores() {
  if (DATABASE_URL) {
    // Production: Postgres-backed stores
    const { default: postgres } = await import("postgres");
    const {
      PostgresTenantStore,
      PostgresTemplateStore,
      PostgresAgreementStore,
      PostgresRequirementsStore,
      PostgresWebhookStore,
      PostgresEventStore,
      PostgresPendingContractStore,
      PostgresWebhookDeliveryStore,
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
      webhooks: new PostgresWebhookStore(sql),
      events: new PostgresEventStore(sql),
      pendingContracts: new PostgresPendingContractStore(sql),
      deliveries: new PostgresWebhookDeliveryStore(sql),
    };
  }

  // Development / demo: in-memory (data lost on restart)
  console.warn("⚠️  No DATABASE_URL — using in-memory stores. Data will not persist.");
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    agreements: new InMemoryAgreementStore(),
    requirements: new InMemoryRequirementsStore(),
    webhooks: new InMemoryWebhookStore(),
    events: new InMemoryEventStore(),
    pendingContracts: new InMemoryPendingContractStore(),
    deliveries: new InMemoryWebhookDeliveryStore(),
  };
}

const stores = await buildStores();
const app = createFacilitatorApp({
  ...stores,
  baseUrl: BASE_URL,
  ...(AUTH0_DOMAIN ? { auth0Domain: AUTH0_DOMAIN } : {}),
  ...(AUTH0_AUDIENCE ? { auth0Audience: AUTH0_AUDIENCE } : {}),
  rateLimits: {
    ...(process.env.RATE_LIMIT_ACCEPT ? { accept: Number(process.env.RATE_LIMIT_ACCEPT) } : {}),
    ...(process.env.RATE_LIMIT_VERIFY ? { verify: Number(process.env.RATE_LIMIT_VERIFY) } : {}),
    ...(process.env.RATE_LIMIT_SIGNUP ? { signup: Number(process.env.RATE_LIMIT_SIGNUP) } : {}),
  },
});

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
