import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema/index.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  readonly url?: string;
}

export const openDb = (opts: OpenDbOptions = {}): Db => {
  const url = opts.url ?? process.env["ATELIER_DB_URL"] ?? "./data/atelier.db";
  const filePath = url.startsWith(":memory:") ? url : resolve(url);
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
};

export { schema };
