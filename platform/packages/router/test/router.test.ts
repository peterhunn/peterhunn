import { describe, it, expect } from "vitest";
import {
  ModelRegistry,
  Router,
  RouterError,
  BudgetExceededError,
  callModel,
  type BudgetSource,
  type ModelCallRecorder,
} from "../src/index.js";
import type { HouseholdId, HouseholdRiskTier } from "@atelier/domain";

describe("Router.select", () => {
  const registry = new ModelRegistry();
  const router = new Router(registry);

  it("picks a T1 model for a T1 task class by default", () => {
    const sel = router.select({ taskClass: "inbox.triage" });
    expect(sel.resolvedTier).toBe("T1");
    expect(sel.primary.tier).toBe("T1");
  });

  it("prefers self-hosted at the picked tier", () => {
    const sel = router.select({ taskClass: "inbox.triage" });
    expect(sel.primary.hosting).toBe("self_hosted");
  });

  it("returns higher tiers as fallbacks, never lower", () => {
    const sel = router.select({ taskClass: "inbox.triage" });
    for (const fb of sel.fallbacks) {
      expect(["T2", "T3"]).toContain(fb.tier);
    }
    expect(sel.fallbacks.length).toBeGreaterThan(0);
  });

  it("forces T3 for execute + hazardous side effect regardless of declared min", () => {
    const sel = router.select({
      taskClass: "inbox.triage",
      autonomyExecute: { sideEffectClass: "financial" },
    });
    expect(sel.resolvedTier).toBe("T3");
    expect(sel.reasons).toContain("execute_on_hazardous_side_effect_forces_T3");
  });

  it("pins to T3 for hnw households", () => {
    const sel = router.select({
      taskClass: "inbox.triage",
      householdRiskTier: "hnw" as HouseholdRiskTier,
    });
    expect(sel.resolvedTier).toBe("T3");
    expect(sel.reasons).toContain("hnw_risk_tier_pins_T3");
  });

  it("relaxes back to declared min when the household is over budget", () => {
    const sel = router.select({
      taskClass: "inbox.triage",
      householdRiskTier: "elevated" as HouseholdRiskTier,
      budgetStatus: "over",
    });
    expect(sel.resolvedTier).toBe("T1");
    expect(sel.reasons).toContain("budget_over_relaxed_to_declared_min");
  });

  it("rejects an unknown task class with no explicit minTier", () => {
    expect(() => router.select({ taskClass: "not.a.class" })).toThrow(RouterError);
  });

  it("accepts an unknown task class if minTier is explicit", () => {
    const sel = router.select({ taskClass: "custom.thing", minTier: "T2" });
    expect(sel.resolvedTier).toBe("T2");
  });
});

describe("callModel", () => {
  const registry = new ModelRegistry();
  const router = new Router(registry);

  const mkRecorder = (): ModelCallRecorder & { recorded: unknown[] } => {
    const recorded: unknown[] = [];
    let n = 0;
    return {
      recorded,
      record: (i) => {
        recorded.push(i);
        return { id: `mcl_${++n}` };
      },
    };
  };

  it("records a model call attributed to a household", async () => {
    const recorder = mkRecorder();
    const res = await callModel(
      { router, recorder },
      {
        taskClass: "inbox.triage",
        messages: [{ role: "user", content: "hello" }],
      },
      { householdId: "hh_test" as HouseholdId },
    );
    expect(res.tier).toBe("T1");
    expect(recorder.recorded).toHaveLength(1);
    expect((recorder.recorded[0] as { householdId: string }).householdId).toBe("hh_test");
    expect(res.usage.costUsdEstimated).toBeGreaterThan(0);
  });

  it("honors the router's tier for cost estimation", async () => {
    const recorder = mkRecorder();
    const res = await callModel(
      { router, recorder },
      {
        taskClass: "inbox.draft.reply.sensitive",
        messages: [{ role: "user", content: "draft" }],
      },
    );
    expect(res.tier).toBe("T3");
    // T3 rate is materially higher; even a 1-token output costs more.
    const rec = recorder.recorded[0] as { costUsdEstimated: number };
    expect(rec.costUsdEstimated).toBeGreaterThan(0);
  });

  it("refuses to call at all when the household is over the hard cap", async () => {
    const recorder = mkRecorder();
    const budget: BudgetSource = {
      status: () => "over_hard",
      riskTier: () => "standard" as HouseholdRiskTier,
    };
    await expect(
      callModel(
        { router, recorder, budget },
        {
          taskClass: "inbox.triage",
          messages: [{ role: "user", content: "hello" }],
        },
        { householdId: "hh_broke" as HouseholdId },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // Nothing recorded — refusal happens before selection.
    expect(recorder.recorded).toHaveLength(0);
  });

  it("still calls when over_hard without a householdId (system-scope calls)", async () => {
    const recorder = mkRecorder();
    const budget: BudgetSource = {
      status: () => "over_hard",
      riskTier: () => "standard" as HouseholdRiskTier,
    };
    const res = await callModel(
      { router, recorder, budget },
      {
        taskClass: "inbox.triage",
        messages: [{ role: "user", content: "hello" }],
      },
      // no householdId → no attribution, no refusal
    );
    expect(res.tier).toBe("T1");
    expect(recorder.recorded).toHaveLength(1);
  });
});
