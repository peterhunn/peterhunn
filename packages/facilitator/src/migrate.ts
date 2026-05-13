#!/usr/bin/env node
/**
 * Run the facilitator database migration.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@localhost/x490 npm run migrate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL environment variable is required");

const sql = postgres(url);
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
const schema = readFileSync(schemaPath, "utf-8");

console.log("Running x490 facilitator migrations...");
await sql.unsafe(schema);
console.log("Done.");
await sql.end();
