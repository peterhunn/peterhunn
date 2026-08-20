import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  documentBlobs,
  type DocumentBlobRow,
} from "../schema/document_blobs.js";

export interface RecordBlobInput {
  readonly householdId: HouseholdId;
  readonly sha256: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly storageBackend: "local" | "s3";
  readonly storageRef: string;
  readonly originalFilename?: string;
  readonly uploadedBy: string;
  readonly documentNodeId?: string;
}

const newBlobId = (): string => `blob_${randomBytes(12).toString("hex")}`;

export const documentBlobRepo = (db: Db) => ({
  // Content-addressed record. If (household, sha256) exists, return
  // the existing row rather than inserting a duplicate — the file
  // on disk is already there, we just need another logical link.
  record(input: RecordBlobInput): { inserted: boolean; row: DocumentBlobRow } {
    const existing = db
      .select()
      .from(documentBlobs)
      .where(
        and(
          eq(documentBlobs.householdId, input.householdId),
          eq(documentBlobs.sha256, input.sha256),
        ),
      )
      .get();
    if (existing) {
      // If this upload names a documentNodeId and the existing row
      // doesn't, stamp it so the linkage catches up. Doesn't touch
      // existing linkage — the first document to reference wins.
      if (input.documentNodeId && !existing.documentNodeId) {
        db.update(documentBlobs)
          .set({ documentNodeId: input.documentNodeId })
          .where(eq(documentBlobs.id, existing.id))
          .run();
        const refreshed = db
          .select()
          .from(documentBlobs)
          .where(eq(documentBlobs.id, existing.id))
          .get();
        if (!refreshed) throw new Error("document_blob select-after-update lost row");
        return { inserted: false, row: refreshed };
      }
      return { inserted: false, row: existing };
    }
    const id = newBlobId();
    db.insert(documentBlobs)
      .values({
        id,
        householdId: input.householdId,
        sha256: input.sha256,
        mime: input.mime,
        byteSize: input.byteSize,
        storageBackend: input.storageBackend,
        storageRef: input.storageRef,
        originalFilename: input.originalFilename ?? null,
        uploadedBy: input.uploadedBy,
        uploadedAt: nowIso(),
        documentNodeId: input.documentNodeId ?? null,
      })
      .run();
    const row = db
      .select()
      .from(documentBlobs)
      .where(eq(documentBlobs.id, id))
      .get();
    if (!row) throw new Error("document_blob insert did not return");
    return { inserted: true, row };
  },

  getBySha(
    householdId: HouseholdId,
    sha256: string,
  ): DocumentBlobRow | null {
    return (
      db
        .select()
        .from(documentBlobs)
        .where(
          and(
            eq(documentBlobs.householdId, householdId),
            eq(documentBlobs.sha256, sha256),
          ),
        )
        .get() ?? null
    );
  },

  list(householdId: HouseholdId): DocumentBlobRow[] {
    return db
      .select()
      .from(documentBlobs)
      .where(eq(documentBlobs.householdId, householdId))
      .orderBy(desc(documentBlobs.uploadedAt))
      .all();
  },
});
