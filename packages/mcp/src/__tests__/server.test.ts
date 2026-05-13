import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createX490McpServer } from "../server.js";
import { signToken } from "@x490/protocol";
import type { ContractRequirements } from "@x490/protocol";

// Inline b64encode (same implementation as @x490/protocol/src/codec.ts)
function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeTestClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createX490McpServer();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
}

type FetchImpl = typeof globalThis.fetch;
let savedFetch: FetchImpl;
beforeEach(() => {
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
});

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input.toString(), init);
}

const NOW = Math.floor(Date.now() / 1000);

const BASE_REQUIREMENTS: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.example.test-contract",
  templateUrl: "https://example.com/template.txt",
  templateHash: "abc123",
  requiredPartyFields: ["name", "jurisdiction"],
  jurisdiction: "US-CA",
  governingLaw: "California",
  acceptEndpoint: "https://example.com/accept",
  revokeEndpoint: "https://example.com/revoke",
  expiresIn: 3600,
  resource: "/data",
  description: "Test contract for data access",
  negotiable: false,
};

// Build a real token using signToken from @x490/protocol
async function makeToken(
  contractId: string,
  resource = "/data",
  partyId = "agent-1",
  exp = NOW + 7200,
) {
  return signToken(
    {
      contractId,
      templateHash: "abc123",
      partyId,
      resource,
      iat: NOW,
      exp,
    },
    "test-secret",
  );
}

