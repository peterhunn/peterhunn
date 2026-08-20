/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateCto } from "./cto-export.js";

// Entry point for `pnpm --filter @atelier/domain generate:cto`.
// Reads NODE_TYPE_SPECS, emits the Accord Project namespace to
// packages/domain/dist/atelier.cto (or the path in ATELIER_CTO_OUT).

const target = resolve(
  process.env["ATELIER_CTO_OUT"] ?? "./dist/atelier.cto",
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, generateCto(), "utf-8");
console.log(`wrote ${target}`);
