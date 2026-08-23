import { createHash } from "node:crypto";
import type {
  Agent,
  AgentContext,
  AgentGraphWriter,
  AgentToolResult,
  GraphView,
  Intent,
  OrchestratorRunResult,
} from "./types.js";
import {
  materializeIntent,
  parsePlan,
  pickPlannerTaskClass,
  plannerSystemPrompt,
  type Plan,
} from "./planner.js";
import type { ToolRegistry } from "./tool-registry.js";
import type {
  ActionOutcome,
  ActionRequest,
  ActorType,
  HouseholdId,
  ModelCall,
  ModelResponse,
  ModelToolCall,
  PolicyDecision,
  PolicyId,
  SideEffectClass,
  Domain,
} from "@atelier/domain";

// The orchestrator's storage seam. Real implementations bind these to
// the DB repositories; tests pass in-memory stand-ins. Keeping the
// contract narrow lets us evolve storage without touching the runtime.
export interface TaskLedger {
  startRun(input: {
    householdId: HouseholdId;
    intentKind: string;
    intentAttrs: Record<string, unknown>;
    origin: "customer" | "manager" | "proactive" | "system";
    originBy: string;
  }): { id: string };

  finishRun(id: string, state: "completed" | "failed" | "partial"): void;

  createTask(input: {
    runId: string;
    householdId: HouseholdId;
    agent: string;
    agentVersion: string;
    kind: string;
    inputs: Record<string, unknown>;
  }): { id: string };

  updateTask(
    id: string,
    input: {
      state: string;
      outputs?: Record<string, unknown>;
      decisionSummary?: string;
      errorMessage?: string;
    },
  ): void;

  listTasksForRun(runId: string): Array<{
    id: string;
    agent: string;
    kind: string;
    state: string;
    decisionSummary?: string | null;
    outputs?: unknown;
    errorMessage?: string | null;
  }>;
}

export interface PolicyRuntime {
  evaluate(householdId: HouseholdId, request: ActionRequest): PolicyDecision;
}

export interface ActionRecorder {
  record(input: {
    householdId: HouseholdId;
    subjectPrincipalId?: string;
    agent: string;
    agentVersion: string;
    tool: string;
    toolVersion: string;
    actionClass: string;
    domain: Domain;
    inputsHash: string;
    outputsHash?: string;
    amountUsd?: number;
    policyIdAuthorizing?: PolicyId;
    outcome: ActionOutcome;
    summary: string;
  }): { id: string };
}

export interface CredentialSource {
  read(householdId: HouseholdId, provider: string): {
    id: string;
    credential: Record<string, unknown>;
    expiresAt: string | null;
  } | null;
  updateAccessToken?(credentialId: string, accessToken: string, expiresAt: string): void;
}

export interface ApprovalSink {
  enqueue(input: {
    householdId: HouseholdId;
    runId: string;
    taskId: string;
    kind: "manager_review" | "customer_approval";
    approverType: "principal" | "manager";
    approverId?: string;
    domain: string;
    actionClass: string;
    toolName: string;
    toolVersion: string;
    toolInputs: Record<string, unknown>;
    proposedAttrs: Record<string, unknown>;
    subjectPrincipalId?: string;
    amountUsd?: number;
    summary: string;
    authorityPolicyId?: PolicyId;
    proposedBy: { agent: string; agentVersion: string };
    reasons: readonly string[];
  }): { id: string };
}

export interface ModelRuntime {
  callModel(
    householdId: HouseholdId,
    runId: string,
    taskId: string,
    call: ModelCall,
  ): Promise<ModelResponse>;
  callModelWithTools(
    householdId: HouseholdId,
    runId: string,
    taskId: string,
    call: ModelCall,
    opts: {
      handleToolUse: (input: {
        toolCallId: string;
        name: string;
        input: Record<string, unknown>;
      }) => Promise<Record<string, unknown> | string>;
      maxTurns?: number;
    },
  ): Promise<{
    finalContent: string;
    finalToolCalls: readonly ModelToolCall[];
    turns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedInputTokens: number;
    totalCostUsdEstimated: number;
  }>;
}

