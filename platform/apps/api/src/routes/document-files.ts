import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  auditRepo,
  documentBlobRepo,
  graphRepo,
  type Db,
} from "@atelier/db";
import {
  DocumentData,
  nowIso,
  type HouseholdId,
  type NodeId,
} from "@atelier/domain";
import { extractDocumentFields } from "@atelier/agents";
import { getBlobStore } from "../blob-store.js";

// Body for POST .../extraction/resolve. The caller lists which
// proposed keys to accept (and optionally overrides them with an
// edited value); anything not listed is discarded. Either way the
// pendingExtraction field is cleared on the resulting node
// version, so a "reject all" is `{ accept: [] }`.
const ResolveExtractionBody = z.object({
  accept: z.array(z.string()).default([]),
  edits: z.record(z.string(), z.unknown()).default({}),
});

// File upload + download for document nodes.
//
// Upload: PUT /households/:id/documents/:nodeId/file with the raw
// file body. Content-type header carries the MIME. The blob is
// hashed, deduped on sha256, written to the configured backend
// (local disk today), a document_blobs row is recorded, and the
// document node's `storedAt` is stamped `atelier://blob/<sha256>`
// — supersede-and-replace so the metadata history captures the
// attachment event.
//
// Download: GET .../file streams the bytes back with the recorded
// mime type. Auth is the standard household-scoped bearer check.
//
// Size cap: ATELIER_MAX_UPLOAD_BYTES (default 25 MiB). The parser
// enforces this by refusing bodies larger than the cap — Fastify's
// default bodyLimit is 1 MiB, so we bump it globally in server.ts.

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const BLOB_URI_PREFIX = "atelier://blob/";

// Subcategories that map to a document.* node type. "other" is a
// valid DocumentData.category but not a distinct graph type, so
// auto-recategorisation only routes into these five buckets.
const RECATEGORY_TARGETS = new Set([
  "identity",
  "legal",
  "policy",
  "record",
  "receipt",
]);

const currentSubcategory = (type: string): string | null =>
  type.startsWith("document.") ? type.slice("document.".length) : null;

