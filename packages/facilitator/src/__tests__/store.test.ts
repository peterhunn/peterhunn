import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryRequirementsStore,
  InMemoryAgreementStore,
  encodeCursor,
  decodeCursor,
  sha256hex,
} from "../store.js";

// ── InMemoryTenantStore ────────────────────────────────────────────────────────

describe("InMemoryTenantStore", () => {
  it("create returns tenantId, rawApiKey, and keyId", async () => {
    const store = new InMemoryTenantStore();
    const result = await store.create("Acme Corp");
    assert.ok(result.tenant.tenantId.length > 0);
    assert.ok(result.rawApiKey.startsWith("sk_x490_"));
    assert.ok(result.keyId.length > 0);
    assert.strictEqual(result.tenant.name, "Acme Corp");
  });

  it("findByApiKey (O(1) hash lookup) returns the tenant", async () => {
    const store = new InMemoryTenantStore();
    const { tenant, rawApiKey } = await store.create("Tenant A");
    const found = await store.findByApiKey(rawApiKey);
    assert.ok(found !== null);
    assert.strictEqual(found.tenantId, tenant.tenantId);
  });

  it("findByApiKey returns null for unknown key", async () => {
    const store = new InMemoryTenantStore();
    const found = await store.findByApiKey("sk_x490_unknownkey");
    assert.strictEqual(found, null);
  });

  it("findById returns the tenant", async () => {
    const store = new InMemoryTenantStore();
    const { tenant } = await store.create("Tenant B");
    const found = await store.findById(tenant.tenantId);
    assert.ok(found !== null);
    assert.strictEqual(found.tenantId, tenant.tenantId);
    assert.strictEqual(found.name, "Tenant B");
  });

  it("findById returns null for unknown id", async () => {
    const store = new InMemoryTenantStore();
    const found = await store.findById("does-not-exist");
    assert.strictEqual(found, null);
  });

  it("createApiKey returns new keyId and rawApiKey", async () => {
    const store = new InMemoryTenantStore();
    const { tenant } = await store.create("Tenant C");
    const { keyId, rawApiKey } = await store.createApiKey(tenant.tenantId, "staging");
    assert.ok(keyId.length > 0);
    assert.ok(rawApiKey.startsWith("sk_x490_"));
    // New key should also authenticate
    const found = await store.findByApiKey(rawApiKey);
    assert.ok(found !== null);
    assert.strictEqual(found.tenantId, tenant.tenantId);
  });

  it("listApiKeys returns all keys for a tenant", async () => {
    const store = new InMemoryTenantStore();
    const { tenant } = await store.create("Tenant D");
    await store.createApiKey(tenant.tenantId, "extra-key");
    const keys = await store.listApiKeys(tenant.tenantId);
    assert.strictEqual(keys.length, 2);
    assert.ok(keys.every((k) => k.tenantId === tenant.tenantId));
  });

  it("revokeApiKey returns true and revoked key is no longer found by findByApiKey", async () => {
    const store = new InMemoryTenantStore();
    const { rawApiKey, keyId } = await store.create("Tenant E");
    const ok = await store.revokeApiKey(keyId);
    assert.strictEqual(ok, true);
    const found = await store.findByApiKey(rawApiKey);
    assert.strictEqual(found, null);
  });

  it("revokeApiKey returns false for unknown keyId", async () => {
    const store = new InMemoryTenantStore();
    const ok = await store.revokeApiKey("no-such-key");
    assert.strictEqual(ok, false);
  });
});

// ── InMemoryTemplateStore ──────────────────────────────────────────────────────

describe("InMemoryTemplateStore", () => {
  it("register returns a template with the correct hash", async () => {
    const store = new InMemoryTemplateStore();
    const content = "This is a test NDA template.";
    const tmpl = await store.register("tenant-1", content, { title: "Test NDA" });
    assert.ok(tmpl.hash.length > 0);
    assert.strictEqual(tmpl.tenantId, "tenant-1");
    assert.strictEqual(tmpl.content, content);
    assert.strictEqual(tmpl.meta.title, "Test NDA");
    // Verify hash matches sha256hex of content
    const expected = await sha256hex(content);
    assert.strictEqual(tmpl.hash, expected);
  });

  it("register is idempotent on same content — returns existing record", async () => {
    const store = new InMemoryTemplateStore();
    const content = "Idempotent content.";
    const first = await store.register("tenant-1", content, { title: "First" });
    const second = await store.register("tenant-2", content, { title: "Second" });
    // Second call with same content should return the original
    assert.strictEqual(first.hash, second.hash);
    assert.strictEqual(second.tenantId, "tenant-1");
    assert.strictEqual(second.meta.title, "First");
  });

  it("findByHash returns the template", async () => {
    const store = new InMemoryTemplateStore();
    const content = "Find by hash test.";
    const tmpl = await store.register("tenant-1", content, {});
    const found = await store.findByHash(tmpl.hash);
    assert.ok(found !== null);
    assert.strictEqual(found.hash, tmpl.hash);
  });

  it("findByHash returns null for unknown hash", async () => {
    const store = new InMemoryTemplateStore();
    const found = await store.findByHash("deadbeef");
    assert.strictEqual(found, null);
  });
});

