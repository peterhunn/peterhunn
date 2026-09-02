import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["ATELIER_DB_URL"] ?? "./data/atelier.db",
  },
} satisfies Config;