export const documentFileRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);
  const blobs = documentBlobRepo(db);
  const audit = auditRepo(db);

  app.put<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId/file",
    {
      config: {
        audit: {
          action: "documents.file.upload",
          resourceType: "document_blob",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const nodeId = req.params.nodeId as NodeId;
      const current = graph.getNode(householdId, nodeId);
      if (!current || !current.type.startsWith("document.")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const maxBytes = Number(
        process.env["ATELIER_MAX_UPLOAD_BYTES"] ?? DEFAULT_MAX_UPLOAD_BYTES,
      );
      const body = req.body;
      if (!(body instanceof Buffer)) {
        return reply
          .code(415)
          .send({ error: "raw_body_required", message: "PUT the file bytes directly as the request body." });
      }
      if (body.byteLength > maxBytes) {
        return reply
          .code(413)
          .send({ error: "too_large", maxBytes });
      }
      const mime =
        (req.headers["content-type"] as string | undefined) ??
        "application/octet-stream";

      const store = getBlobStore();
      const { sha256, byteSize, storageRef } = await store.put(body);
      const originalFilename =
        (req.headers["x-original-filename"] as string | undefined) ?? undefined;
      const recorded = blobs.record({
        householdId,
        sha256,
        mime,
        byteSize,
        storageBackend: store.backend,
        storageRef,
        ...(originalFilename ? { originalFilename } : {}),
        uploadedBy: `${req.actor.type}:${req.actor.id}`,
        documentNodeId: nodeId,
      });

      // Run extraction inline BEFORE the supersede-and-replace so
      // the new node can land in the right document.* bucket in one
      // step (no orphan node in the wrong bucket). Result comes back
      // as a *proposal* on the response — the manager reviews field
      // values via PATCH; we only ever auto-apply the category (the
      // graph type name), never the free-text fields (title, issuer,
      // subject, notes). Extraction latency (2-5s typical) rides on
      // the upload response for phase-0; a real product would go
      // async with a task ledger row.
      let extraction: Awaited<ReturnType<typeof extractDocumentFields>> | null = null;
      try {
        extraction = await extractDocumentFields({
          bytes: body,
          mime,
          ...(originalFilename ? { filename: originalFilename } : {}),
          logger: {
            info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
          },
        });
      } catch (err) {
        req.log.error(
          { error: (err as Error).message },
          "document extraction threw — continuing without proposal",
        );
      }

      // Decide the target subcategory. Auto-recategorise only when
      // ALL of these hold:
      //   * the current node lives in document.identity — our
      //     placeholder bucket. The console's "upload without
      //     categorising" flow lands here; a manager who
      //     deliberately created document.legal / .receipt /
      //     .policy / .record has already pinned intent and we
      //     don't overrule them from an extractor guess.
      //   * extraction is a real classifier call (provider !==
      //     "mock") — the mock never proposes a category so this
      //     also serves as a null check;
      //   * proposed category is a real bucket ("other" doesn't
      //     map to a distinct node type);
      //   * proposed category is different from identity.
      const currentSub = currentSubcategory(current.type);
      const proposedCategory = extraction?.proposed.category;
      const shouldRecategorise =
        currentSub === "identity" &&
        extraction?.provider !== "mock" &&
        typeof proposedCategory === "string" &&
        RECATEGORY_TARGETS.has(proposedCategory) &&
        proposedCategory !== currentSub;
      const targetSub = shouldRecategorise ? proposedCategory : currentSub;

      // Persist the extraction proposal on the node itself so it
      // survives across page loads — the manager can leave the
      // review card sitting for the next session. We only stamp
      // when the proposal actually has fields to review; the
      // category, if we already applied it via auto-recategorise,
      // is stripped from the proposed set so the review card
      // doesn't offer a redundant "accept category" toggle.
      const rawProposed =
        (extraction?.proposed as Record<string, unknown> | undefined) ?? {};
      const proposedForReview: Record<string, unknown> = { ...rawProposed };
      if (shouldRecategorise) delete proposedForReview.category;
      const pendingExtraction =
        extraction && Object.keys(proposedForReview).length > 0
          ? {
              provider: extraction.provider,
              ...(extraction.reason ? { reason: extraction.reason } : {}),
              proposed: proposedForReview,
              createdAt: nowIso(),
            }
          : undefined;

      // Stamp storedAt on a new version of the document node
      // (supersede-and-replace so history is preserved). Re-validate
      // the merged data to keep the invariant that every graph node
      // matches its schema. When auto-recategorising, also bump the
      // data.category so the field matches the new type.
      const merged: Record<string, unknown> = {
        ...(current.data as Record<string, unknown>),
        storedAt: `${BLOB_URI_PREFIX}${sha256}`,
        ...(shouldRecategorise ? { category: proposedCategory } : {}),
        ...(pendingExtraction ? { pendingExtraction } : {}),
      };
      const validated = DocumentData.safeParse(merged);
      if (!validated.success) {
        return reply.code(500).send({
          error: "document_merge_invalid",
          issues: validated.error.issues,
        });
      }
      const replacement = graph.createNode(householdId, {
        type: `document.${targetSub}` as never,
        data: validated.data,
        provenance: {
          source: "manager_observed",
          assertedBy: `${req.actor.type}:${req.actor.id}`,
          assertedAt: nowIso(),
          confidence: 1,
          status: "confirmed",
        },
      });
      graph.supersedeNode(householdId, current.id as NodeId, replacement.id as NodeId);

      return reply.code(recorded.inserted ? 201 : 200).send({
        blob: {
          sha256,
          mime,
          byteSize,
          storageBackend: store.backend,
          deduped: !recorded.inserted,
        },
        document: {
          id: replacement.id,
          data: replacement.data,
          subcategory: targetSub,
          ...(shouldRecategorise
            ? {
                autoRecategorised: {
                  from: currentSub,
                  to: proposedCategory,
                  source: `extraction:${extraction!.provider}`,
                },
              }
            : {}),
        },
        ...(extraction
          ? {
              extraction: {
                provider: extraction.provider,
                proposed: extraction.proposed,
                ...(extraction.reason ? { reason: extraction.reason } : {}),
              },
            }
          : {}),
      });
    },
  );

  app.get<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId/file",
    {
      config: {
        audit: {
          action: "documents.file.download",
          resourceType: "document_blob",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const node = graph.getNode(householdId, req.params.nodeId as NodeId);
      if (!node || !node.type.startsWith("document.")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const storedAt = (node.data as { storedAt?: string }).storedAt;
      if (!storedAt || !storedAt.startsWith(BLOB_URI_PREFIX)) {
        return reply.code(404).send({
          error: "no_file_attached",
          message:
            "This document has no uploaded file. storedAt is either empty or a non-blob URI.",
        });
      }
      const sha256 = storedAt.slice(BLOB_URI_PREFIX.length);
      const blob = blobs.getBySha(householdId, sha256);
      if (!blob) return reply.code(404).send({ error: "blob_metadata_missing" });
      const store = getBlobStore();
      if (!store.exists(blob.storageRef)) {
        return reply.code(500).send({ error: "blob_file_missing" });
      }
      return reply
        .header("content-type", blob.mime)
        .header("content-length", String(blob.byteSize))
        .header(
          "content-disposition",
          blob.originalFilename
            ? `inline; filename="${blob.originalFilename.replace(/"/g, "")}"`
            : "inline",
        )
        .send(store.stream(blob.storageRef));
    },
  );

  // Resolve a pending extraction proposal on a document. The
  // manager picks which proposed fields to accept (optionally
  // editing them); anything not accepted is discarded. Always
  // clears pendingExtraction on the resulting node version so the
  // review card doesn't linger. Both "accept some" and "reject
  // all" go through the same endpoint — reject-all is just an
  // empty accept list.
  app.post<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId/extraction/resolve",
    {
      config: {
        audit: {
          action: "documents.extraction.resolve",
          resourceType: "document",
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const nodeId = req.params.nodeId as NodeId;
      const current = graph.getNode(householdId, nodeId);
      if (!current || !current.type.startsWith("document.")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const body = ResolveExtractionBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: body.error.issues });
      }
      const currentData = current.data as {
        pendingExtraction?: { proposed?: Record<string, unknown> };
      };
      const pending = currentData.pendingExtraction;
      if (!pending) {
        return reply.code(404).send({ error: "no_pending_extraction" });
      }
      const proposed = pending.proposed ?? {};

      // Build the accepted-fields patch. `edits` overrides the
      // proposal on a per-key basis; keys in `edits` but not in
      // `accept` are ignored (edits without acceptance would let a
      // caller sneak arbitrary values in through a merge that's
      // supposed to be about reviewing an LLM proposal).
      const patch: Record<string, unknown> = {};
      for (const key of body.data.accept) {
        if (key === "pendingExtraction" || key === "storedAt") continue; // reserved
        const editedValue = Object.prototype.hasOwnProperty.call(
          body.data.edits,
          key,
        )
          ? body.data.edits[key]
          : proposed[key];
        if (editedValue !== undefined) patch[key] = editedValue;
      }

      // Merge + drop pendingExtraction. Re-validate — accepting a
      // proposed value that doesn't fit the schema (e.g. malformed
      // expiresAt) is a caller-visible 400, not a silent drop.
      const merged: Record<string, unknown> = {
        ...(current.data as Record<string, unknown>),
        ...patch,
      };
      delete merged.pendingExtraction;

      const validated = DocumentData.safeParse(merged);
      if (!validated.success) {
        return reply.code(400).send({
          error: "invalid_after_merge",
          issues: validated.error.issues,
        });
      }

      const replacement = graph.createNode(householdId, {
        type: current.type,
        data: validated.data,
        provenance: {
          source: "manager_observed",
          assertedBy: `${req.actor.type}:${req.actor.id}`,
          assertedAt: nowIso(),
          confidence: 1,
          status: "confirmed",
        },
      });
      graph.supersedeNode(
        householdId,
        current.id as NodeId,
        replacement.id as NodeId,
      );

      // Attach the resolve decision to the audit envelope so
      // "why is this document titled X?" is answerable later
      // without replaying the request log. Records the pre-review
      // proposal snapshot, which keys the manager accepted vs
      // ignored, the final value for each accepted key, and which
      // of those diverged from the LLM's original suggestion.
      const rejected = Object.keys(proposed).filter(
        (k) => !body.data.accept.includes(k),
      );
      const editedKeys = body.data.accept.filter((k) => {
        const suggested = proposed[k];
        const applied = patch[k];
        return applied !== undefined && applied !== suggested;
      });
      req.auditMetadata = {
        priorNodeId: current.id,
        replacementNodeId: replacement.id,
        pendingBefore: pending,
        accepted: body.data.accept,
        rejected,
        editedKeys,
        appliedFields: patch,
      };

      return {
        document: {
          id: replacement.id,
          data: replacement.data,
        },
        accepted: body.data.accept,
        acceptedCount: Object.keys(patch).length,
      };
    },
  );

  // Per-document audit trail. Walks the supersede lineage so
  // events recorded against earlier versions (e.g. an
  // extraction.resolve on the pre-resolve node id, or the
  // original upload) come back alongside events on the live id.
  // Answers "why is this document titled X?" — the response
  // includes each row's metadata (which fields the manager
  // accepted, which they rejected, the pre-review LLM proposal
  // snapshot).
  app.get<{ Params: { householdId: string; nodeId: string } }>(
    "/households/:householdId/documents/:nodeId/audit",
    {
      config: {
        audit: {
          action: "documents.audit.list",
          resourceType: "document",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const nodeId = req.params.nodeId as NodeId;
      const node = graph.getNode(householdId, nodeId);
      const lineage = graph.listNodeLineage(householdId, nodeId);
      if (!node && lineage.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
      const seen = new Set<string>();
      const events: Array<Record<string, unknown>> = [];
      for (const id of lineage) {
        for (const ev of audit.listForResource("document", id)) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          events.push({
            id: ev.id,
            actorType: ev.actorType,
            actorId: ev.actorId,
            action: ev.action,
            resourceType: ev.resourceType,
            resourceId: ev.resourceId,
            sensitive: ev.sensitive,
            metadata: ev.metadata,
            at: ev.at,
          });
        }
      }
      // Newest first — same convention as listForHousehold.
      events.sort((a, b) => (a.at as string < (b.at as string) ? 1 : -1));
      return { lineage, events };
    },
  );
};