// ── InMemoryRequirementsStore ──────────────────────────────────────────────────

describe("InMemoryRequirementsStore", () => {
  it("upsert creates a new record with generated id and createdAt", async () => {
    const store = new InMemoryRequirementsStore();
    const config = await store.upsert({
      tenantId: "t1",
      templateHash: "hash1",
      resource: "/api",
      expiresIn: 3600,
      requiredPartyFields: ["name"],
    });
    assert.ok(config.id.length > 0);
    assert.ok(config.createdAt > 0);
    assert.strictEqual(config.tenantId, "t1");
    assert.strictEqual(config.expiresIn, 3600);
  });

  it("upsert updates existing record for same (tenantId, templateHash, resource)", async () => {
    const store = new InMemoryRequirementsStore();
    const first = await store.upsert({
      tenantId: "t1",
      templateHash: "hash1",
      resource: "/api",
      expiresIn: 3600,
      requiredPartyFields: ["name"],
    });
    const second = await store.upsert({
      tenantId: "t1",
      templateHash: "hash1",
      resource: "/api",
      expiresIn: 7200,
      requiredPartyFields: ["name", "email"],
    });
    assert.strictEqual(first.id, second.id);
    assert.strictEqual(second.expiresIn, 7200);
    assert.deepStrictEqual(second.requiredPartyFields, ["name", "email"]);
  });

  it("findByTemplate returns highest expiresIn among matching records", async () => {
    const store = new InMemoryRequirementsStore();
    await store.upsert({ tenantId: "t1", templateHash: "h1", resource: "/low", expiresIn: 1000, requiredPartyFields: [] });
    await store.upsert({ tenantId: "t1", templateHash: "h1", resource: "/high", expiresIn: 9000, requiredPartyFields: [] });
    await store.upsert({ tenantId: "t1", templateHash: "h1", resource: "/mid", expiresIn: 5000, requiredPartyFields: [] });
    const best = await store.findByTemplate("t1", "h1");
    assert.ok(best !== null);
    assert.strictEqual(best.expiresIn, 9000);
  });

  it("findByTemplate returns null when no matching records", async () => {
    const store = new InMemoryRequirementsStore();
    const result = await store.findByTemplate("t1", "unknown-hash");
    assert.strictEqual(result, null);
  });

  it("findByResource returns the matching record", async () => {
    const store = new InMemoryRequirementsStore();
    await store.upsert({ tenantId: "t1", templateHash: "h1", resource: "/api/v2", expiresIn: 3600, requiredPartyFields: ["id"] });
    const result = await store.findByResource("t1", "h1", "/api/v2");
    assert.ok(result !== null);
    assert.strictEqual(result.resource, "/api/v2");
    assert.strictEqual(result.expiresIn, 3600);
  });

  it("findByResource returns null when no match", async () => {
    const store = new InMemoryRequirementsStore();
    const result = await store.findByResource("t1", "h1", "/not-here");
    assert.strictEqual(result, null);
  });
});

// ── InMemoryAgreementStore ─────────────────────────────────────────────────────

