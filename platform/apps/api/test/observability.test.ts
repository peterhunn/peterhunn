import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  actionRepo,
  householdRepo,
  identityRepo,
  modelCallRepo,
  taskRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;
let runId: string;
let taskId: string;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  // Seed a run + task + two model calls + one action so the
  // observability endpoints have something to return.
  const tasks = taskRepo(db);
  const run = tasks.startRun({
    householdId: hh,
    intentKind: "inbox.message.process",
    intentAttrs: { messageId: "seed" },
    origin: "manager",
    originBy: "test",
  });
  runId = run.id;
  const task = tasks.createTask({
    runId: run.id,
    householdId: hh,
    agent: "inbox",
    agentVersion: "0.1.0",
    kind: "inbox.message.process",
    inputs: {},
  });
  taskId = task.id;
  tasks.updateTask(task.id, {
    state: "completed",
    decisionSummary: "Triaged + drafted",
  } as never);
  tasks.finishRun(run.id, "completed");

  const modelCalls = modelCallRepo(db);
  modelCalls.record({
    householdId: hh,
    taskClass: "inbox.triage",
    minTier: "t1",
    selectedTier: "t1",
    modelId: "claude-haiku-4-5",
    provider: "anthropic",
    inputTokens: 120,
    outputTokens: 40,
    cachedInputTokens: 60,
    costUsdEstimated: 0.0004,
    latencyMs: 320,
    finishReason: "stop",
    routerReasons: ["min_tier"],
    inputHash: "in1",
    outputHash: "out1",
    triggeringRunId: run.id,
    triggeringTaskId: task.id,
  });
  modelCalls.record({
    householdId: hh,
    taskClass: "inbox.draft.reply.low",
    minTier: "t2",
    selectedTier: "t2",
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    inputTokens: 400,
    outputTokens: 120,
    costUsdEstimated: 0.0032,
    latencyMs: 780,
    finishReason: "stop",
    routerReasons: ["min_tier"],
    inputHash: "in2",
    outputHash: "out2",
    triggeringRunId: run.id,
    triggeringTaskId: task.id,
  });

  actionRepo(db).record({
    householdId: hh,
    agent: "inbox",
    agentVersion: "0.1.0",
    tool: "message.send",
    toolVersion: "0.3.0",
    actionClass: "message.send",
    domain: "communication" as never,
    inputsHash: "seed",
    outcome: "succeeded",
    summary: "Drafted reply queued for approval",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("observability", () => {
  it("model-calls/daily returns bucketed data covering both tiers", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/model-calls/daily?windowDays=30`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(30);
    // Both calls landed today (same UTC day); one bucket, both tiers.
    expect(body.days.length).toBeGreaterThanOrEqual(1);
    const today = body.days[body.days.length - 1];
    expect(today.byTier.t1?.calls).toBe(1);
    expect(today.byTier.t2?.calls).toBe(1);
    expect(today.totalCalls).toBe(2);
    expect(today.totalUsd).toBeCloseTo(0.0036, 4);
  });

  it("task/model-calls returns the two calls with per-call detail and summary", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/tasks/${taskId}/model-calls`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task.id).toBe(taskId);
    expect(body.summary.totalCalls).toBe(2);
    expect(body.summary.totalTokensIn).toBe(520);
    expect(body.summary.totalTokensOut).toBe(160);
    expect(body.summary.totalCachedInputTokens).toBe(60);
    expect(body.calls).toHaveLength(2);
    expect(body.calls[0]!.summary).toContain("inbox.triage");
  });

  it("task/model-calls 404s for an unknown task id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/tasks/tsk_missing/model-calls`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("runs/:runId returns a chronological timeline of all four event kinds", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/runs/${runId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.id).toBe(runId);
    expect(body.summary.taskCount).toBe(1);
    expect(body.summary.modelCallCount).toBe(2);
    expect(body.summary.actionCount).toBeGreaterThan(0);
    const kinds = new Set(body.timeline.map((e: { kind: string }) => e.kind));
    expect(kinds.has("run")).toBe(true);
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("model_call")).toBe(true);
    expect(kinds.has("action")).toBe(true);
    // Timeline sorted by `at` ascending.
    const times = body.timeline.map((e: { at: string }) => e.at);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });

  it("runs/:runId 404s for an unknown run id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/runs/run_missing`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
