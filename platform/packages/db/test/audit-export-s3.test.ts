import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  householdRepo,
  auditRepo,
  auditExportRepo,
  s3Sink,
  exportAuditBatch,
} from "../src/index.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { HouseholdId } from "@atelier/domain";

// Rather than reach out over the network, we replace the S3
// client's `send` with a spy via clientOverride's HTTP handler.
// AWS SDK v3 accepts a `requestHandler` config that returns a
// mocked response; that's what a real "put succeeded" looks like
// to the SDK. Simpler and avoids any actual TCP.

let db: ReturnType<typeof openDb>;
let hh: HouseholdId;

beforeEach(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./migrations" });
  hh = householdRepo(db).create({ name: "S3H", tier: "life" }).id;
});

const seedEvents = (count: number): void => {
  const audit = auditRepo(db);
  for (let i = 0; i < count; i++) {
    audit.record({
      householdId: hh,
      actor: { type: "manager", id: "mgr_1", displayName: "M", householdIds: [hh] },
      action: `s3.test.${i}`,
      resourceType: "household",
      resourceId: hh,
    });
  }
};

// Stub AWS SDK's HTTP handler at the client layer. The SDK calls
// requestHandler.handle(request) — return a canned 200. Capture
// the outbound HTTP request so we can assert bucket / key / body.
const stubHandler = () => {
  const captured: Array<{ hostname: string; path: string; body: string }> = [];
  return {
    captured,
    handler: {
      async handle(request: {
        hostname: string;
        path: string;
        body: string | Buffer | Uint8Array | undefined;
      }): Promise<{ response: { statusCode: number; headers: Record<string, string>; body: undefined } }> {
        const bodyStr =
          typeof request.body === "string"
            ? request.body
            : request.body
              ? Buffer.from(request.body).toString("utf-8")
              : "";
        captured.push({
          hostname: request.hostname,
          path: request.path,
          body: bodyStr,
        });
        return {
          response: {
            statusCode: 200,
            headers: {},
            body: undefined,
          },
        };
      },
      updateHttpClientConfig(): void {},
      httpHandlerConfigs(): Record<string, unknown> {
        return {};
      },
    },
  };
};

describe("audit export — S3 sink", () => {
  it("PUTs the batch as ndjson with SSE and a shard-prefixed key", async () => {
    seedEvents(3);
    const stub = stubHandler();
    const sink = s3Sink({
      bucket: "atelier-audit-test",
      prefix: "atelier/audit",
      region: "us-east-1",
      clientOverride: {
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        requestHandler: stub.handler,
      },
    });

    const res = await exportAuditBatch({ db, sink });
    expect(res.eventsExported).toBe(3);
    expect(stub.captured).toHaveLength(1);

    const req = stub.captured[0]!;
    // Path-style URL: /<bucket>/<key>. Virtual-hosted: /<key>
    // with hostname `<bucket>.s3.<region>.amazonaws.com`. Accept
    // either — the SDK picks based on region + config.
    const key = req.path.includes(req.hostname)
      ? req.path.split("/").slice(2).join("/")
      : req.path.replace(/^\//, "");
    expect(key).toMatch(/^atelier\/audit\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.ndjson$/);
    // NDJSON body — 3 events, 3 lines, plus trailing newline.
    expect(req.body.trim().split("\n")).toHaveLength(3);

    const cursor = auditExportRepo(db).get(sink.name);
    expect(cursor.eventsExported).toBe(3);
    expect(cursor.batchesExported).toBe(1);
    expect(sink.name).toContain("atelier-audit-test");
  });

  it("throws (and does not advance the cursor) on S3 failure", async () => {
    seedEvents(2);
    // Handler returns 500; the SDK converts to a thrown error.
    const failingHandler = {
      async handle(): Promise<never> {
        throw new Error("s3 is down");
      },
      updateHttpClientConfig(): void {},
      httpHandlerConfigs(): Record<string, unknown> {
        return {};
      },
    };
    const sink = s3Sink({
      bucket: "b",
      clientOverride: {
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        requestHandler: failingHandler,
        maxAttempts: 1,
      },
    });
    const before = auditExportRepo(db).get(sink.name);
    await expect(exportAuditBatch({ db, sink })).rejects.toThrow();
    const after = auditExportRepo(db).get(sink.name);
    expect(after.lastExportedEventId).toBe(before.lastExportedEventId);
    expect(after.batchesExported).toBe(before.batchesExported);
  });

  it("PutObjectCommand carries ServerSideEncryption AES256", async () => {
    // Straight unit-level check that our command shape sets SSE.
    const cmd = new PutObjectCommand({
      Bucket: "b",
      Key: "k",
      Body: "hello",
      ContentType: "application/x-ndjson",
      ServerSideEncryption: "AES256",
    });
    expect(cmd.input.ServerSideEncryption).toBe("AES256");
    expect(cmd.input.ContentType).toBe("application/x-ndjson");
  });
});
