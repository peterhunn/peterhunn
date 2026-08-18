import {
  TIER_RANK,
  tierAtLeast,
  type HouseholdRiskTier,
  type ModelCapability,
  type ModelSpec,
  type SideEffectClass,
  type TierId,
} from "@atelier/domain";
import type { ModelRegistry } from "./registry.js";

export interface RouterInputs {
  readonly taskClass: string;
  readonly minTier?: TierId;
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly householdRiskTier?: HouseholdRiskTier;
  // If the LLM is being asked to authorize a side-effecting action
  // that will actually execute, we honor the models.md rule:
  // execute + irreversible/financial/communication is always T3.
  readonly autonomyExecute?: {
    readonly sideEffectClass: SideEffectClass;
  };
  readonly budgetStatus?: "under" | "approaching" | "over";
}

export interface RouterSelection {
  readonly primary: ModelSpec;
  readonly fallbacks: readonly ModelSpec[];
  readonly resolvedTier: TierId;
  readonly minTier: TierId;
  readonly reasons: readonly string[];
}

export class RouterError extends Error {
  override readonly name = "RouterError" as const;
}

export class Router {
  constructor(private readonly registry: ModelRegistry) {}

  select(inputs: RouterInputs): RouterSelection {
    const reasons: string[] = [];

    const taskClassSpec = this.registry.getTaskClass(inputs.taskClass);
    if (!taskClassSpec && inputs.minTier === undefined) {
      throw new RouterError(
        `Unknown task class '${inputs.taskClass}' and no explicit minTier provided`,
      );
    }
    const declaredMin: TierId =
      taskClassSpec?.minTier ?? inputs.minTier ?? "T2";

    let tier: TierId = declaredMin;

    // Hard rule: execute + irreversible / financial / communication is
    // always T3, regardless of what the task class says. Encoded so an
    // agent can't get a cheaper model by mistake for a high-blast-radius
    // action.
    if (inputs.autonomyExecute) {
      const cls = inputs.autonomyExecute.sideEffectClass;
      const hazardous =
        cls === "write_irreversible" || cls === "financial" || cls === "communication";
      if (hazardous) {
        tier = tierAtLeast(tier, "T3");
        reasons.push("execute_on_hazardous_side_effect_forces_T3");
      }
    }

    // Household risk tier pins.
    if (inputs.householdRiskTier === "hnw") {
      tier = tierAtLeast(tier, "T3");
      reasons.push("hnw_risk_tier_pins_T3");
    } else if (inputs.householdRiskTier === "elevated") {
      tier = tierAtLeast(tier, "T2");
      reasons.push("elevated_risk_tier_pins_T2");
    }

    // Budget-driven light demotion — allowed only within declared min.
    if (inputs.budgetStatus === "over" && TIER_RANK[tier] > TIER_RANK[declaredMin]) {
      tier = declaredMin;
      reasons.push("budget_over_relaxed_to_declared_min");
    }

    const requiredCaps = [
      ...(taskClassSpec?.requiresCapabilities ?? []),
      ...(inputs.requiredCapabilities ?? []),
    ];
    const uniqueCaps = Array.from(new Set(requiredCaps));

    const primary = pickForTier(this.registry, tier, uniqueCaps);
    if (!primary) {
      throw new RouterError(
        `No available model for tier ${tier} with capabilities ${JSON.stringify(uniqueCaps)}`,
      );
    }

    // Fallback chain — walk up the tier ladder from the primary.
    const fallbackTiers: TierId[] = [];
    for (const t of ["T1", "T2", "T3"] as TierId[]) {
      if (TIER_RANK[t] > TIER_RANK[tier]) fallbackTiers.push(t);
    }
    const fallbacks: ModelSpec[] = [];
    for (const t of fallbackTiers) {
      const m = pickForTier(this.registry, t, uniqueCaps, primary.id);
      if (m) fallbacks.push(m);
    }

    return {
      primary,
      fallbacks,
      resolvedTier: tier,
      minTier: declaredMin,
      reasons,
    };
  }
}

const pickForTier = (
  registry: ModelRegistry,
  tier: TierId,
  requiredCaps: readonly ModelCapability[],
  excludeId?: string,
): ModelSpec | null => {
  const candidates = registry
    .modelsForTier(tier)
    .filter((m) => (excludeId ? m.id !== excludeId : true))
    .filter((m) => requiredCaps.every((c) => m.capabilities.includes(c)));
  if (candidates.length === 0) return null;
  // Prefer self-hosted at the picked tier for cost, then by lower cost.
  candidates.sort((a, b) => {
    if (a.hosting !== b.hosting) return a.hosting === "self_hosted" ? -1 : 1;
    return a.costPer1kInputUsd - b.costPer1kInputUsd;
  });
  return candidates[0] ?? null;
};