describe("InMemoryAgreementStore", () => {
  function makeAgreement(overrides: Partial<import("../types.js").AgreementRecord> = {}): import("../types.js").AgreementRecord {
    return {
      contractId: crypto.randomUUID(),
      tenantId: "tenant-1",
      templateHash: "tmpl-hash",
      partyId: "party-1",
      resource: "*",
      partyData: { name: "Alice" },
      token: "tok",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    };
  }

  it("record stores and findById retrieves the agreement", async () => {
    const store = new InMemoryAgreementStore();
    const a = makeAgreement();
    await store.record(a);
    const found = await store.findById(a.contractId);
    assert.ok(found !== null);
    assert.strictEqual(found.contractId, a.contractId);
  });

  it("findById returns null for unknown contractId", async () => {
    const store = new InMemoryAgreementStore();
    const found = await store.findById("no-such-id");
    assert.strictEqual(found, null);
  });

  it("listByTenant returns all agreements for a tenant (no filter)", async () => {
    const store = new InMemoryAgreementStore();
    await store.record(makeAgreement({ tenantId: "t1", contractId: "cid-1" }));
    await store.record(makeAgreement({ tenantId: "t1", contractId: "cid-2" }));
    await store.record(makeAgreement({ tenantId: "t2", contractId: "cid-3" }));
    const { agreements } = await store.listByTenant("t1");
    assert.strictEqual(agreements.length, 2);
    assert.ok(agreements.every((a) => a.tenantId === "t1"));
  });

  it("listByTenant filters by resource", async () => {
    const store = new InMemoryAgreementStore();
    await store.record(makeAgreement({ tenantId: "t1", contractId: "cid-a", resource: "/data" }));
    await store.record(makeAgreement({ tenantId: "t1", contractId: "cid-b", resource: "/other" }));
    await store.record(makeAgreement({ tenantId: "t1", contractId: "cid-c", resource: "*" }));
    const { agreements } = await store.listByTenant("t1", { resource: "/data" });
    // Should return /data and * but not /other
    const ids = agreements.map((a) => a.contractId);
    assert.ok(ids.includes("cid-a"));
    assert.ok(ids.includes("cid-c"));
    assert.ok(!ids.includes("cid-b"));
  });

  it("listByTenant paginates with limit", async () => {
    const store = new InMemoryAgreementStore();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await store.record(makeAgreement({ tenantId: "t1", contractId: `cid-${i}`, issuedAt: now - i }));
    }
    const { agreements, nextCursor } = await store.listByTenant("t1", { limit: 3 });
    assert.strictEqual(agreements.length, 3);
    assert.ok(nextCursor !== null);
  });

  it("listByTenant paginates with cursor (after)", async () => {
    const store = new InMemoryAgreementStore();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await store.record(makeAgreement({ tenantId: "t1", contractId: `cid-pg-${i}`, issuedAt: now - i }));
    }
    const page1 = await store.listByTenant("t1", { limit: 2 });
    assert.ok(page1.nextCursor !== null);
    const page2 = await store.listByTenant("t1", { limit: 2, after: page1.nextCursor! });
    assert.strictEqual(page2.agreements.length, 2);
    // No overlap between pages
    const ids1 = page1.agreements.map((a) => a.contractId);
    const ids2 = page2.agreements.map((a) => a.contractId);
    assert.ok(ids2.every((id) => !ids1.includes(id)));
  });

  it("revoke marks agreement as revoked", async () => {
    const store = new InMemoryAgreementStore();
    const a = makeAgreement();
    await store.record(a);
    const ok = await store.revoke(a.contractId, "breach of terms");
    assert.strictEqual(ok, true);
    const found = await store.findById(a.contractId);
    assert.ok(found?.revokedAt !== undefined);
    assert.strictEqual(found?.revokedReason, "breach of terms");
  });

  it("revoke returns false for unknown contractId", async () => {
    const store = new InMemoryAgreementStore();
    const ok = await store.revoke("ghost-id");
    assert.strictEqual(ok, false);
  });

  it("isRevoked returns false before revocation", async () => {
    const store = new InMemoryAgreementStore();
    const a = makeAgreement();
    await store.record(a);
    assert.strictEqual(await store.isRevoked(a.contractId), false);
  });

  it("isRevoked returns true after revocation", async () => {
    const store = new InMemoryAgreementStore();
    const a = makeAgreement();
    await store.record(a);
    await store.revoke(a.contractId);
    assert.strictEqual(await store.isRevoked(a.contractId), true);
  });
});

// ── encodeCursor / decodeCursor ────────────────────────────────────────────────

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a simple cursor", () => {
    const issuedAt = 1700000000;
    const contractId = "abc-123";
    const cursor = encodeCursor(issuedAt, contractId);
    const [ts, id] = decodeCursor(cursor);
    assert.strictEqual(ts, issuedAt);
    assert.strictEqual(id, contractId);
  });

  it("round-trips a cursor with UUID contractId", () => {
    const issuedAt = 9999999;
    const contractId = crypto.randomUUID();
    const cursor = encodeCursor(issuedAt, contractId);
    const [ts, id] = decodeCursor(cursor);
    assert.strictEqual(ts, issuedAt);
    assert.strictEqual(id, contractId);
  });

  it("produces a URL-safe base64url string (no +, /, or =)", () => {
    // Run many samples to be confident the encoding is base64url
    for (let i = 0; i < 20; i++) {
      const cursor = encodeCursor(Date.now(), crypto.randomUUID());
      assert.ok(!/[+/=]/.test(cursor), `cursor contains invalid chars: ${cursor}`);
    }
  });
});
