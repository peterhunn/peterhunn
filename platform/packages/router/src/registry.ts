import type { ModelCapability, ModelSpec, TaskClassSpec, TierId } from "@atelier/domain";

// Model registry — the single source of truth listing every model the
// router may pick. Rows are code today; a config-driven variant with
// eval provenance is a later addition.

// Model registry — each row names a `provider` that resolves to a
// concrete adapter in providers/registry.ts. Rows without a live API
// key fall through to the mock adapter and mark the response with a
// visible reason so the fallback is never silent.
//
// Costs are illustrative and drift; update them alongside vendor
// pricing changes. Model ids should track the current names from each
// vendor's docs — cross-check when in doubt.
export const BUILTIN_MODELS: ModelSpec[] = [
  // ─── T1: small, self-hostable / cheap ─────────────────────────
  {
    id: "llama-3.1-8b-instruct",
    provider: "openai_compatible:ollama",
    displayName: "Llama 3.1 8B (Ollama)",
    tier: "T1",
    hosting: "self_hosted",
    contextTokens: 32_000,
    capabilities: ["json_mode", "streaming"],
    costPer1kInputUsd: 0.0002,
    costPer1kOutputUsd: 0.0004,
    latencyP50Ms: 200,
    latencyP95Ms: 800,
    status: "available",
    limitations: ["weak on multi-step math"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    tier: "T1",
    hosting: "provider_api",
    contextTokens: 200_000,
    capabilities: ["function_calling", "json_mode", "streaming", "long_context"],
    costPer1kInputUsd: 0.001,
    costPer1kOutputUsd: 0.005,
    latencyP50Ms: 400,
    latencyP95Ms: 1500,
    status: "available",
    limitations: [],
  },

  // ─── T2: mid ─────────────────────────────────────────────────
  {
    id: "qwen2.5-32b-instruct",
    provider: "openai_compatible:together",
    displayName: "Qwen 2.5 32B (Together)",
    tier: "T2",
    hosting: "provider_api",
    contextTokens: 32_000,
    capabilities: ["function_calling", "json_mode", "streaming", "long_context"],
    costPer1kInputUsd: 0.0008,
    costPer1kOutputUsd: 0.0008,
    latencyP50Ms: 700,
    latencyP95Ms: 2500,
    status: "available",
    limitations: [],
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    tier: "T2",
    hosting: "provider_api",
    contextTokens: 200_000,
    capabilities: [
      "function_calling",
      "json_mode",
      "streaming",
      "long_context",
      "vision",
    ],
    costPer1kInputUsd: 0.003,
    costPer1kOutputUsd: 0.015,
    latencyP50Ms: 700,
    latencyP95Ms: 2500,
    status: "available",
    limitations: [],
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    tier: "T2",
    hosting: "provider_api",
    contextTokens: 1_000_000,
    capabilities: ["function_calling", "json_mode", "streaming", "long_context", "vision"],
    costPer1kInputUsd: 0.00035,
    costPer1kOutputUsd: 0.00105,
    latencyP50Ms: 500,
    latencyP95Ms: 2000,
    status: "available",
    limitations: [],
  },

  // ─── T3: frontier ────────────────────────────────────────────
  {
    id: "claude-opus-5",
    provider: "anthropic",
    displayName: "Claude Opus 5",
    tier: "T3",
    hosting: "provider_api",
    contextTokens: 200_000,
    capabilities: [
      "function_calling",
      "json_mode",
      "streaming",
      "long_context",
      "vision",
    ],
    costPer1kInputUsd: 0.015,
    costPer1kOutputUsd: 0.075,
    latencyP50Ms: 1500,
    latencyP95Ms: 6000,
    status: "available",
    limitations: [],
  },
  {
    id: "gpt-5",
    provider: "openai",
    displayName: "GPT-5",
    tier: "T3",
    hosting: "provider_api",
    contextTokens: 200_000,
    capabilities: [
      "function_calling",
      "json_mode",
      "streaming",
      "long_context",
      "vision",
    ],
    costPer1kInputUsd: 0.01,
    costPer1kOutputUsd: 0.04,
    latencyP50Ms: 1500,
    latencyP95Ms: 6000,
    status: "available",
    limitations: [],
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    tier: "T3",
    hosting: "provider_api",
    contextTokens: 2_000_000,
    capabilities: [
      "function_calling",
      "json_mode",
      "streaming",
      "long_context",
      "vision",
    ],
    costPer1kInputUsd: 0.00125,
    costPer1kOutputUsd: 0.005,
    latencyP50Ms: 1200,
    latencyP95Ms: 5000,
    status: "available",
    limitations: [],
  },
];

// Task class registry — per-agent-task minimum tier.
// See docs/24-model-routing.md §"Agent-to-tier baseline".
export const BUILTIN_TASK_CLASSES: TaskClassSpec[] = [
  { id: "inbox.triage", minTier: "T1", description: "Triage classification" },
  { id: "inbox.extract", minTier: "T1", description: "Entity/obligation extraction" },
  {
    id: "inbox.draft.reply.low",
    minTier: "T2",
    description: "Draft reply, low-stakes recipient",
  },
  {
    id: "inbox.draft.reply.sensitive",
    minTier: "T3",
    description: "Draft reply, sensitive recipient (counsel, medical, employer)",
  },
  { id: "calendar.parse", minTier: "T1", description: "Free-text time parsing" },
  { id: "calendar.plan", minTier: "T2", description: "Multi-party reshuffle proposal" },
  { id: "travel.match", minTier: "T2", description: "Preference matching + candidate ranking" },
  { id: "travel.plan.multi", minTier: "T3", description: "Multi-leg / multi-traveler planning" },
  { id: "household.vendor.select", minTier: "T2", description: "New vendor selection with rationale" },
  { id: "family.coverage_plan", minTier: "T2", description: "Coverage planning during travel" },
  { id: "admin.renewal.detect", minTier: "T1", description: "Renewal detection and drafting" },
  { id: "procurement.compare", minTier: "T2", description: "Quote comparison narrative" },
  { id: "research.structured", minTier: "T2", description: "Structured research with defined sources" },
  { id: "research.open", minTier: "T3", description: "Open-ended research" },
  { id: "documents.classify", minTier: "T1", description: "Document classification, field extraction" },
  { id: "documents.summarize", minTier: "T2", description: "Contract-level summarization" },
  {
    id: "orchestrator.simple",
    minTier: "T2",
    description: "Simple single-domain intent decomposition",
  },
  {
    id: "orchestrator.cross_domain",
    minTier: "T3",
    description: "Cross-domain planning DAG",
  },
];

export class ModelRegistry {
  private readonly models: Map<string, ModelSpec>;
  private readonly taskClasses: Map<string, TaskClassSpec>;

  constructor(
    models: readonly ModelSpec[] = BUILTIN_MODELS,
    taskClasses: readonly TaskClassSpec[] = BUILTIN_TASK_CLASSES,
  ) {
    this.models = new Map(models.map((m) => [m.id, m] as const));
    this.taskClasses = new Map(taskClasses.map((t) => [t.id, t] as const));
  }

  listModels(): ModelSpec[] {
    return Array.from(this.models.values());
  }

  listTaskClasses(): TaskClassSpec[] {
    return Array.from(this.taskClasses.values());
  }

  getModel(id: string): ModelSpec | null {
    return this.models.get(id) ?? null;
  }

  getTaskClass(id: string): TaskClassSpec | null {
    return this.taskClasses.get(id) ?? null;
  }

  modelsForTier(tier: TierId): ModelSpec[] {
    return this.listModels().filter((m) => m.tier === tier && m.status === "available");
  }

  modelsWithCapabilities(caps: readonly ModelCapability[]): ModelSpec[] {
    return this.listModels().filter(
      (m) =>
        m.status === "available" &&
        caps.every((c) => m.capabilities.includes(c)),
    );
  }
}
