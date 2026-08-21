import type { FastifyPluginAsync } from "fastify";
import {
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

export const documentFileRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const graph = graphRepo(db);
  const blobs = documentBlobRepo(db);

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

      // Stamp storedAt on a new version of the document node
      // (supersede-and-replace so history is preserved). Re-validate
      // the merged data to keep the invariant that every graph node
      // matches its schema.
      const merged = {
        ...(current.data as Record<string, unknown>),
        storedAt: `${BLOB_URI_PREFIX}${sha256}`,
      };
      const validated = DocumentData.safeParse(merged);
      if (!validated.success) {
        return reply.code(500).send({
          error: "document_merge_invalid",
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
      graph.supersedeNode(householdId, current.id as NodeId, replacement.id as NodeId);

      // Run extraction inline. Result comes back as a *proposal* —
      // the manager reviews via PATCH. We don't auto-promote onto
      // the node so a bad extraction can't overwrite manager-typed
      // metadata without human review. Extraction latency (2-5s
      // typical) rides on the upload response for phase-0; a real
      // product would go async with a task ledger row.
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
};
