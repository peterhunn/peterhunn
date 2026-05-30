import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebhookRetryWorker } from "../webhook-retry-worker.js";
import { InMemoryWebhookDeliveryStore, InMemoryWebhookStore } from "../store.js";
import type { WebhookDelivery } from "../types.js";

const BASE_NOW = 1_700_000_000;

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    webhookId: "wh-1",
    tenantId: "tenant-1",
    eventType: "agreement.created",
    attemptCount: 3,
    payload: JSON.stringify({ type: "agreement.created", tenantId: "tenant-1", data: {} }),
    nextRetryAt: BASE_NOW - 1, // already due
    createdAt: BASE_NOW - 200,
    ...overrides,
  };
}

describe("WebhookRetryWorker — backoff schedule", () => {
  it("calculates correct backoff for each attempt", () => {
    const worker = new WebhookRetryWorker({
      deliveries: new InMemoryWebhookDeliveryStore(),
      webhooks: new InMemoryWebhookStore(),
    });

    // Access private method via any cast for unit testing
    const w = worker as unknown as { backoffSeconds(n: number): number };
    expect(w.backoffSeconds(4)).toBe(120);    // 2 min
    expect(w.backoffSeconds(5)).toBe(240);    // 4 min
    expect(w.backoffSeconds(6)).toBe(480);    // 8 min
    expect(w.backoffSeconds(7)).toBe(960);    // 16 min
    expect(w.backoffSeconds(8)).toBe(1920);   // 32 min
    expect(w.backoffSeconds(9)).toBe(3600);   // capped at 1 hr
    expect(w.backoffSeconds(10)).toBe(3600);  // still capped
  });
});

describe("WebhookRetryWorker.tick — success path", () => {
  it("marks delivery as succeeded when endpoint responds 200", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["agreement.created"]);
    const delivery = makeDelivery({ webhookId: webhook.webhookId, tenantId: "tenant-1" });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 3);

    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
      maxAttempts: 10,
    });

    await worker.tick();

    const updated = await deliveries.findById(delivery.deliveryId);
    expect(updated?.succeededAt).toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe("WebhookRetryWorker.tick — retry scheduling", () => {
  it("schedules next retry with incremented count when endpoint returns non-2xx", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["agreement.created"]);
    const delivery = makeDelivery({ webhookId: webhook.webhookId, tenantId: "tenant-1", attemptCount: 3 });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 3);

    const mockFetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", mockFetch);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
      maxAttempts: 10,
    });

    await worker.tick();

    const updated = await deliveries.findById(delivery.deliveryId);
    expect(updated?.attemptCount).toBe(4);
    expect(updated?.nextRetryAt).toBe(BASE_NOW + 120); // +2min for attempt 4
    expect(updated?.permanentlyFailed).toBeFalsy();
    vi.unstubAllGlobals();
  });

  it("permanently fails after maxAttempts is reached", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["agreement.created"]);
    const delivery = makeDelivery({ webhookId: webhook.webhookId, tenantId: "tenant-1", attemptCount: 9 });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 9);

    const mockFetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", mockFetch);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
      maxAttempts: 10,
    });

    await worker.tick();

    const updated = await deliveries.findById(delivery.deliveryId);
    expect(updated?.permanentlyFailed).toBe(true);
    vi.unstubAllGlobals();
  });

  it("permanently fails on network error after maxAttempts", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["agreement.created"]);
    const delivery = makeDelivery({ webhookId: webhook.webhookId, tenantId: "tenant-1", attemptCount: 9 });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 9);

    const mockFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    vi.stubGlobal("fetch", mockFetch);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
      maxAttempts: 10,
    });

    await worker.tick();

    const updated = await deliveries.findById(delivery.deliveryId);
    expect(updated?.permanentlyFailed).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("WebhookRetryWorker.tick — webhook state checks", () => {
  it("permanently fails when webhook is not found", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const delivery = makeDelivery({ webhookId: "wh-nonexistent" });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 3);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
    });

    await worker.tick();

    const updated = await deliveries.findById(delivery.deliveryId);
    expect(updated?.permanentlyFailed).toBe(true);
  });

  it("skips deliveries with no payload", async () => {
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const { webhook } = await webhooks.create("tenant-1", "https://example.com/hook", ["agreement.created"]);
    const delivery = makeDelivery({ webhookId: webhook.webhookId, payload: undefined });
    await deliveries.record(delivery);
    await deliveries.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 3);

    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      now: () => BASE_NOW,
    });

    await worker.tick();

    // Fetch should not have been called (no payload to send)
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("WebhookRetryWorker — start/stop", () => {
  it("start and stop control the polling timer", () => {
    vi.useFakeTimers();
    const deliveries = new InMemoryWebhookDeliveryStore();
    const webhooks = new InMemoryWebhookStore();

    const worker = new WebhookRetryWorker({
      deliveries,
      webhooks,
      intervalMs: 1000,
      now: () => BASE_NOW,
    });

    worker.start();
    worker.start(); // idempotent

    vi.advanceTimersByTime(3500);
    worker.stop();
    worker.stop(); // idempotent

    vi.advanceTimersByTime(3500);
    vi.useRealTimers();
  });
});

