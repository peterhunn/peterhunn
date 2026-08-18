import type { ModelCapability, ModelSpec, TaskClassSpec, TierId } from "@atelier/domain";

// Model registry — the single source of truth listing every model the
// router may pick. Rows are code today; a config-driven variant with
// eval provenance is a later addition.

export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: "self.llama-3.1-8b",
    provider: "self_hosted",
    displayName: "Llama 3.1 8B (self-hosted)",
    tier: "T1",
    hosting: "self_hosted",
    contextTokens: 32_000,
    capabilities: ["function_calling", "json_mode", "streaming"],
    costPer1kInputUsd: 0.0002,
    costPer1kOutputUsd: 0.0004,
    latencyP50Ms: 200,
    latencyP95Ms: 800,
    status: "available",
    limitations: ["weak on multi-step math"],
  },
  {
    id: "self.qwen-2.5-32b",
    provider: "self_hosted",
    displayName: "Qwen 2.5 32B (self-hosted)",
    tier: "T2",
    hosting: "self_hosted",
    contextTokens: 32_000,
    capabilities: ["function_calling", "json_mode", "streaming", "long_context"],
    costPer1kInputUsd: 0.001,
    costPer1kOutputUsd: 0.002,
    latencyP50Ms: 700,
    latencyP95Ms: 2500,
    status: "available",
    limitations: [],
  },
  {
    id: "provider.mid",
    provider: "provider_mid",
    displayName: "Provider Mid",
    tier: "T2",
    hosting: "provider_api",
    contextTokens: 128_000,
    capabilities: ["function_calling", "json_mode", "streaming", "long_context"],
    costPer1kInputUsd: 0.003,
    costPer1kOutputUsd: 0.006,
    latencyP50Ms: 600,
    latencyP95Ms: 2000,
    status: "available",
    limitations: [],
  },
  {
    id: "provider.frontier",
    provider: "provider_frontier",
    displayName: "Provider Frontier",
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
    latencyP50Ms: 1200,
    latencyP95Ms: 5000,
    status: "available",
    limitations: [],
  },
];

// Task class registry — per-agent-task minimum tier.
// See ../life-management/models.md §"Agent-to-tier baseline".
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
