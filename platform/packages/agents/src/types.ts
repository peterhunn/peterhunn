import { z } from "zod";
import {
  ActionRequest,
  type ActionOutcome,
  type ActorType,
  type HouseholdId,
  type ModelCall,
  type ModelResponse,
  type ModelToolCall,
  type PolicyDecision,
  type SideEffectClass,
  type ToolDefinition,
} from "@atelier/domain";

// ─── Intents ───────────────────────────────────────────────────────

// Intents are the orchestrator's input. In production they may come
// from a parsed customer message, a proactive scan of the graph, or a
// manager-initiated task. Kept structured for phase 0 — an LLM intent
// parser is a later addition.
export const IntentOrigin = z.object({
  source: z.enum(["customer", "manager", "proactive", "system"]),
  by: z.string(),
});

export const Intent = z.object({
  kind: z.string(),
  attrs: z.record(z.unknown()).default({}),
  subjectPrincipalId: z.string().default("any_principal"),
  origin: IntentOrigin,
});
export type Intent = z.infer<typeof Intent>;

// ─── Tools ─────────────────────────────────────────────────────────

// A tool is the only path from the agent world to any side effect
// outside the graph. Every tool declares its side_effect_class so the
// policy engine can decide authority, and the runtime records an
// action ledger row on every invocation.
export interface StoredCredential {
  readonly id: string;
  readonly credential: Record<string, unknown>;
  readonly expiresAt: string | null;
}

export interface ToolContext {
  readonly householdId: HouseholdId;
  readonly authorityId: string | undefined;
  readonly proposedBy: { actor: string; version: string };
  // Look up a delegated credential the platform holds for this
  // household — OAuth tokens, API keys, etc. Returns null when the
  // household has not connected the provider (mock fallback territory).
  readonly readCredential: (provider: string) => StoredCredential | null;
  // Persist a refreshed OAuth access token back to the credentials
  // store. Called by shared adapter helpers after a successful
  // OAuth refresh so subsequent calls don't re-refresh. Optional so
  // test contexts can leave it undefined.
  readonly persistAccessToken?: (
    credentialId: string,
    accessToken: string,
    expiresAt: string,
  ) => void;
  // Send an SMS / WhatsApp on the concierge line (or the
  // household's own DID). Runtime-supplied: applies the outbound
  // consent gate, records a messaging_events row, auto-attaches
  // to the recipient's open conversation session. Agents call
  // this instead of talking to the Twilio adapter directly, so
  // agent-authored and manager-authored sends land through the
  // same code path. Optional so test contexts and non-messaging
  // agents can leave it undefined.
  readonly sendChannelMessage?: (input: {
    readonly channel: "sms" | "whatsapp";
    readonly to: string;
    readonly body: string;
  }) => Promise<{
    readonly provider: "twilio" | "mock";
    readonly externalMessageId: string;
    readonly from: string;
    readonly to: string;
    readonly eventId: string;
    readonly status?: string;
    readonly reason?: string;
    readonly refusedFor?: "opted_out" | "agent_sending_disabled";
  }>;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface ToolInvocation<I, O> {
  readonly inputs: I;
  readonly amountUsd?: number;
  readonly summary: string;
}

export interface ToolResult<O> {
  readonly outputs: O;
  readonly outcome: ActionOutcome;
  readonly summary: string;
  readonly amountUsd?: number;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly version: string;
  readonly sideEffectClass: SideEffectClass;
  readonly domain: string;
  readonly actionClass: string;
  invoke(ctx: ToolContext, invocation: ToolInvocation<I, O>): Promise<ToolResult<O>>;
}

// ─── Agents ────────────────────────────────────────────────────────

// The context handed to each agent invocation. Agents read the graph,
// call the policy engine, invoke tools, and write results. They do
// not decide their own authority and cannot bypass the policy check.
export interface AgentModelToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface AgentModelToolLoopResult {
  readonly finalContent: string;
  readonly finalToolCalls: readonly ModelToolCall[];
  readonly turns: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCostUsdEstimated: number;
}

export interface AgentCallModelWithTools {
  (
    call: ModelCall,
    opts: {
      tools: readonly ToolDefinition[];
      handleToolUse: (
        call: AgentModelToolCall,
      ) => Promise<Record<string, unknown> | string>;
      toolChoice?: "auto" | "any" | { readonly name: string };
      maxTurns?: number;
    },
  ): Promise<AgentModelToolLoopResult>;
}

export interface AgentContext {
  readonly householdId: HouseholdId;
  readonly actor: { type: ActorType; id: string; displayName: string };
  readonly graph: GraphView;
  readonly writer: AgentGraphWriter;
  readonly evaluatePolicy: (req: unknown) => PolicyDecision;
  // Agents may read delegated credentials directly for read-only
  // integrations (e.g. calendar.list to detect conflicts). Side-
  // effecting integrations go through invokeTool + the policy engine.
  readonly readCredential: (provider: string) => StoredCredential | null;
  readonly invokeTool: <I, O>(
    toolName: string,
    inputs: I,
    request: {
      subjectPrincipalId?: string;
      amountUsd?: number;
      summary: string;
      attrs?: Record<string, unknown>;
    },
  ) => Promise<AgentToolResult<O>>;
  readonly callModel: (call: ModelCall) => Promise<ModelResponse>;
  readonly callModelWithTools: AgentCallModelWithTools;
  readonly logger: { info: (msg: string, ctx?: unknown) => void };
}

export interface GraphView {
  listNodes(opts?: { type?: string }): Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
}

// Agents write factual state back through this seam. The runtime fills
// in provenance (source, assertedBy, assertedAt); the agent chooses
// only type + data + confidence + status. Nodes written this way are
// `candidate` unless the agent explicitly promotes them to `confirmed`
// on the back of a successful action outcome (see the promotion rules
// in docs/22-knowledge-graph.md §"Learning").
export interface AgentGraphWriter {
  writeNode(input: {
    type: string;
    data: Record<string, unknown>;
    status?: "candidate" | "confirmed";
    confidence?: number;
    sourceRef?: string;
  }): { id: string };

  supersedeNode(nodeId: string, replacementId?: string): void;
}

export interface AgentToolResult<O> {
  readonly decision: PolicyDecision;
  readonly action: { id: string; outcome: ActionOutcome; summary: string } | null;
  readonly outputs: O | null;
  readonly approvalId: string | null;
}

export type AgentTaskState =
  | "received"
  | "planning"
  | "executing"
  | "proposing_action"
  | "escalated"
  | "completed"
  | "rejected"
  | "failed"
  | "shelved";

export interface AgentTaskOutput {
  readonly state: AgentTaskState;
  readonly decisionSummary?: string;
  readonly outputs?: Record<string, unknown>;
  readonly errorMessage?: string;
}

export interface Agent {
  readonly name: string;
  readonly version: string;
  handles(intent: Intent): boolean;
  handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput>;
}

// ─── Orchestrator surface ──────────────────────────────────────────

export const OrchestratorRunResult = z.object({
  runId: z.string(),
  intentKind: z.string(),
  state: z.enum(["running", "completed", "failed", "partial"]),
  tasks: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      kind: z.string(),
      state: z.string(),
      decisionSummary: z.string().optional(),
      outputs: z.record(z.unknown()).optional(),
      errorMessage: z.string().optional(),
    }),
  ),
});
export type OrchestratorRunResult = z.infer<typeof OrchestratorRunResult>;

export { ActionRequest };
