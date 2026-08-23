import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  exportAuditBatch,
  fileSink,
  type AuditExportSink,
  type Db,
} from "@atelier/db";

// Background audit-event exporter.
//
// Ticks on its own timer (independent of the Gmail/Calendar sync
// scheduler so an export sink outage doesn't back up inbound
// mail). Each tick calls exportAuditBatch, which reads the sink's
// cursor from audit_export_state, pulls the next batch of audit
// events, writes them via the sink, and only then advances the
// cursor. Sink throw = cursor stays put = next tick retries the
// same window.
//
// Env:
//   ATELIER_AUDIT_EXPORT_ENABLED=1|0   (default: on if a sink resolves)
//   ATELIER_AUDIT_EXPORT_SINK=file     (only sink implemented today;
//                                       s3/webhook are follow-ups)
//   ATELIER_AUDIT_EXPORT_DIR=./data/audit-export
//   ATELIER_AUDIT_EXPORT_INTERVAL_SECONDS=60
//   ATELIER_AUDIT_EXPORT_BATCH_SIZE=500
//
// The file sink is designed to pair with an out-of-band job
// (rclone, `aws s3 sync`, a Fly volume backup) that moves the
// per-day shard directories into WORM storage. That split keeps
// AWS credentials off the app process while still giving the
// compliance surface the required "external, append-only,
// unmodifiable" trail.

export interface AuditExporter {
  start(): void;
  stop(): void;
  runOnce(): Promise<{ eventsExported: number; batchId?: string }>;
  sinkName(): string | null;
}

export interface AuditExporterOptions {
  readonly logger: {
    info: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
  readonly enabled?: boolean;
  readonly intervalSeconds?: number;
  readonly batchSize?: number;
  // If provided, overrides the env-driven sink resolution. Used
  // by tests to inject a spy sink and inspect what gets written.
  readonly sink?: AuditExportSink;
}

const DEFAULT_INTERVAL_S = 60;

const resolveSink = async (
  logger: AuditExporterOptions["logger"],
): Promise<AuditExportSink | null> => {
  const kind = (process.env["ATELIER_AUDIT_EXPORT_SINK"] ?? "file").toLowerCase();
  switch (kind) {
    case "file": {
      const dir = resolve(
        process.env["ATELIER_AUDIT_EXPORT_DIR"] ?? "./data/audit-export",
      );
      await mkdir(dir, { recursive: true });
      logger.info("audit export sink resolved", { kind, dir });
      return fileSink({ dir });
    }
    case "s3":
    case "webhook":
      logger.error(
        `audit export sink '${kind}' is not implemented yet — audit export DISABLED`,
      );
      return null;
    default:
      logger.error(`audit export sink '${kind}' unknown — audit export DISABLED`);
      return null;
  }
};

export const buildAuditExporter = async (
  db: Db,
  opts: AuditExporterOptions,
): Promise<AuditExporter> => {
  const enabled =
    (opts.enabled ?? process.env["ATELIER_AUDIT_EXPORT_ENABLED"] !== "0");
  const intervalMs = Math.max(
    (opts.intervalSeconds ??
      Number(process.env["ATELIER_AUDIT_EXPORT_INTERVAL_SECONDS"] ?? DEFAULT_INTERVAL_S)) *
      1000,
    5_000,
  );
  const batchSize =
    opts.batchSize ??
    Number(process.env["ATELIER_AUDIT_EXPORT_BATCH_SIZE"] ?? 500);

  const sink = opts.sink ?? (await resolveSink(opts.logger));
  let handle: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const runOnce = async (): Promise<{ eventsExported: number; batchId?: string }> => {
    if (!sink) return { eventsExported: 0 };
    if (inFlight) {
      opts.logger.info("audit export tick skipped — previous run in flight");
      return { eventsExported: 0 };
    }
    inFlight = true;
    try {
      const deps = { db, sink, batchSize, logger: opts.logger };
      const res = await exportAuditBatch(deps);
      return res.batchId
        ? { eventsExported: res.eventsExported, batchId: res.batchId }
        : { eventsExported: res.eventsExported };
    } catch (err) {
      opts.logger.error("audit export threw", {
        error: (err as Error).message,
      });
      return { eventsExported: 0 };
    } finally {
      inFlight = false;
    }
  };

  return {
    sinkName: () => sink?.name ?? null,
    start(): void {
      if (handle) return;
      if (!sink) {
        opts.logger.info("audit exporter start skipped — no sink");
        return;
      }
      if (!enabled) {
        opts.logger.info("audit exporter start skipped — disabled");
        return;
      }
      opts.logger.info("audit exporter starting", {
        sink: sink.name,
        intervalMs,
        batchSize,
      });
      void runOnce();
      handle = setInterval(() => void runOnce(), intervalMs);
      handle.unref?.();
    },
    stop(): void {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    },
    runOnce,
  };
};
