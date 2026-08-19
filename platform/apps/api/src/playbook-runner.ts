import {
  householdPlaybookRepo,
  householdRepo,
  type Db,
  type HouseholdPlaybookRow,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import {
  buildPlaybookRegistry,
  computeNextFireAt,
  type PlaybookRegistry,
} from "@atelier/agents";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "./runtime.js";

// Playbook runner — walks every enabled household_playbook whose
// next_fire_at has passed, dispatches its intent through the
// orchestrator (actor=system:playbook), and advances next_fire_at to
// the next slot. Errors on one playbook never stop the loop.
//
// Frozen households and disabled-autopilot households are skipped
// silently — a manager who paused autopilot doesn't want scheduled
// playbooks firing behind their back either.

const PLAYBOOK_ACTOR = {
  type: "system" as const,
  id: "playbook",
  displayName: "Playbook",
};

export interface PlaybookRunnerLogger {
  info: (msg: string, ctx?: unknown) => void;
  error: (msg: string, ctx?: unknown) => void;
}

export interface PlaybookFireRecord {
  readonly householdId: string;
  readonly playbookId: string;
  readonly outcome: "fired" | "skipped" | "unknown_playbook" | "error";
  readonly reason?: string;
  readonly runId?: string;
}

export const buildPlaybookRunner = (
  db: Db,
  opts: { logger?: PlaybookRunnerLogger; registry?: PlaybookRegistry } = {},
) => {
  const logger = opts.logger ?? { info: () => {}, error: () => {} };
  const registry = opts.registry ?? buildPlaybookRegistry();
  const households = householdRepo(db);
  const playbooks = householdPlaybookRepo(db);

  const fireOne = async (row: HouseholdPlaybookRow): Promise<PlaybookFireRecord> => {
    const def = registry.get(row.playbookId);
    if (!def) {
      logger.info("playbook runner skipping unknown playbook", {
        householdId: row.householdId,
        playbookId: row.playbookId,
      });
      // Advance nextFireAt an hour so we don't hammer this row every
      // tick until a manager removes it.
      playbooks.recordFire({
        householdId: row.householdId as HouseholdId,
        playbookId: row.playbookId,
        nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      return {
        householdId: row.householdId,
        playbookId: row.playbookId,
        outcome: "unknown_playbook",
      };
    }

    const hh = households.get(row.householdId as HouseholdId);
    if (!hh || hh.frozenAt || !hh.autopilotEnabled) {
      const reason = !hh
        ? "household_missing"
        : hh.frozenAt
          ? "household_frozen"
          : "autopilot_disabled";
      // Don't fire, but do advance nextFireAt so the row moves
      // forward with real time. A paused household shouldn't build
      // a backlog that all fires at once on unpause.
      const next = computeNextFireAt(def.schedule, new Date()).toISOString();
      playbooks.recordFire({
        householdId: row.householdId as HouseholdId,
        playbookId: row.playbookId,
        nextFireAt: next,
      });
      logger.info("playbook runner skipped", {
        householdId: row.householdId,
        playbookId: row.playbookId,
        reason,
        rescheduledFor: next,
      });
      return {
        householdId: row.householdId,
        playbookId: row.playbookId,
        outcome: "skipped",
        reason,
      };
    }

    const intent = def.buildIntent(row.config as Record<string, unknown>);
    try {
      const orch = buildOrchestrator(db);
      const result = await orch.run({
        householdId: row.householdId as HouseholdId,
        actor: PLAYBOOK_ACTOR,
        graph: buildGraphView(db, row.householdId as HouseholdId),
        writer: buildGraphWriter(
          db,
          row.householdId as HouseholdId,
          `system:playbook:${row.playbookId}`,
        ),
        intent: {
          ...intent,
          origin: { source: "proactive", by: `playbook:${row.playbookId}` },
        },
      });
      const nextFire = computeNextFireAt(def.schedule, new Date()).toISOString();
      playbooks.recordFire({
        householdId: row.householdId as HouseholdId,
        playbookId: row.playbookId,
        nextFireAt: nextFire,
        lastRunId: result.runId,
      });
      logger.info("playbook fired", {
        householdId: row.householdId,
        playbookId: row.playbookId,
        state: result.state,
        nextFireAt: nextFire,
      });
      return {
        householdId: row.householdId,
        playbookId: row.playbookId,
        outcome: "fired",
        runId: result.runId,
      };
    } catch (err) {
      logger.error("playbook fire threw", {
        householdId: row.householdId,
        playbookId: row.playbookId,
        error: (err as Error).message,
      });
      // Still advance so we don't crash-loop on a bad config.
      const next = new Date(Date.now() + 3600_000).toISOString();
      playbooks.recordFire({
        householdId: row.householdId as HouseholdId,
        playbookId: row.playbookId,
        nextFireAt: next,
      });
      return {
        householdId: row.householdId,
        playbookId: row.playbookId,
        outcome: "error",
        reason: (err as Error).message,
      };
    }
  };

  return {
    registry,
    async runDue(): Promise<PlaybookFireRecord[]> {
      const due = playbooks.listDue();
      const results: PlaybookFireRecord[] = [];
      for (const row of due) results.push(await fireOne(row));
      return results;
    },
    async fireById(
      householdId: HouseholdId,
      playbookId: string,
    ): Promise<PlaybookFireRecord | null> {
      const row = playbooks.get(householdId, playbookId);
      if (!row) return null;
      return await fireOne(row);
    },
  };
};

export type PlaybookRunner = ReturnType<typeof buildPlaybookRunner>;
