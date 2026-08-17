import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "./client.js";

const db = openDb();
migrate(db, { migrationsFolder: "./migrations" });
// eslint-disable-next-line no-console
console.log("migrations applied");
