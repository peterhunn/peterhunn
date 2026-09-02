import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  householdRepo,
  auditRepo,
  auditExportRepo,
  fileSink,
  exportAuditBatch,
  type AuditExportSink,
  type AuditExportBatch,
} from "../src/index.js";
import type { HouseholdId } from "@atelier/domain";

// Each test starts with a fresh in-memory DB. Tests share nothing
// across boundaries — no seed / no teardown coordination needed.
let db: ReturnType<typeof openDb>;
let hh: HouseholdId;

beforeEach(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./migrations" });
  hh = householdRepo(db).create({ name: "AuditH", tier: "life" }).id;
});

const seedEvents = (count: number): void => {
  const audit = auditRepo(db);
  for (let i = 0; i < count; i++) {
    audit.record({
      householdId: hh,
      actor: {
        type: "manager",
        id: "mgr_1",
        displayName: "M",
        householdIds: [hh],
      },
      action: `test.action.${i}`,
      resourceType: "household",
      resourceId: hh,
      metadata: { seq: i },
    });
  }
};

const spySink = (): AuditExportSink & { batches: AuditExportBatch[] } => {
  const s = {
    name: "spy",
    batches: [] as AuditExportBatch[],
    async writeBatch(batch: AuditExportBatch) {
      s.batches.push(batch);
    },
  };
  return s;
};

describe("audit export — exporter", () => {
  it("returns eventsExported: 0 with no events and does not touch the cursor", async () => {
    const sink = spySink();
    const before = auditExportRepo(db).get(sink.name);
    const res = await exportAuditBatch({ db, sink });
    expect(res.eventsExported).toBe(0);
    expect(res.batchId).toBeUndefined();
    expect(sink.batches).toHaveLength(0);
    const after = auditExportRepo(db).get(sink.name);
    expect(after.lastExportedEventId).toBe(before.lastExportedEventId);
    expect(after.batchesExported).toBe(before.batchesExported);
  });

  it("exports a batch, advances the cursor, and skips already-sent events on the next run", async () => {
    const sink = spySink();
    seedEvents(3);
    const res1 = await exportAuditBatch({ db, sink });
    expect(res1.eventsExported).toBe(3);
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.events).toHaveLength(3);

    const cursor1 = auditExportRepo(db).get(sink.name);
    expect(cursor1.eventsExported).toBe(3);
    expect(cursor1.batchesExported).toBe(1);
    expect(cursor1.lastExportedEventId).toBe(
      sink.batches[0]!.events[2]!.id,
    );

    // Second run with no new events — sink not called again.
    const res2 = await exportAuditBatch({ db, sink });
    expect(res2.eventsExported).toBe(0);
    expect(sink.batches).toHaveLength(1);

    // Add two more; only those should ship.
    seedEvents(2);
    const res3 = await exportAuditBatch({ db, sink });
    expect(res3.eventsExported).toBe(2);
    expect(sink.batches).toHaveLength(2);
    expect(sink.batches[1]!.events).toHaveLength(2);

    const cursor3 = auditExportRepo(db).get(sink.name);
    expect(cursor3.batchesExported).toBe(2);
    expect(cursor3.eventsExported).toBe(5);
  });

  it("splits large windows into batchSize chunks (each call ships one)", async () => {
    const sink = spySink();
    seedEvents(7);
    const r1 = await exportAuditBatch({ db, sink, batchSize: 3 });
    expect(r1.eventsExported).toBe(3);
    const r2 = await exportAuditBatch({ db, sink, batchSize: 3 });
    expect(r2.eventsExported).toBe(3);
    const r3 = await exportAuditBatch({ db, sink, batchSize: 3 });
    expect(r3.eventsExported).toBe(1);
    const r4 = await exportAuditBatch({ db, sink, batchSize: 3 });
    expect(r4.eventsExported).toBe(0);

    expect(auditExportRepo(db).get(sink.name).eventsExported).toBe(7);
    expect(auditExportRepo(db).get(sink.name).batchesExported).toBe(3);
  });

  it("does NOT advance the cursor when the sink throws", async () => {
    seedEvents(2);
    const brokenSink: AuditExportSink = {
      name: "broken",
      async writeBatch() {
        throw new Error("sink is offline");
      },
    };
    const before = auditExportRepo(db).get(brokenSink.name);
    await expect(exportAuditBatch({ db, sink: brokenSink })).rejects.toThrow(/offline/);
    const after = auditExportRepo(db).get(brokenSink.name);
    expect(after.lastExportedEventId).toBe(before.lastExportedEventId);
    expect(after.batchesExported).toBe(before.batchesExported);
    expect(after.eventsExported).toBe(before.eventsExported);
  });
});

describe("audit export — file sink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atelier-audit-export-"));
  });

  it("writes ndjson under a yyyy/mm/dd shard and lines round-trip as audit events", async () => {
    seedEvents(4);
    const sink = fileSink({ dir });
    const res = await exportAuditBatch({ db, sink });
    expect(res.eventsExported).toBe(4);

    // Walk the shard tree — expect exactly one .ndjson file.
    const found: string[] = [];
    const walk = async (d: string) => {
      const ents = await readdir(d, { withFileTypes: true });
      for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else found.push(p);
      }
    };
    await walk(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatch(/\.ndjson$/);
    expect(found[0]!).toMatch(/\d{4}\/\d{2}\/\d{2}\//);

    const body = await readFile(found[0]!, "utf-8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string; action: string };
      expect(parsed.id).toMatch(/^aud_/);
      expect(parsed.action).toMatch(/^test\.action\./);
    }

    await rm(dir, { recursive: true, force: true });
  });
});