export interface OrchestratorDeps {
  readonly agents: readonly Agent[];
  readonly tools: ToolRegistry;
  readonly ledger: TaskLedger;
  readonly policy: PolicyRuntime;
  readonly actions: ActionRecorder;
  readonly approvals: ApprovalSink;
  readonly models: ModelRuntime;
  readonly credentials?: CredentialSource;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface RunOptions {
  readonly householdId: HouseholdId;
  readonly actor: { type: ActorType; id: string; displayName: string };
  readonly graph: GraphView;
  readonly writer: AgentGraphWriter;
  readonly intent: Intent;
}

export interface PlanAndRunOptions {
  readonly householdId: HouseholdId;
  readonly actor: { type: ActorType; id: string; displayName: string };
  readonly graph: GraphView;
  readonly writer: AgentGraphWriter;
  readonly prompt: string;
  readonly origin: Intent["origin"];
}

export interface PlanAndRunResult {
  readonly plan: Plan;
  readonly plannerTaskClass: string;
  readonly runs: readonly OrchestratorRunResult[];
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async planAndRun(opts: PlanAndRunOptions): Promise<PlanAndRunResult> {
    const { householdId, actor, graph, writer, prompt, origin } = opts;
    const logger = this.deps.logger ?? { info: () => {} };

    const plannerRun = this.deps.ledger.startRun({
      householdId,
      intentKind: "orchestrator.plan",
      intentAttrs: { prompt },
      origin: origin.source,
      originBy: origin.by,
    });
    const plannerTask = this.deps.ledger.createTask({
      runId: plannerRun.id,
      householdId,
      agent: "orchestrator",
      agentVersion: "0.1.0",
      kind: "orchestrator.plan",
      inputs: { prompt },
    });

    const plannerTaskClass = pickPlannerTaskClass(prompt);
    let plan: Plan;
    try {
      const modelResponse = await this.deps.models.callModel(
        householdId,
        plannerRun.id,
        plannerTask.id,
        {
          taskClass: plannerTaskClass,
          messages: [
            // Mark the planner's system prompt for caching — it is the
            // stable prefix across every planner call for every
            // household. Anthropic honors this via cache_control;
            // OpenAI's automatic prefix caching benefits regardless;
            // other providers ignore the marker.
            { role: "system", content: plannerSystemPrompt(), cache: true },
            { role: "user", content: prompt },
          ],
          maxOutputTokens: 800,
        },
      );
      plan = parsePlan(modelResponse.content);
      this.deps.ledger.updateTask(plannerTask.id, {
        state: "completed",
        decisionSummary: `Planned ${plan.intents.length} intent${
          plan.intents.length === 1 ? "" : "s"
        } via ${plannerTaskClass}`,
        outputs: { plan, modelId: modelResponse.modelId, tier: modelResponse.tier },
      });
      this.deps.ledger.finishRun(plannerRun.id, "completed");
    } catch (err) {
      const message = (err as Error).message;
      logger.info("planner failed", { message });
      this.deps.ledger.updateTask(plannerTask.id, {
        state: "failed",
        errorMessage: message,
      });
      this.deps.ledger.finishRun(plannerRun.id, "failed");
      return {
        plan: { reasoning: message, intents: [] },
        plannerTaskClass,
        runs: [],
      };
    }

    const runs: OrchestratorRunResult[] = [];
    for (const item of plan.intents) {
      const intent = materializeIntent(item, origin);
      const result = await this.run({ householdId, actor, graph, writer, intent });
      runs.push(result);
    }
    return { plan, plannerTaskClass, runs };
  }

