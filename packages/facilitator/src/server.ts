#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createFacilitatorApp } from "./app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
} from "./store.js";

const PORT = Number(process.env["PORT"] ?? 4901);
const BASE_URL = process.env["BASE_URL"] ?? `http://localhost:${PORT}`;

const app = createFacilitatorApp({
  tenants: new InMemoryTenantStore(),
  templates: new InMemoryTemplateStore(),
  agreements: new InMemoryAgreementStore(),
  baseUrl: BASE_URL,
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`x490 facilitator listening on ${BASE_URL}`);
  console.log(`  POST ${BASE_URL}/v1/tenants          sign up`);
  console.log(`  POST ${BASE_URL}/v1/templates         register template`);
  console.log(`  POST ${BASE_URL}/v1/requirements      build ContractRequirements`);
  console.log(`  POST ${BASE_URL}/v1/:tenantId/accept  accept endpoint (agent-facing)`);
  console.log(`  GET  ${BASE_URL}/v1/:tenantId/verify  verify endpoint (server-facing)`);
});
