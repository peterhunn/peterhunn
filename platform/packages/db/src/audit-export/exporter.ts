import { randomBytes } from "node:crypto";
import { nowIso } from "@atelier/domain";
import type { Db } from "../client.js";
import { auditRepo } from "../repositories/audit.js";
import { auditExportRepo } from "../repositories/audit-export.js";
import type { AuditExportSink } from "./types.js";

export interface AuditExporterDeps {
  readonly db: Db;
  readonly sink: AuditExportSink;
  readonly batchSize?: number;
  readonly logger?: {
    info: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

export interface AuditExporterResult {
  readonly eventsExported: number;
  readonly batchId?: string;
  readonly startAt?: string;
  readonly endAt?: string;
}

const DEFAULT_BATCH_SIZE = 500;

const newBatchId = (): string =>
  `${nowIso().replace(/[:.]/g, "-")}_${randomBytes(4).toString("hex")}`;

// Run one export pass for the given sink. Reads the sink's
// cursor, pulls the next batch of events strictly after it, hands
// the batch to the sink, and advances the cursor only if the
// sink resolves. Returns { eventsExported: 0 } when nothing is
// due — safe (and expected) to call on a tight timer.
//
// Not itself a scheduler; the api's scheduler wires this into a
// periodic tick alongside the Gmail/Calendar syncs.
export const exportAuditBatch = async (
  deps: AuditExporterDeps,
): Promise<AuditExporterResult> => {
  const audit = auditRepo(deps.db);
  const cursors = auditExportRepo(deps.db);
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  const cursor = cursors.get(deps.sink.name);
  const events = audit.listAfter(cursor, batchSize);

  if (events.length === 0) {
    deps.logger?.info("audit export tick — nothing to send", {
      sink: deps.sink.name,
      lastExportedAt: cursor.lastExportedAt,
    });
    return { eventsExported: 0 };
  }

  const startAt = events[0]!.at;
  const endAt = events[events.length - 1]!.at;
  const batchId = newBatchId();

  try {
    await deps.sink.writeBatch({ batchId, startAt, endAt, events });
  } catch (err) {
    deps.logger?.error("audit export sink threw — cursor NOT advanced", {
      sink: deps.sink.name,
      batchId,
      count: events.length,
      error: (err as Error).message,
    });
    throw err;
  }

  cursors.advance({
    sink: deps.sink.name,
    lastExportedEventId: events[events.length - 1]!.id,
    lastExportedAt: endAt,
    eventsInBatch: events.length,
  });

  deps.logger?.info("audit export batch committed", {
    sink: deps.sink.name,
    batchId,
    count: events.length,
    startAt,
    endAt,
  });

  return { eventsExported: events.length, batchId, startAt, endAt };
};
