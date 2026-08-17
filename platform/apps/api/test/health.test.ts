import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb } from "@atelier/db";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });
  app = buildServer(db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("health", () => {
  it("responds ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.at).toBe("string");
  });
});
