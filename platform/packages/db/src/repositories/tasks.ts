import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  orchestratorRuns,
  tasks,
  type OrchestratorRunRow,
  type TaskRow,
} from "../schema/tasks.js";

const newRunId = (): string => `run_${randomBytes(12).toString("hex")}`;
const newTaskId = (): string => `tsk_${randomBytes(12).toString("hex")}`;

export interface CreateRunInput {
  readonly householdId: HouseholdId;
  readonly intentKind: string;
  readonly intentAttrs: Record<string, unknown>;
  readonly origin: "customer" | "manager" | "proactive" | "system";
  readonly originBy: string;
}

export interface CreateTaskInput {
  readonly runId: string;
  readonly householdId: HouseholdId;
  readonly agent: string;
  readonly agentVersion: string;
  readonly kind: string;
  readonly inputs: Record<string, unknown>;
}

export interface UpdateTaskInput {
  readonly state: TaskRow["state"];
  readonly outputs?: Record<string, unknown>;
  readonly decisionSummary?: string;
  readonly errorMessage?: string;
}

export const taskRepo = (db: Db) => ({
  startRun(input: CreateRunInput): OrchestratorRunRow {
    const id = newRunId();
    const now = nowIso();
    db.insert(orchestratorRuns)
      .values({
        id,
        householdId: input.householdId,
        intentKind: input.intentKind,
        intentAttrs: input.intentAttrs,
        origin: input.origin,
        originBy: input.originBy,
        state: "running",
        createdAt: now,
      })
      .run();
    const row = db.select().from(orchestratorRuns).where(eq(orchestratorRuns.id, id)).get();
    if (!row) throw new Error("run insert did not return");
    return row;
  },

  finishRun(id: string, state: OrchestratorRunRow["state"]): void {
    db.update(orchestratorRuns)
      .set({ state, completedAt: nowIso() })
      .where(eq(orchestratorRuns.id, id))
      .run();
  },

  createTask(input: CreateTaskInput): TaskRow {
    const id = newTaskId();
    const now = nowIso();
    db.insert(tasks)
      .values({
        id,
        runId: input.runId,
        householdId: input.householdId,
        agent: input.agent,
        agentVersion: input.agentVersion,
        kind: input.kind,
        inputs: input.inputs,
        state: "received",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new Error("task insert did not return");
    return row;
  },

  updateTask(id: string, input: UpdateTaskInput): void {
    db.update(tasks)
      .set({
        state: input.state,
        outputs: input.outputs ?? null,
        decisionSummary: input.decisionSummary ?? null,
        errorMessage: input.errorMessage ?? null,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, id))
      .run();
  },

  getRun(householdId: HouseholdId, runId: string): OrchestratorRunRow | null {
    return (
      db
        .select()
        .from(orchestratorRuns)
        .where(
          and(
            eq(orchestratorRuns.householdId, householdId),
            eq(orchestratorRuns.id, runId),
          ),
        )
        .get() ?? null
    );
  },

  getTask(householdId: HouseholdId, taskId: string): TaskRow | null {
    return (
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.householdId, householdId), eq(tasks.id, taskId)))
        .get() ?? null
    );
  },

  listRuns(householdId: HouseholdId, limit = 50): OrchestratorRunRow[] {
    return db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.householdId, householdId))
      .orderBy(desc(orchestratorRuns.createdAt))
      .limit(limit)
      .all();
  },

  listTasks(householdId: HouseholdId, limit = 100): TaskRow[] {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.householdId, householdId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .all();
  },

  listTasksForRun(runId: string): TaskRow[] {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.runId, runId))
      .orderBy(sql`${tasks.createdAt} ASC`)
      .all();
  },

  countTasks(householdId: HouseholdId): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.householdId, householdId)))
      .get();
    return Number(row?.n ?? 0);
  },
});
