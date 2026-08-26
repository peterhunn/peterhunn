import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
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

// The extractor calls Anthropic; intercept at the socket layer so
// nothing escapes even if a real key leaks into the env.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));

afterAll(async () => {
  server.close();
  await app.close();
});

// Force the extractor onto its mock path regardless of local env,
// so tests don't attempt real Anthropic calls when a key is present.
beforeEach(() => {
  server.resetHandlers();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});

describe("document file blob store", () => {
  it("upload response carries an extraction proposal (mock fallback without API key)", async () => {
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
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/jpeg",
        "x-original-filename": "us-passport-alex.jpg",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json();
    expect(body.extraction).toBeDefined();
    expect(body.extraction.provider).toBe("mock");
    expect(body.extraction.proposed.title?.toLowerCase()).toContain(
      "us passport alex",
    );
  });

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
    // Fresh doc node — earlier tests supersede-and-replace
    // docNodeId, and getNode filters out superseded rows.
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "Cap test", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const bytes = Buffer.alloc(64, 1);
    const res = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
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

  it("auto-recategorises to the extracted subcategory when Anthropic returns a real classifier result", async () => {
    // Manager creates a document.identity node — the console's
    // default when they upload without knowing the type yet.
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "unknown-upload", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });

    // Real (non-mock) extraction path: Anthropic classifies as a
    // receipt. Route should supersede the identity node with a
    // fresh document.receipt node in one shot. We use an
    // image/jpeg upload so the extractor takes the vision path
    // (raw bytes → base64 → Anthropic) instead of pdf-parse,
    // which would reject a synthetic minimal-PDF payload.
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "Whole Foods receipt",
                category: "receipt",
                issuer: "Whole Foods",
              }),
            },
          ],
        }),
      ),
    );

    // JPEG magic bytes + arbitrary tail — bytes don't need to
    // parse as a real image because MSW answers Anthropic locally.
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("recategorise-test"),
    ]);
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/jpeg",
        "x-original-filename": "whole-foods-2026-04-12.jpg",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json();
    expect(body.document.subcategory).toBe("receipt");
    expect(body.document.autoRecategorised).toEqual({
      from: "identity",
      to: "receipt",
      source: "extraction:anthropic",
    });
    expect(body.document.data.category).toBe("receipt");

    // The graph reflects the move: the new node lives under
    // document.receipt, the old id is superseded.
    const fresh = graphRepo(db).getNode(hh, body.document.id);
    expect(fresh?.type).toBe("document.receipt");
    const superseded = graphRepo(db).getNode(hh, doc.id);
    expect(superseded).toBeNull();
  });

  it("mock extractions never auto-recategorise (no confident category signal)", async () => {
    // No API key → extractor falls back to mock, which never
    // proposes a category. The node stays in document.identity.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "mock-upload", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/pdf",
      },
      payload: Buffer.from("%PDF-1.7\n%%EOF"),
    });
    expect(upload.statusCode).toBe(200);
    const body = upload.json();
    expect(body.document.subcategory).toBe("identity");
    expect(body.document.autoRecategorised).toBeUndefined();
    expect(body.extraction.provider).toBe("mock");
  });

  it("does not overrule a manager who has explicitly pinned the subcategory", async () => {
    // Manager created document.legal with category=legal on
    // purpose; even if the extractor says "receipt", we keep it
    // where the manager put it. Pinning is signalled by the data
    // .category matching the current type; a placeholder from the
    // upload flow leaves category === "identity".
    const doc = graphRepo(db).createNode(hh, {
      type: "document.legal",
      data: { title: "signed contract", category: "legal" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });

    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({ category: "receipt" }),
            },
          ],
        }),
      ),
    );

    // JPEG for the same reason as the auto-recategorise test —
    // dodges pdf-parse and keeps the sha unique from prior tests.
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("pinned-test"),
    ]);
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/jpeg",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json();
    // The manager pinned data.category = "legal" matching type
    // document.legal — extraction proposal is surfaced but not
    // applied. Since document.identity is the "placeholder"
    // signal, document.legal counts as pinned.
    expect(body.document.subcategory).toBe("legal");
    expect(body.document.autoRecategorised).toBeUndefined();
    expect(body.extraction.proposed.category).toBe("receipt");
  });

  it("persists the extraction proposal on the node and lets the manager resolve it per-field", async () => {
    // Real classifier path returns a rich proposal — title,
    // issuer, expiresAt. Upload should stamp pendingExtraction on
    // the node data so the review card survives a reload; the
    // "category" key is stripped because auto-recategorisation
    // already applied it and a second toggle would be redundant.
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "unknown-upload", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "AAA Auto Policy #1234",
                category: "policy",
                expiresAt: "2027-04-01T00:00:00Z",
                issuer: "AAA",
                subject: "irrelevant",
              }),
            },
          ],
        }),
      ),
    );
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("resolve-test"),
    ]);
    const upload = await app.inject({
      method: "PUT",
      url: `/households/${hh}/documents/${doc.id}/file`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/jpeg",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const uploadBody = upload.json();
    // Auto-moved to policy; landed node id is different.
    expect(uploadBody.document.subcategory).toBe("policy");
    const landedId = uploadBody.document.id;
    // pendingExtraction lives on the node data now, and its
    // proposed set no longer carries the redundant category.
    const pending = uploadBody.document.data.pendingExtraction;
    expect(pending).toBeDefined();
    expect(pending.provider).toBe("anthropic");
    expect(pending.proposed).toEqual({
      title: "AAA Auto Policy #1234",
      expiresAt: "2027-04-01T00:00:00Z",
      issuer: "AAA",
      subject: "irrelevant",
    });
    expect(pending.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Manager accepts title (edited) + expiresAt as-is, discards
    // issuer + subject. Endpoint merges + clears pendingExtraction
    // + supersedes the node.
    const resolve = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents/${landedId}/extraction/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accept: ["title", "expiresAt"],
        edits: { title: "AAA Auto Policy — 2026-27" },
      },
    });
    expect(resolve.statusCode).toBe(200);
    const resolveBody = resolve.json();
    expect(resolveBody.acceptedCount).toBe(2);
    expect(resolveBody.document.data.title).toBe("AAA Auto Policy — 2026-27");
    expect(resolveBody.document.data.expiresAt).toBe("2027-04-01T00:00:00Z");
    expect(resolveBody.document.data.pendingExtraction).toBeUndefined();
    // Rejected fields don't sneak onto the doc.
    expect(resolveBody.document.data.issuer).toBeUndefined();
    expect(resolveBody.document.data.subject).toBeUndefined();
    // Superseded — landed node is retired, the resolved node is
    // the live one.
    expect(graphRepo(db).getNode(hh, landedId)).toBeNull();
    const live = graphRepo(db).getNode(hh, resolveBody.document.id);
    expect(live).not.toBeNull();
    expect((live!.data as { pendingExtraction?: unknown }).pendingExtraction).toBeUndefined();
  });

  it("reject-all clears the pendingExtraction without changing any field", async () => {
    const doc = graphRepo(db).createNode(hh, {
      type: "document.legal",
      data: {
        title: "Manager-set title",
        category: "legal",
        pendingExtraction: {
          provider: "anthropic" as const,
          proposed: { title: "LLM-guessed title", notes: "junk" },
          createdAt: new Date().toISOString(),
        },
      },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents/${doc.id}/extraction/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { accept: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acceptedCount).toBe(0);
    expect(body.document.data.title).toBe("Manager-set title");
    expect(body.document.data.pendingExtraction).toBeUndefined();
  });

  it("404s the resolve endpoint when there is no pending extraction", async () => {
    const doc = graphRepo(db).createNode(hh, {
      type: "document.identity",
      data: { title: "no pending here", category: "identity" },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents/${doc.id}/extraction/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { accept: ["title"] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no_pending_extraction");
  });
});
