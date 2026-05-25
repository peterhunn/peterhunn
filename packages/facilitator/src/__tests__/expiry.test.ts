import { describe, it, expect, vi } from "vitest";
import {
  InMemoryAgreementStore,
  InMemoryWebhookStore,
} from "../store.js";
import { ExpiryScheduler } from "../expiry-scheduler.js";
import type { AgreementRecord, WebhookPayload } from "../types.js";

function makeAgreement(overrides: Partial<AgreementRecord> = {}): AgreementRecord {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    contractId: `c-${Math.random().toString(36).slice(2)}`,
    tenantId: "tenant-1",
    templateHash: "abc123",
    partyId: "agent-1",
    resource: "/api/tool",
    partyData: {},
    token: "tok",
    issuedAt: nowUnix - 3600,
    expiresAt: nowUnix + 3600, // expires in 1 hour by default
    ...overrides,
  };
}

describe("InMemoryAgreementStore.findExpiringBetween", () => {
  it("returns agreements expiring in the given window", async () => {
    const store = new InMemoryAgreementStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    const expiresSoon = makeAgreement({ contractId: "a1", expiresAt: nowUnix + 3600 }); // 1h
    const expiresLater = makeAgreement({ contractId: "a2", expiresAt: nowUnix + 10 * 86400 }); // 10 days
    const alreadyRevoked = makeAgreement({ contractId: "a3", expiresAt: nowUnix + 3600, revokedAt: nowUnix - 60 });

    await Promise.all([store.record(expiresSoon), store.record(expiresLater), store.record(alreadyRevoked)]);

    const results = await store.findExpiringBetween(nowUnix, nowUnix + 7 * 86400);
    expect(results.map((r) => r.contractId)).toContain("a1");
    expect(results.map((r) => r.contractId)).not.toContain("a2");
    expect(results.map((r) => r.contractId)).not.toContain("a3");
  });

  it("respects the limit parameter", async () => {
    const store = new InMemoryAgreementStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 5; i++) {
      await store.record(makeAgreement({ contractId: `c-${i}`, expiresAt: nowUnix + 3600 }));
    }

    const results = await store.findExpiringBetween(nowUnix, nowUnix + 7 * 86400, 3);
    expect(results).toHaveLength(3);
  });
});

describe("ExpiryScheduler.tick", () => {
  it("delivers contract.expiring webhook for each expiring agreement", async () => {
    const agreements = new InMemoryAgreementStore();
    const webhooks = new InMemoryWebhookStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    const agreement = makeAgreement({ contractId: "c-expiring", expiresAt: nowUnix + 3600 });
    await agreements.record(agreement);

    // Register a webhook listening to contract.expiring
    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["contract.expiring"]);

    const delivered: WebhookPayload[] = [];
    const deliver = vi.fn(async (_url: string, _secret: string, payload: WebhookPayload) => {
      delivered.push(payload);
      return { status: 200 };
    });

    const scheduler = new ExpiryScheduler({
      agreements,
      webhooks,
      warningWindowSeconds: 7 * 86400,
      now: () => nowUnix,
      deliver,
    });

    await scheduler.tick();

    expect(deliver).toHaveBeenCalledOnce();
    expect(delivered[0]!.type).toBe("contract.expiring");
    expect(delivered[0]!.data.contractId).toBe("c-expiring");
    expect(delivered[0]!.tenantId).toBe("tenant-1");
  });

  it("does not deliver for agreements outside the warning window", async () => {
    const agreements = new InMemoryAgreementStore();
    const webhooks = new InMemoryWebhookStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    // Expires in 30 days — outside the 7-day warning window
    const agreement = makeAgreement({ contractId: "c-far", expiresAt: nowUnix + 30 * 86400 });
    await agreements.record(agreement);

    await webhooks.create("tenant-1", "https://example.com/hook", ["contract.expiring"]);

    const deliver = vi.fn(async () => ({ status: 200 }));
    const scheduler = new ExpiryScheduler({
      agreements,
      webhooks,
      warningWindowSeconds: 7 * 86400,
      now: () => nowUnix,
      deliver,
    });

    await scheduler.tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not deliver for revoked agreements", async () => {
    const agreements = new InMemoryAgreementStore();
    const webhooks = new InMemoryWebhookStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    const agreement = makeAgreement({ contractId: "c-revoked", expiresAt: nowUnix + 3600, revokedAt: nowUnix - 60 });
    await agreements.record(agreement);

    await webhooks.create("tenant-1", "https://example.com/hook", ["contract.expiring"]);

    const deliver = vi.fn(async () => ({ status: 200 }));
    const scheduler = new ExpiryScheduler({
      agreements,
      webhooks,
      warningWindowSeconds: 7 * 86400,
      now: () => nowUnix,
      deliver,
    });

    await scheduler.tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("handles delivery errors gracefully (does not throw)", async () => {
    const agreements = new InMemoryAgreementStore();
    const webhooks = new InMemoryWebhookStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    await agreements.record(makeAgreement({ contractId: "c-err", expiresAt: nowUnix + 3600 }));
    await webhooks.create("tenant-1", "https://example.com/hook", ["contract.expiring"]);

    const deliver = vi.fn(async () => { throw new Error("network error"); });
    const scheduler = new ExpiryScheduler({
      agreements,
      webhooks,
      warningWindowSeconds: 7 * 86400,
      now: () => nowUnix,
      deliver,
    });

    // Should not throw
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("start and stop control the polling interval", () => {
    vi.useFakeTimers();
    const agreements = new InMemoryAgreementStore();
    const webhooks = new InMemoryWebhookStore();
    const deliver = vi.fn(async () => ({ status: 200 }));

    const scheduler = new ExpiryScheduler({
      agreements,
      webhooks,
      intervalMs: 1000,
      warningWindowSeconds: 7 * 86400,
      deliver,
    });

    scheduler.start();
    scheduler.start(); // calling start twice is a no-op

    vi.advanceTimersByTime(3500);
    scheduler.stop();
    vi.advanceTimersByTime(3500);

    // tick is called 3 times (at 1s, 2s, 3s) but not after stop
    // deliver is not called because store is empty
    expect(deliver).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
