import { openDb } from "@atelier/db";
import { buildServer } from "./server.js";

const port = Number(process.env["PORT"] ?? 3001);
const host = process.env["HOST"] ?? "0.0.0.0";

const db = openDb();
const app = buildServer(db);

app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ address }, "atelier api listening");
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
