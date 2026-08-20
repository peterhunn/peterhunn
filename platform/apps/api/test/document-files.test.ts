import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  documentBlobRepo,
  graphRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { buildLocalBlobStore, setBlobStoreForTesting } from "../src/blob-store.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;
let docNodeId: string;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const blobDir = mkdtempSync(join(tmpdir(), "atelier-blob-"));
  setBlobStoreForTesting(buildLocalBlobStore(blobDir));

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  const doc = graphRepo(db).createNode(hh, {
    type: "document.identity",
    data: { title: "US Passport", category: "identity" },
    provenance: {
      source: "manager_observed",
      assertedBy: "test",
      assertedAt: new Date().toISOString(),
      confidence: 1,
      status: "confirmed",
    },
  });
  docNodeId = doc.id;

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("document file blob store", () => {
  it("upload records a blob, stamps storedAt on a new node version, download streams it back", async () => {
    const bytes = Buffer.from("%PDF-1.7\n%%EOF");
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${docNodeId}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/pdf",
        "x-original-filename": "passport.pdf",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json();
    expect(body.blob.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.blob.byteSize).toBe(bytes.byteLength);
    expect(body.blob.deduped).toBe(false);
    expect(body.document.data.storedAt).toBe(`atelier://blob/${body.blob.sha256}`);

    // node id changed (supersede-and-replace)
    expect(body.document.id).not.toBe(docNodeId);

    // blob metadata row exists
    const row = documentBlobRepo(db).getBySha(hh, body.blob.sha256);
    expect(row).not.toBeNull();
    expect(row!.originalFilename).toBe("passport.pdf");
    expect(row!.mime).toBe("application/pdf");
    expect(row!.documentNodeId).toBe(docNodeId);

    // download the file — the replacement node id is what we now query.
    const download = await app.inject({
      method: "GET",
      url: `/households/${hh}/documents/${body.document.id}/file`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(download.rawPayload).equals(bytes)).toBe(true);
  });

  it("re-uploading identical content dedupes on sha256", async () => {
    // Fresh doc node, same bytes as above.
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "Duplicate identity", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const bytes = Buffer.from("%PDF-1.7\n%%EOF");
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/pdf",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().blob.deduped).toBe(true);
  });

  it("413 above the byte cap", async () => {
    // Use a tiny cap by process env… but the app was already
    // built with the default cap. Instead confirm the cap field
    // is present in error shape by uploading a large payload
    // relative to a very small cap set at request time.
    process.env["ATELIER_MAX_UPLOAD_BYTES"] = "8";
    const bytes = Buffer.alloc(64, 1);
    const res = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${docNodeId}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/pdf",
      },
      payload: bytes,
    });
    // The app-wide bodyLimit still lets 64 bytes through (default
    // 25 MiB); the per-route check catches it.
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("too_large");
    delete process.env["ATELIER_MAX_UPLOAD_BYTES"];
  });

  it("GET on a document without an attached file returns 404 no_file_attached", async () => {
    const fresh = graphRepo(db).createNode(hh, {
      type: "document.receipt",
      data: { title: "Unpaid invoice", category: "receipt" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/documents/${fresh.id}/file`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no_file_attached");
  });

  it("uploading to a non-document node id is 404", async () => {
    const notDoc = graphRepo(db).createNode(hh, {
      type: "person.principal",
      data: { fullName: "Alex", emails: [], phones: [] },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${notDoc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/pdf",
      },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(404);
  });
});
