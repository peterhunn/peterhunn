import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Content-addressed blob storage metadata for uploaded document
// files. The bytes themselves live outside SQLite — under
// ATELIER_BLOB_DIR on local disk in phase 0 (portable to S3 later
// by swapping the backend factory in blob-store.ts).
//
// One row per (household, sha256) — the same content uploaded
// twice, or referenced by two document nodes, occupies one
// physical blob and shows up as two rows via the node linkage
// stored in the document node's `storedAt` (atelier://blob/<sha>).
//
// storageRef is opaque to the caller — the backend interprets it.
// Local filesystem: relative path under ATELIER_BLOB_DIR.
// S3-compatible: "<bucket>/<key>".
export const documentBlobs = sqliteTable(
  "document_blobs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageBackend: text("storage_backend", { enum: ["local", "s3"] })
      .notNull()
      .default("local"),
    storageRef: text("storage_ref").notNull(),
    originalFilename: text("original_filename"),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    // If this blob was uploaded for a specific document node, we
    // stamp it here so listing a household's blobs shows the
    // linkage — but the authoritative link direction is the node's
    // storedAt field (atelier://blob/<sha>), because a blob can
    // outlive or predate any single node.
    documentNodeId: text("document_node_id"),
  },
  (t) => ({
    householdShaIdx: index("document_blobs_household_sha_idx").on(t.householdId, t.sha256),
    householdIdx: index("document_blobs_household_idx").on(t.householdId),
  }),
);

export type DocumentBlobRow = typeof documentBlobs.$inferSelect;
