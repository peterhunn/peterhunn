import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { AuditExportSink, AuditExportBatch } from "./types.js";

// Newline-delimited-JSON file sink. Each batch becomes one file
// named `<batchId>.ndjson` under `<dir>/<yyyy>/<mm>/<dd>/`. The
// per-day shard prefix keeps a single directory from growing to
// tens of thousands of files, which cheap filesystems handle
// poorly.
//
// Durability: writes go through open(w) → write() → fsync() →
// close(). Sync is what actually gets the bytes to the platter
// (or to fly's block storage), so the exporter can safely
// advance the cursor after this resolves. Ownership of moving
// these files off-box into WORM storage sits with an
// out-of-band job (rclone / aws s3 sync / etc.) so the app
// process doesn't need cloud credentials for the compliance
// path.
export const fileSink = (opts: { dir: string; name?: string }): AuditExportSink => {
  const name = opts.name ?? "file";
  return {
    name,
    async writeBatch(batch: AuditExportBatch): Promise<void> {
      const d = new Date(batch.startAt);
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const dir = join(opts.dir, yyyy, mm, dd);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${batch.batchId}.ndjson`);
      const body = batch.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const fh = await open(path, "w", 0o640);
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
  };
};
