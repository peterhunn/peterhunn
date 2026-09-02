"use client";

import { useState, useTransition } from "react";
import type { HouseholdId } from "@atelier/domain";
import { fetchRunDetail, fetchTaskModelCalls } from "./actions";

interface ModelCallView {
  id: string;
  createdAt: string;
  modelId: string;
  selectedTier: string;
  taskClass: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsdEstimated: number;
  latencyMs: number;
  routerReasons: string[];
  summary: string;
}

interface TimelineEvent {
  at: string;
  kind: "run" | "task" | "model_call" | "action";
  summary: string;
}

// Two-button footer for task cards. "Trace" loads and expands the
// model calls that fired inside this task. "Run timeline" loads
// the whole orchestrator run's chronological event list.
export function TaskObservability({
  householdId,
  taskId,
  runId,
}: {
  householdId: HouseholdId;
  taskId: string;
  runId: string;
}) {
  const [trace, setTrace] = useState<{
    calls: ModelCallView[];
    summary: {
      totalCalls: number;
      totalUsd: number;
      totalTokensIn: number;
      totalTokensOut: number;
      totalCachedInputTokens: number;
    };
  } | null>(null);
  const [timeline, setTimeline] = useState<{
    events: TimelineEvent[];
    summary: {
      taskCount: number;
      modelCallCount: number;
      actionCount: number;
      totalUsd: number;
    };
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="task-obs">
      <div className="task-obs-actions">
        <button
          type="button"
          className="link-btn"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              const res = await fetchTaskModelCalls(householdId, taskId);
              if (!res.ok) {
                setMessage(res.message);
                return;
              }
              setTrace(trace ? null : { calls: res.calls, summary: res.summary });
            })
          }
        >
          {trace ? "Hide trace" : "Model trace"}
        </button>
        <button
          type="button"
          className="link-btn"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              const res = await fetchRunDetail(householdId, runId);
              if (!res.ok) {
                setMessage(res.message);
                return;
              }
              setTimeline(
                timeline
                  ? null
                  : { events: res.timeline, summary: res.summary },
              );
            })
          }
        >
          {timeline ? "Hide run timeline" : "Run timeline"}
        </button>
        {message ? <span className="mono muted">{message}</span> : null}
      </div>

      {trace ? (
        <div className="task-obs-panel">
          <div className="task-obs-summary">
            <strong>Trace</strong>
            <span className="mono">
              {trace.summary.totalCalls} calls · $
              {trace.summary.totalUsd.toFixed(4)} ·{" "}
              {trace.summary.totalTokensIn}+{trace.summary.totalTokensOut}t
              {trace.summary.totalCachedInputTokens > 0
                ? ` · cache ${trace.summary.totalCachedInputTokens}`
                : ""}
            </span>
          </div>
          {trace.calls.length === 0 ? (
            <p className="muted">No model calls recorded for this task.</p>
          ) : (
            <ol className="trace-list">
              {trace.calls.map((c) => (
                <li key={c.id} className="trace-item">
                  <div className="trace-line">
                    <span className={`tag tag-tier-${c.selectedTier}`}>
                      {c.selectedTier}
                    </span>
                    <span className="mono">{c.taskClass}</span>
                    <span className="muted">{c.modelId}</span>
                    <span className="mono">
                      ${c.costUsdEstimated.toFixed(4)}
                    </span>
                    <span className="mono muted">{c.latencyMs}ms</span>
                  </div>
                  <div className="trace-tokens">
                    <span className="mono muted">
                      {c.inputTokens}+{c.outputTokens}t
                      {c.cachedInputTokens > 0
                        ? ` · cache ${c.cachedInputTokens}`
                        : ""}
                    </span>
                    {c.routerReasons.length > 0 ? (
                      <span className="mono muted">
                        · {c.routerReasons.join(" · ")}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}

      {timeline ? (
        <div className="task-obs-panel">
          <div className="task-obs-summary">
            <strong>Run timeline</strong>
            <span className="mono">
              {timeline.summary.taskCount} task
              {timeline.summary.taskCount === 1 ? "" : "s"} ·{" "}
              {timeline.summary.modelCallCount} calls ·{" "}
              {timeline.summary.actionCount} actions · $
              {timeline.summary.totalUsd.toFixed(4)}
            </span>
          </div>
          <ol className="timeline-list">
            {timeline.events.map((e, i) => (
              <li key={i} className={`timeline-item kind-${e.kind}`}>
                <span className="mono muted timeline-time">
                  {new Date(e.at).toLocaleTimeString()}
                </span>
                <span className={`tag tag-kind-${e.kind}`}>{e.kind}</span>
                <span className="timeline-summary">{e.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