// Seed the cache for a specific client (same server instance).
async function seedCache(client: Client, contractId: string, resource = "/data") {
  const token = await makeToken(contractId, resource);
  mockFetch(() =>
    new Response(
      JSON.stringify({ status: "accepted", contractId, token }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  await client.callTool({
    name: "accept_contract",
    arguments: {
      acceptEndpoint: "https://example.com/accept",
      templateId: "org.example.test-contract",
      templateHash: "abc123",
      partyData: { name: "Alice", jurisdiction: "US-CA" },
    },
  });
  globalThis.fetch = savedFetch;
  return token;
}

// ── list_agreements — "empty" test must run before any accepts ─────────────────
// NOTE: node:test runs describe blocks in declaration order. This describe block
// comes first so its "empty" subtest executes before accept_contract seeds the cache.

describe("list_agreements", () => {
  it("returns 'No active agreements' when cache is empty", async () => {
    // This is the very first test in the file — the module-level agreements Map
    // starts empty for this test file run.
    const client = await makeTestClient();
    const result = await client.callTool({
      name: "list_agreements",
      arguments: {},
    });
    const text = getText(result);
    assert.ok(text.includes("No active agreements"), `got: ${text}`);
  });

  it("returns formatted list after a successful accept_contract call", async () => {
    const contractId = "cid-list-1";
    const client = await makeTestClient();
    await seedCache(client, contractId, "/data/list-1");

    const result = await client.callTool({ name: "list_agreements", arguments: {} });
    const text = getText(result);
    assert.ok(text.includes("active agreement"), `got: ${text}`);
    assert.ok(text.includes(contractId), `got: ${text}`);
  });
});

// ── inspect_requirements ───────────────────────────────────────────────────────

describe("inspect_requirements", () => {
  it("returns formatted requirements when server returns 490 with X-490-Requirements header", async () => {
    const client = await makeTestClient();
    const encoded = b64encode(JSON.stringify(BASE_REQUIREMENTS));
    mockFetch(() =>
      new Response(null, {
        status: 490,
        headers: { "X-490-Requirements": encoded },
      }),
    );

    const result = await client.callTool({
      name: "inspect_requirements",
      arguments: { url: "https://example.com/data" },
    });
    const text = getText(result);
    assert.ok(text.includes("Contract Requirements (x490 v1)"), `got: ${text}`);
    assert.ok(text.includes("org.example.test-contract"), `got: ${text}`);
    assert.ok(text.includes("Test contract for data access"), `got: ${text}`);
    assert.ok(text.includes("https://example.com/accept"), `got: ${text}`);
  });

  it("returns requirements from 402 body.contractRequired", async () => {
    const client = await makeTestClient();
    mockFetch(() =>
      new Response(JSON.stringify({ contractRequired: BASE_REQUIREMENTS }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.callTool({
      name: "inspect_requirements",
      arguments: { url: "https://example.com/data" },
    });
    const text = getText(result);
    assert.ok(text.includes("Contract Requirements (x490 v1)"), `got: ${text}`);
    assert.ok(text.includes("org.example.test-contract"), `got: ${text}`);
  });

  it("returns 'no contract gate detected' message for 200 response", async () => {
    const client = await makeTestClient();
    mockFetch(() => new Response("OK", { status: 200 }));

    const result = await client.callTool({
      name: "inspect_requirements",
      arguments: { url: "https://example.com/data" },
    });
    const text = getText(result);
    assert.ok(text.includes("no contract gate detected"), `got: ${text}`);
  });

  it("returns 'plain x402' message for 402 without contractRequired", async () => {
    const client = await makeTestClient();
    mockFetch(() =>
      new Response(JSON.stringify({ error: "Payment required" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.callTool({
      name: "inspect_requirements",
      arguments: { url: "https://example.com/data" },
    });
    const text = getText(result);
    assert.ok(text.includes("plain x402"), `got: ${text}`);
  });
});

// ── fetch_template ─────────────────────────────────────────────────────────────

describe("fetch_template", () => {
  it("returns template text on 200", async () => {
    const client = await makeTestClient();
    const templateText = "This is the NDA template text with {{name}} placeholder.";
    mockFetch(() => new Response(templateText, { status: 200 }));

    const result = await client.callTool({
      name: "fetch_template",
      arguments: { templateUrl: "https://example.com/template.txt" },
    });
    const text = getText(result);
    assert.strictEqual(text, templateText);
  });

  it("returns error message on non-200", async () => {
    const client = await makeTestClient();
    mockFetch(() => new Response("Not Found", { status: 404 }));

    const result = await client.callTool({
      name: "fetch_template",
      arguments: { templateUrl: "https://example.com/template.txt" },
    });
    const text = getText(result);
    assert.ok(text.includes("404"), `got: ${text}`);
  });
});

// ── accept_contract ────────────────────────────────────────────────────────────

describe("accept_contract", () => {
  it("returns success message with contractId/partyId/resource/expires on accepted response", async () => {
    const client = await makeTestClient();
    const contractId = "cid-accept-1";
    const token = await makeToken(contractId, "/data/accept-1");

    mockFetch(() =>
      new Response(
        JSON.stringify({ status: "accepted", contractId, token }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.callTool({
      name: "accept_contract",
      arguments: {
        acceptEndpoint: "https://example.com/accept",
        templateId: "org.example.test-contract",
        templateHash: "abc123",
        partyData: { name: "Alice", jurisdiction: "US-CA" },
      },
    });
    const text = getText(result);
    assert.ok(text.includes("Contract accepted"), `got: ${text}`);
    assert.ok(text.includes(contractId), `got: ${text}`);
    assert.ok(text.includes("agent-1"), `got: ${text}`);
    assert.ok(text.includes("/data/accept-1"), `got: ${text}`);
    assert.ok(text.includes("expires"), `got: ${text}`);
  });

  it("returns counter-offer message when status is counter_offer", async () => {
    const client = await makeTestClient();
    const counterOffer: ContractRequirements = {
      ...BASE_REQUIREMENTS,
      description: "Counter offer terms",
      expiresIn: 7200,
    };

    mockFetch(() =>
      new Response(
        JSON.stringify({
          status: "counter_offer",
          contractId: "cid-counter",
          token: "",
          counterOffer,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.callTool({
      name: "accept_contract",
      arguments: {
        acceptEndpoint: "https://example.com/accept",
        templateId: "org.example.test-contract",
        templateHash: "abc123",
        partyData: { name: "Alice", jurisdiction: "US-CA" },
      },
    });
    const text = getText(result);
    assert.ok(text.includes("counter-offer"), `got: ${text}`);
    assert.ok(text.includes("Counter offer terms"), `got: ${text}`);
  });

  it("returns pending message when status is pending", async () => {
    const client = await makeTestClient();

    mockFetch(() =>
      new Response(
        JSON.stringify({
          status: "pending",
          contractId: "cid-pending",
          token: "",
          pendingAcceptances: 1,
          requiredAcceptances: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.callTool({
      name: "accept_contract",
      arguments: {
        acceptEndpoint: "https://example.com/accept",
        templateId: "org.example.test-contract",
        templateHash: "abc123",
        partyData: { name: "Alice", jurisdiction: "US-CA" },
      },
    });
    const text = getText(result);
    assert.ok(text.includes("Waiting for additional parties"), `got: ${text}`);
    assert.ok(text.includes("cid-pending"), `got: ${text}`);
    assert.ok(text.includes("1"), `got: ${text}`);
    assert.ok(text.includes("2"), `got: ${text}`);
  });

  it("returns error message when accept endpoint returns non-ok status", async () => {
    const client = await makeTestClient();

    mockFetch(() =>
      new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.callTool({
      name: "accept_contract",
      arguments: {
        acceptEndpoint: "https://example.com/accept",
        templateId: "org.example.test-contract",
        templateHash: "abc123",
        partyData: { name: "Alice", jurisdiction: "US-CA" },
      },
    });
    const text = getText(result);
    assert.ok(text.includes("Accept failed") || text.includes("401"), `got: ${text}`);
  });
});

// ── get_token ──────────────────────────────────────────────────────────────────

describe("get_token", () => {
  it("returns token when looking up by contractId", async () => {
    const contractId = "cid-token-by-id";
    const client = await makeTestClient();
    const token = await seedCache(client, contractId, "/data/token-by-id");

    const result = await client.callTool({ name: "get_token", arguments: { contractId } });
    const text = getText(result);
    assert.ok(text.includes("X-490-Contract:"), `got: ${text}`);
    assert.ok(text.includes(token), `got: ${text}`);
  });

  it("returns token when looking up by resource", async () => {
    const contractId = "cid-token-by-resource";
    const resource = "/data/token-by-resource";
    const client = await makeTestClient();
    const token = await seedCache(client, contractId, resource);

    const result = await client.callTool({ name: "get_token", arguments: { resource } });
    const text = getText(result);
    assert.ok(text.includes("X-490-Contract:"), `got: ${text}`);
    assert.ok(text.includes(token), `got: ${text}`);
  });

  it("returns 'No cached agreement' when not found", async () => {
    const client = await makeTestClient();

    const result = await client.callTool({
      name: "get_token",
      arguments: { contractId: "cid-does-not-exist" },
    });
    const text = getText(result);
    assert.ok(
      text.includes("No cached agreement") || text.includes("no cached agreement"),
      `got: ${text}`,
    );
  });
});

// ── revoke_agreement ───────────────────────────────────────────────────────────

describe("revoke_agreement", () => {
  it("returns revoke success message", async () => {
    const contractId = "cid-revoke-1";
    const client = await makeTestClient();
    await seedCache(client, contractId, "/data/revoke-1");

    mockFetch(() =>
      new Response(
        JSON.stringify({ revoked: true, contractId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.callTool({
      name: "revoke_agreement",
      arguments: {
        revokeEndpoint: "https://example.com/revoke",
        contractId,
      },
    });
    const text = getText(result);
    assert.ok(text.includes("revoked"), `got: ${text}`);
    assert.ok(text.includes(contractId), `got: ${text}`);
  });

  it("removes agreement from cache so subsequent list_agreements no longer shows it", async () => {
    const contractId = "cid-revoke-2";
    const client = await makeTestClient();
    await seedCache(client, contractId, "/data/revoke-2");

    // Confirm it's in the list
    const listBefore = await client.callTool({ name: "list_agreements", arguments: {} });
    assert.ok(getText(listBefore).includes(contractId), "should be listed before revoke");

    // Revoke
    mockFetch(() =>
      new Response(
        JSON.stringify({ revoked: true, contractId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await client.callTool({
      name: "revoke_agreement",
      arguments: {
        revokeEndpoint: "https://example.com/revoke",
        contractId,
      },
    });

    globalThis.fetch = savedFetch;

    // Confirm it's gone
    const listAfter = await client.callTool({ name: "list_agreements", arguments: {} });
    const textAfter = getText(listAfter);
    assert.ok(
      !textAfter.includes(contractId),
      `should not contain ${contractId} after revoke, got: ${textAfter}`,
    );
  });
});
