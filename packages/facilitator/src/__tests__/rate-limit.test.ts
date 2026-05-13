import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { rateLimit } from "../rate-limit.js";

function makeApp(max: number, windowMs = 60_000) {
  const app = new Hono();
  app.get("/test", rateLimit({ max, windowMs }), (c) => c.text("ok"));
  return app;
}

function req(app: Hono, ip: string) {
  return app.request("/test", { headers: { "x-forwarded-for": ip } });
}

// ── rateLimit middleware ───────────────────────────────────────────────────────

describe("rateLimit", () => {
  it("request under the limit returns 200", async () => {
    const app = makeApp(5);
    const res = await req(app, "1.2.3.4");
    assert.strictEqual(res.status, 200);
  });

  it("request at the limit (exactly max) is still allowed", async () => {
    const app = makeApp(3);
    // Use up 2 requests, then the 3rd (= max) should still be 200
    await req(app, "10.0.0.1");
    await req(app, "10.0.0.1");
    const res = await req(app, "10.0.0.1");
    assert.strictEqual(res.status, 200);
  });

  it("request over the limit returns 429", async () => {
    const app = makeApp(2);
    await req(app, "192.168.1.1");
    await req(app, "192.168.1.1");
    const res = await req(app, "192.168.1.1"); // 3rd — over limit
    assert.strictEqual(res.status, 429);
  });

  it("429 response includes Retry-After header", async () => {
    const app = makeApp(1, 30_000);
    await req(app, "5.5.5.5");
    const res = await req(app, "5.5.5.5"); // over limit
    assert.strictEqual(res.status, 429);
    const retryAfter = res.headers.get("Retry-After");
    assert.ok(retryAfter !== null, "Retry-After header must be present");
    assert.strictEqual(retryAfter, "30");
  });

  it("different IPs have independent limits", async () => {
    const app = makeApp(2);
    // Exhaust IP A
    await req(app, "2.2.2.2");
    await req(app, "2.2.2.2");
    const resA = await req(app, "2.2.2.2"); // over for A
    assert.strictEqual(resA.status, 429);
    // IP B should still be allowed
    const resB = await req(app, "3.3.3.3");
    assert.strictEqual(resB.status, 200);
  });

  it("requests within window are counted; old ones outside window don't block", async () => {
    // Use a very short window so we can simulate expiry
    const windowMs = 50; // 50 ms
    const app = makeApp(2, windowMs);
    const ip = "4.4.4.4";

    // Use up the limit
    await req(app, ip);
    await req(app, ip);
    const blocked = await req(app, ip);
    assert.strictEqual(blocked.status, 429);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, windowMs + 10));

    // Now the old timestamps are outside the window — new requests should pass
    const after = await req(app, ip);
    assert.strictEqual(after.status, 200);
  });

  it("x-real-ip header is also used as the IP key", async () => {
    const app = makeApp(1);
    app.get("/testreal", rateLimit({ max: 1, windowMs: 60_000 }), (c) => c.text("ok"));
    // First request via x-real-ip
    const res1 = await app.request("/testreal", { headers: { "x-real-ip": "7.7.7.7" } });
    assert.strictEqual(res1.status, 200);
    // Second request from same IP — over limit
    const res2 = await app.request("/testreal", { headers: { "x-real-ip": "7.7.7.7" } });
    assert.strictEqual(res2.status, 429);
  });

  it("unknown IP (no header) is tracked under 'unknown' key", async () => {
    const app = makeApp(1);
    app.get("/nohdr", rateLimit({ max: 1, windowMs: 60_000 }), (c) => c.text("ok"));
    const res1 = await app.request("/nohdr");
    assert.strictEqual(res1.status, 200);
    const res2 = await app.request("/nohdr");
    assert.strictEqual(res2.status, 429);
  });
});
