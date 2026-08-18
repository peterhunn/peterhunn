import { z } from "zod";
import {
  ActionRequest,
  type ActionOutcome,
  type ActorType,
  type HouseholdId,
  type PolicyDecision,
  type SideEffectClass,
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
export interface ToolContext {
  readonly householdId: HouseholdId;
  readonly authorityId: string | undefined;
  readonly proposedBy: { actor: string; version: string };
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
export interface AgentContext {
  readonly householdId: HouseholdId;
  readonly actor: { type: ActorType; id: string; displayName: string };
  readonly graph: GraphView;
  readonly evaluatePolicy: (req: unknown) => PolicyDecision;
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
  readonly logger: { info: (msg: string, ctx?: unknown) => void };
}

export interface GraphView {
  listNodes(opts?: { type?: string }): Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
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
