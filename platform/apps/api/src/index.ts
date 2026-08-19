import { openDb } from "@atelier/db";
import { buildServer } from "./server.js";
import { buildScheduler } from "./scheduler.js";
import { buildAutopilot } from "./autopilot.js";
import { buildPlaybookRunner } from "./playbook-runner.js";

const port = Number(process.env["PORT"] ?? 3001);
const host = process.env["HOST"] ?? "0.0.0.0";
const intervalSeconds = Number(
  process.env["ATELIER_SYNC_INTERVAL_SECONDS"] ?? 300,
);
const schedulerEnabled = process.env["ATELIER_SYNC_ENABLED"] !== "0";
const autopilotEnabled = process.env["ATELIER_AUTOPILOT_ENABLED"] !== "0";

const db = openDb();
const app = buildServer(db);
const schedulerLogger = {
  info: (msg: string, ctx?: unknown) => app.log.info(ctx as object, msg),
  error: (msg: string, ctx?: unknown) => app.log.error(ctx as object, msg),
};
const autopilot = autopilotEnabled
  ? buildAutopilot(db, { logger: schedulerLogger })
  : undefined;
const playbooksEnabled = process.env["ATELIER_PLAYBOOKS_ENABLED"] !== "0";
const playbookRunner = playbooksEnabled
  ? buildPlaybookRunner(db, { logger: schedulerLogger })
  : undefined;
const scheduler = buildScheduler(db, {
  intervalSeconds,
  enabled: schedulerEnabled,
  logger: schedulerLogger,
  ...(autopilot ? { autopilot } : {}),
  ...(playbookRunner ? { playbookRunner } : {}),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "atelier api shutting down");
  scheduler.stop();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ address }, "atelier api listening");
    scheduler.start();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
