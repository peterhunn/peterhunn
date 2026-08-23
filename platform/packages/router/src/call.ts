import { createHash, randomBytes } from "node:crypto";
import type {
  HouseholdId,
  HouseholdRiskTier,
  ModelCall,
  ModelResponse,
  SideEffectClass,
  TierId,
} from "@atelier/domain";
import type { Router } from "./router.js";
import { getAdapter } from "./providers/registry.js";

// Persistence seam — everything the runtime needs to record about a
// model call. Kept narrow so tests skip the DB entirely.
export interface ModelCallRecorder {
  record(input: {
    householdId?: HouseholdId;
    taskClass: string;
    minTier: TierId;
    selectedTier: TierId;
    modelId: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    costUsdEstimated: number;
    latencyMs: number;
    finishReason: string;
    routerReasons: readonly string[];
    inputHash: string;
    outputHash: string;
    triggeringRunId?: string;
    triggeringTaskId?: string;
  }): { id: string };
}

export type BudgetStatus =
  | "under"
  | "approaching"
  | "over"
  | "over_hard";

export interface BudgetSource {
  status(householdId: HouseholdId): BudgetStatus;
  riskTier(householdId: HouseholdId): HouseholdRiskTier;
}

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError" as const;
  constructor(householdId: HouseholdId) {
    super(
      `Model call refused: household ${householdId} is over the hard budget cap. Manager review required before further model spend.`,
    );
  }
}

export interface CallModelDeps {
  readonly router: Router;
  readonly recorder: ModelCallRecorder;
  readonly budget?: BudgetSource;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface CallModelOptions {
  readonly householdId?: HouseholdId;
  readonly triggeringRunId?: string;
  readonly triggeringTaskId?: string;
  readonly autonomyExecute?: { readonly sideEffectClass: SideEffectClass };
}

const hash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

const newCallId = (): string => `mcl_${randomBytes(12).toString("hex")}`;

// The runtime entry point. Picks a model via the router, invokes it
// (mock provider today), records the call, returns the response.
// Fallback chain is used if the primary fails — every attempt is
// recorded so replay and cost analysis see the full ladder.
export const callModel = async (
  deps: CallModelDeps,
  call: ModelCall,
  opts: CallModelOptions = {},
): Promise<ModelResponse> => {
  const budgetStatus = opts.householdId
    ? deps.budget?.status(opts.householdId)
    : undefined;
  const riskTier = opts.householdId ? deps.budget?.riskTier(opts.householdId) : undefined;

  // Hard-fail on runaway spend. The soft "over" path degrades to
  // min tier and keeps running (accepted phase-0 behavior). The
  // hard cap is a further multiple (default 1.5×, see runtime.ts)
  // and refuses to call at all so a stuck agent can't drain the
  // account. Manager review clears it by raising the cap or
  // waiting for the 30-day window to slide.
  if (budgetStatus === "over_hard" && opts.householdId) {
    throw new BudgetExceededError(opts.householdId);
  }

  const selection = deps.router.select({
    taskClass: call.taskClass,
    ...(call.minTier !== undefined && { minTier: call.minTier }),
    ...(opts.autonomyExecute !== undefined && { autonomyExecute: opts.autonomyExecute }),
    ...(riskTier !== undefined && { householdRiskTier: riskTier }),
    ...(budgetStatus !== undefined && { budgetStatus }),
  });

  const inputHash = hash(call.messages);

  const chain = [selection.primary, ...selection.fallbacks];
  let lastError: unknown = null;
  for (const model of chain) {
    try {
      const t0 = Date.now();
      const adapter = getAdapter(model.provider);
      const raw = await adapter.invoke(model, call);
      const latencyMs = Math.max(raw.latencyMs, Date.now() - t0);
      const outputHash = hash(raw.content);
      const rec = deps.recorder.record({
        ...(opts.householdId !== undefined && { householdId: opts.householdId }),
        taskClass: call.taskClass,
        minTier: selection.minTier,
        selectedTier: model.tier,
        modelId: model.id,
        provider: model.provider,
        inputTokens: raw.usage.inputTokens,
        outputTokens: raw.usage.outputTokens,
        cachedInputTokens: raw.usage.cachedInputTokens,
        cacheWriteInputTokens: raw.usage.cacheWriteInputTokens,
        costUsdEstimated: raw.usage.costUsdEstimated,
        latencyMs,
        finishReason: raw.finishReason,
        routerReasons: [...selection.reasons, ...raw.reasons],
        inputHash,
        outputHash,
        ...(opts.triggeringRunId !== undefined && { triggeringRunId: opts.triggeringRunId }),
        ...(opts.triggeringTaskId !== undefined && { triggeringTaskId: opts.triggeringTaskId }),
      });
      deps.logger?.info("model call recorded", {
        modelId: model.id,
        tier: model.tier,
        callId: rec.id,
      });
      return {
        modelCallId: rec.id ?? newCallId(),
        modelId: model.id,
        tier: model.tier,
        content: raw.content,
        toolCalls: raw.toolCalls,
        usage: raw.usage,
        latencyMs,
        finishReason: raw.finishReason,
        reasons: [...selection.reasons, ...raw.reasons],
      };
    } catch (err) {
      lastError = err;
      deps.logger?.info("model call failed, escalating", {
        modelId: model.id,
        error: (err as Error).message,
      });
    }
  }
  throw new Error(
    `All models in the fallback chain failed: ${
      lastError ? (lastError as Error).message : "unknown"
    }`,
  );
};