  async run(opts: RunOptions): Promise<OrchestratorRunResult> {
    const { intent, householdId, graph, writer, actor } = opts;
    const logger = this.deps.logger ?? { info: () => {} };

    const run = this.deps.ledger.startRun({
      householdId,
      intentKind: intent.kind,
      intentAttrs: intent.attrs,
      origin: intent.origin.source,
      originBy: intent.origin.by,
    });

    const matched = this.deps.agents.filter((a) => a.handles(intent));

    if (matched.length === 0) {
      this.deps.ledger.finishRun(run.id, "failed");
      return {
        runId: run.id,
        intentKind: intent.kind,
        state: "failed",
        tasks: [
          {
            id: `${run.id}:no_agent`,
            agent: "orchestrator",
            kind: intent.kind,
            state: "failed",
            errorMessage: `No agent handles intent ${intent.kind}`,
          },
        ],
      };
    }

    let anyFailure = false;
    let anySuccess = false;

    for (const agent of matched) {
      const task = this.deps.ledger.createTask({
        runId: run.id,
        householdId,
        agent: agent.name,
        agentVersion: agent.version,
        kind: intent.kind,
        inputs: intent.attrs,
      });

      this.deps.ledger.updateTask(task.id, { state: "executing" });

      const ctx: AgentContext = {
        householdId,
        actor,
        graph,
        writer,
        readCredential: (provider) =>
          this.deps.credentials?.read(householdId, provider) ?? null,
        evaluatePolicy: (req) =>
          this.deps.policy.evaluate(householdId, req as ActionRequest),
        invokeTool: <I, O>(
          toolName: string,
          inputs: I,
          request: {
            subjectPrincipalId?: string;
            amountUsd?: number;
            summary: string;
            attrs?: Record<string, unknown>;
          },
        ): Promise<AgentToolResult<O>> =>
          this.callTool<I, O>({
            householdId,
            runId: run.id,
            taskId: task.id,
            agent,
            toolName,
            inputs,
            request,
            subject: intent.subjectPrincipalId,
          }),
        callModel: (call) =>
          this.deps.models.callModel(householdId, run.id, task.id, call),
        callModelWithTools: (call, opts) => {
          const withTools: ModelCall = {
            ...call,
            tools: [...opts.tools],
            ...(opts.toolChoice !== undefined && { toolChoice: opts.toolChoice }),
          };
          return this.deps.models.callModelWithTools(
            householdId,
            run.id,
            task.id,
            withTools,
            {
              handleToolUse: opts.handleToolUse,
              ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
            },
          );
        },
        logger,
      };

      try {
        const output = await agent.handle(intent, ctx);
        this.deps.ledger.updateTask(task.id, {
          state: output.state,
          ...(output.decisionSummary !== undefined && {
            decisionSummary: output.decisionSummary,
          }),
          ...(output.outputs !== undefined && { outputs: output.outputs }),
          ...(output.errorMessage !== undefined && { errorMessage: output.errorMessage }),
        });
        if (output.state === "completed") anySuccess = true;
        if (output.state === "failed" || output.state === "rejected") anyFailure = true;
      } catch (err) {
        const message = (err as Error).message;
        this.deps.ledger.updateTask(task.id, { state: "failed", errorMessage: message });
        anyFailure = true;
        logger.info("agent threw", { agent: agent.name, message });
      }
    }

    const finalState: "completed" | "failed" | "partial" = anyFailure
      ? anySuccess
        ? "partial"
        : "failed"
      : "completed";
    this.deps.ledger.finishRun(run.id, finalState);

    const tasks = this.deps.ledger.listTasksForRun(run.id).map((t) => ({
      id: t.id,
      agent: t.agent,
      kind: t.kind,
      state: t.state,
      ...(t.decisionSummary != null && { decisionSummary: t.decisionSummary }),
      ...(t.outputs != null && { outputs: t.outputs as Record<string, unknown> }),
      ...(t.errorMessage != null && { errorMessage: t.errorMessage }),
    }));

    return { runId: run.id, intentKind: intent.kind, state: finalState, tasks };
  }

