import type { AuditEventRow } from "../schema/audit.js";

// Sink contract. Implementers must:
//   1. Persist every event durably before resolving the promise
//      (fsync for disk, PutObject 200 for S3 with object-lock,
//      HTTP 2xx from a SIEM webhook, etc.).
//   2. Be idempotent on batchId — the exporter retries the whole
//      batch on failure. Writing the same batchId twice must
//      produce the same object at the destination (overwrite,
//      versioned key, or dedup on receipt), never two.
//   3. Throw on any error. The exporter treats "returned
//      normally" as commit-successful and advances the cursor;
//      a partial write that resolves silently would drop events.
//
// Sink names are stable identifiers used as the cursor key in
// audit_export_state. Rename = new sink from scratch, so keep
// them boring.
export interface AuditExportSink {
  readonly name: string;
  writeBatch(input: AuditExportBatch): Promise<void>;
}

export interface AuditExportBatch {
  readonly batchId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly events: readonly AuditEventRow[];
}
