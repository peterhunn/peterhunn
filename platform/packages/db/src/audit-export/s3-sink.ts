import { S3Client, PutObjectCommand, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { AuditExportSink, AuditExportBatch } from "./types.js";

// S3 sink for the audit exporter. Each batch becomes one object
// under `<prefix>/<yyyy>/<mm>/<dd>/<batchId>.ndjson`. Body is
// gzip-friendly newline-delimited JSON; server-side encryption is
// AES256 by default. Compliance posture: point this at a bucket
// with Object Lock enabled in COMPLIANCE mode and a matching
// retention rule, and the app-side path can't tamper with what's
// been shipped (that's the whole point of the split).
//
// The sink DOES NOT create the bucket or configure lock — that
// setup is one-time infra work (Terraform / CloudFormation) that
// the operator does out of band. Failing over to another region /
// bucket is a config change; nothing about the sink code changes.
//
// Idempotency: if the same batchId is written twice (retry after a
// transient failure), the second PutObject overwrites the first at
// the same key — no duplicate object. With Object Lock, the
// overwrite creates a new version instead; both are legit and the
// consumer dedups on `batchId` inside the ndjson.
//
// AWS credential resolution follows the standard SDK chain:
// environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), IAM
// role (fly.io machines, EC2, ECS task), then ~/.aws/config. The
// sink never sees the credentials directly.
export interface S3SinkOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly region?: string;
  readonly name?: string;
  // Escape hatch for tests / custom endpoints (localstack, minio).
  // Passed straight through to `new S3Client(...)`.
  readonly clientOverride?: S3ClientConfig;
}

export const s3Sink = (opts: S3SinkOptions): AuditExportSink => {
  const client = new S3Client({
    ...(opts.region !== undefined && { region: opts.region }),
    ...opts.clientOverride,
  });
  const prefix = (opts.prefix ?? "atelier/audit").replace(/\/+$/, "");
  const name = opts.name ?? `s3://${opts.bucket}/${prefix}`;

  return {
    name,
    async writeBatch(batch: AuditExportBatch): Promise<void> {
      const d = new Date(batch.startAt);
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const key = `${prefix}/${yyyy}/${mm}/${dd}/${batch.batchId}.ndjson`;
      const body =
        batch.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: body,
          ContentType: "application/x-ndjson",
          // Bucket-default SSE usually wins; this is a belt-and-
          // braces to make sure the bytes are never plaintext at
          // rest, even if bucket defaults get changed later.
          ServerSideEncryption: "AES256",
        }),
      );
    },
  };
};