describe("InMemoryWebhookDeliveryStore — retry methods", () => {
  it("listPendingRetries returns deliveries past their nextRetryAt", async () => {
    const store = new InMemoryWebhookDeliveryStore();

    const due = makeDelivery({ deliveryId: "d-due", nextRetryAt: BASE_NOW - 10 });
    const notYet = makeDelivery({ deliveryId: "d-future", nextRetryAt: BASE_NOW + 600 });
    const succeeded = makeDelivery({ deliveryId: "d-ok", nextRetryAt: BASE_NOW - 10, succeededAt: BASE_NOW - 5 });
    const permFailed = makeDelivery({ deliveryId: "d-pf", nextRetryAt: BASE_NOW - 10, permanentlyFailed: true });

    await Promise.all([store.record(due), store.record(notYet), store.record(succeeded), store.record(permFailed)]);
    await store.scheduleRetry(due.deliveryId, BASE_NOW - 10, 3);
    await store.scheduleRetry(notYet.deliveryId, BASE_NOW + 600, 3);
    await store.scheduleRetry(succeeded.deliveryId, BASE_NOW - 10, 3);

    const results = await store.listPendingRetries(BASE_NOW, 100);
    expect(results.map((r) => r.deliveryId)).toContain("d-due");
    expect(results.map((r) => r.deliveryId)).not.toContain("d-future");
    expect(results.map((r) => r.deliveryId)).not.toContain("d-ok");
    expect(results.map((r) => r.deliveryId)).not.toContain("d-pf");
  });

  it("scheduleRetry updates nextRetryAt and attemptCount", async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const delivery = makeDelivery({ deliveryId: "d-sched" });
    await store.record(delivery);

    await store.scheduleRetry(delivery.deliveryId, BASE_NOW + 120, 4);

    const pending = await store.listPendingRetries(BASE_NOW + 200, 100);
    const updated = pending.find((d) => d.deliveryId === "d-sched");
    expect(updated?.nextRetryAt).toBe(BASE_NOW + 120);
    expect(updated?.attemptCount).toBe(4);
  });

  it("permanentlyFail marks delivery as perm failed", async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const delivery = makeDelivery({ deliveryId: "d-pf2", nextRetryAt: BASE_NOW - 1 });
    await store.record(delivery);
    await store.scheduleRetry(delivery.deliveryId, BASE_NOW - 1, 3);

    await store.permanentlyFail(delivery.deliveryId, "exhausted");

    // Should not appear in pending retries
    const pending = await store.listPendingRetries(BASE_NOW, 100);
    expect(pending.map((d) => d.deliveryId)).not.toContain("d-pf2");

    const found = await store.findById(delivery.deliveryId);
    expect(found?.permanentlyFailed).toBe(true);
    expect(found?.error).toBe("exhausted");
  });
});
