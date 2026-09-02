import { createHash } from "node:crypto";
import { mkdirSync, createReadStream, statSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

// Blob storage backend. Phase 0 ships local disk only — a factory
// so a future S3 backend slots in without touching the routes.
// Files are content-addressed by sha256 with a two-level shard
// prefix (ab/cdef…) so a single directory never grows into the
// tens-of-thousands range.
//
// Configure: ATELIER_BLOB_DIR (default: packages/db/data/blobs).

export interface BlobStore {
  readonly backend: "local" | "s3";
  put(buf: Buffer): Promise<{ sha256: string; byteSize: number; storageRef: string }>;
  stream(storageRef: string): Readable;
  exists(storageRef: string): boolean;
  size(storageRef: string): number;
}

const shardedPath = (root: string, sha256: string): string =>
  join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);

export const buildLocalBlobStore = (rootOpt?: string): BlobStore => {
  const root = resolve(
    rootOpt ??
      process.env["ATELIER_BLOB_DIR"] ??
      "./packages/db/data/blobs",
  );
  mkdirSync(root, { recursive: true });

  return {
    backend: "local",
    async put(buf: Buffer) {
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const dest = shardedPath(root, sha256);
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      // Idempotent write: if the file already exists (content-
      // addressed => same content), skip. A partial write races
      // against itself under high concurrency, but blob puts are
      // rare (one per manager upload); accept that risk for phase 0.
      if (!existsSync(dest)) {
        await writeFile(dest, buf);
      }
      return { sha256, byteSize: buf.byteLength, storageRef: sha256 };
    },
    stream(storageRef: string) {
      return createReadStream(shardedPath(root, storageRef));
    },
    exists(storageRef: string) {
      return existsSync(shardedPath(root, storageRef));
    },
    size(storageRef: string) {
      return statSync(shardedPath(root, storageRef)).size;
    },
  };
};

// Process-wide default. Wired in server.ts via getBlobStore().
let _default: BlobStore | null = null;
export const getBlobStore = (): BlobStore => {
  if (!_default) _default = buildLocalBlobStore();
  return _default;
};

// Test seams — replace the process-wide store for isolation.
export const setBlobStoreForTesting = (store: BlobStore): void => {
  _default = store;
};