  private async callTool<I, O>(input: {
    householdId: HouseholdId;
    runId: string;
    taskId: string;
    agent: Agent;
    toolName: string;
    inputs: I;
    request: {
      subjectPrincipalId?: string;
      amountUsd?: number;
      summary: string;
      attrs?: Record<string, unknown>;
    };
    subject: string;
  }): Promise<AgentToolResult<O>> {
    const tool = this.deps.tools.get(input.toolName) as unknown as {
      name: string;
      version: string;
      sideEffectClass: SideEffectClass;
      domain: string;
      actionClass: string;
      invoke: (ctx: unknown, invocation: unknown) => Promise<{
        outputs: O;
        outcome: ActionOutcome;
        summary: string;
        amountUsd?: number;
      }>;
    };

    const actionRequest: ActionRequest = {
      subjectPrincipalId: input.request.subjectPrincipalId ?? input.subject,
      domain: tool.domain as Domain,
      actionClass: tool.actionClass,
      sideEffectClass: tool.sideEffectClass,
      attrs: input.request.attrs ?? {},
      ...(input.request.amountUsd !== undefined && { amountUsd: input.request.amountUsd }),
      proposedBy: { actor: input.agent.name, version: input.agent.version },
    };

    const decision = this.deps.policy.evaluate(input.householdId, actionRequest);

    if (decision.decision === "manager_review" || decision.decision === "customer_approval") {
      const approver = decision.approver ?? { type: "manager" as const };
      const enqueued = this.deps.approvals.enqueue({
        householdId: input.householdId,
        runId: input.runId,
        taskId: input.taskId,
        kind: decision.decision,
        approverType: approver.type,
        ...(approver.type === "principal" && { approverId: approver.id }),
        domain: tool.domain,
        actionClass: tool.actionClass,
        toolName: tool.name,
        toolVersion: tool.version,
        toolInputs: input.inputs as Record<string, unknown>,
        proposedAttrs: input.request.attrs ?? {},
        ...(input.request.subjectPrincipalId !== undefined && {
          subjectPrincipalId: input.request.subjectPrincipalId,
        }),
        ...(input.request.amountUsd !== undefined && { amountUsd: input.request.amountUsd }),
        summary: input.request.summary,
        ...(decision.authorityId !== undefined && { authorityPolicyId: decision.authorityId }),
        proposedBy: { agent: input.agent.name, agentVersion: input.agent.version },
        reasons: decision.reasons,
      });
      return { decision, action: null, outputs: null, approvalId: enqueued.id };
    }

    if (decision.decision !== "auto_execute") {
      return { decision, action: null, outputs: null, approvalId: null };
    }

    const inputsHash = hash(input.inputs);

    const invocation = await tool.invoke(
      {
        householdId: input.householdId,
        authorityId: decision.authorityId,
        proposedBy: { actor: input.agent.name, version: input.agent.version },
        readCredential: (provider: string) =>
          this.deps.credentials?.read(input.householdId, provider) ?? null,
        ...(this.deps.credentials?.updateAccessToken && {
          persistAccessToken: this.deps.credentials.updateAccessToken.bind(this.deps.credentials),
        }),
        logger: this.deps.logger,
      },
      { inputs: input.inputs, amountUsd: input.request.amountUsd, summary: input.request.summary },
    );

    const record = this.deps.actions.record({
      householdId: input.householdId,
      ...(input.request.subjectPrincipalId !== undefined && {
        subjectPrincipalId: input.request.subjectPrincipalId,
      }),
      agent: input.agent.name,
      agentVersion: input.agent.version,
      tool: tool.name,
      toolVersion: tool.version,
      actionClass: tool.actionClass,
      domain: tool.domain as Domain,
      inputsHash,
      outputsHash: hash(invocation.outputs),
      ...(invocation.amountUsd !== undefined && { amountUsd: invocation.amountUsd }),
      ...(decision.authorityId !== undefined && { policyIdAuthorizing: decision.authorityId }),
      outcome: invocation.outcome,
      summary: invocation.summary,
    });

    return {
      decision,
      action: {
        id: record.id,
        outcome: invocation.outcome,
        summary: invocation.summary,
      },
      outputs: invocation.outputs,
      approvalId: null,
    };
  }
}

const hash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);
