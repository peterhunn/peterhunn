"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  adoptPolicySuggestion,
  dismissPolicySuggestion,
} from "./actions";
import type { HouseholdId } from "@atelier/domain";

// A promotion suggestion — 5+ clean approvals of the same pattern
// in the window, no existing execute policy, not dismissed.
export interface PromoteSuggestion {
  kind: "promote";
  actionClass: string;
  domain: string;
  subjectPrincipalId: string | null;
  nApprovals: number;
  windowDays: number;
  currentRung: string;
  suggestedRung: "execute";
  basisPolicyLabel: string;
  basisApprovalIds: string[];
}

// A demotion suggestion — an execute policy's escalated approvals
// keep getting overridden by the manager. Suggests dropping back
// to draft. Adopting revokes the offending execute policy.
export interface DemoteSuggestion {
  kind: "demote";
  actionClass: string;
  domain: string;
  subjectPrincipalId: string | null;
  nProblems: number;
  windowDays: number;
  currentRung: "execute" | "manage_autonomously";
  suggestedRung: "draft";
  basisPolicyLabel: string;
  basisApprovalIds: string[];
  summary: string;
}

export type Suggestion = PromoteSuggestion | DemoteSuggestion;

const keyOf = (s: Suggestion) =>
  `${s.kind}::${s.actionClass}::${s.subjectPrincipalId ?? "_any"}`;

export function PolicySuggestionsPanel({
  householdId,
  suggestions,
}: {
  householdId: HouseholdId;
  suggestions: Suggestion[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  if (suggestions.length === 0) return null;

  const runAction = async (
    k: string,
    fn: () => Promise<{ message: string }>,
  ) => {
    setBusyKey(k);
    startTransition(async () => {
      const res = await fn();
      setMessages((m) => ({ ...m, [k]: res.message }));
      setBusyKey(null);
      router.refresh();
    });
  };

  const promotions = suggestions.filter(
    (s): s is PromoteSuggestion => s.kind === "promote",
  );
  const demotions = suggestions.filter(
    (s): s is DemoteSuggestion => s.kind === "demote",
  );

  return (
    <div className="suggestions-panel">
      <div className="section-head">
        <h2>Autonomy ladder</h2>
        <span className="mono">
          {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
        </span>
      </div>

      {promotions.length > 0 ? (
        <>
          <h3>Ready to promote</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            These patterns have been approved cleanly with no rejections in
            the window. Promoting raises autonomy to{" "}
            <span className="mono">execute</span>; escalation conditions carry
            over so sensitive slices still route through approval.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Subject</th>
                <th>Basis policy</th>
                <th>From → to</th>
                <th>Approvals</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((s) => {
                const k = keyOf(s);
                const msg = messages[k];
                return (
                  <tr key={k}>
                    <td className="mono">
                      {s.domain}::{s.actionClass}
                    </td>
                    <td className="mono">{s.subjectPrincipalId ?? "any"}</td>
                    <td>{s.basisPolicyLabel}</td>
                    <td>
                      <span className="tag">{s.currentRung}</span> →{" "}
                      <span className="tag confirmed">{s.suggestedRung}</span>
                    </td>
                    <td className="mono">
                      {s.nApprovals} in {s.windowDays}d
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={isPending && busyKey === k}
                        onClick={() =>
                          runAction(k, () =>
                            adoptPolicySuggestion(householdId, {
                              actionClass: s.actionClass,
                              subjectPrincipalId: s.subjectPrincipalId,
                              kind: "promote",
                            }),
                          )
                        }
                      >
                        {isPending && busyKey === k ? "Working…" : "Promote"}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ marginLeft: 8 }}
                        disabled={isPending && busyKey === k}
                        onClick={() =>
                          runAction(k, () =>
                            dismissPolicySuggestion(householdId, {
                              actionClass: s.actionClass,
                              subjectPrincipalId: s.subjectPrincipalId,
                            }),
                          )
                        }
                      >
                        Dismiss
                      </button>
                      {msg ? (
                        <div className="mono muted" style={{ marginTop: 4 }}>
                          {msg}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}

      {demotions.length > 0 ? (
        <>
          <h3 style={{ marginTop: promotions.length > 0 ? 24 : 0 }}>
            Consider demoting
          </h3>
          <p className="muted" style={{ marginTop: 0 }}>
            These execute policies are producing manager overrides —
            rejections or edits on the escalated slice. Demoting reverts to{" "}
            <span className="mono">draft</span> so every action goes through
            you again, and the misconfigured execute policy is revoked.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Subject</th>
                <th>Basis policy</th>
                <th>From → to</th>
                <th>Signal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {demotions.map((s) => {
                const k = keyOf(s);
                const msg = messages[k];
                return (
                  <tr key={k}>
                    <td className="mono">
                      {s.domain}::{s.actionClass}
                    </td>
                    <td className="mono">{s.subjectPrincipalId ?? "any"}</td>
                    <td>{s.basisPolicyLabel}</td>
                    <td>
                      <span className="tag confirmed">{s.currentRung}</span> →{" "}
                      <span className="tag">{s.suggestedRung}</span>
                    </td>
                    <td className="mono">{s.summary}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={isPending && busyKey === k}
                        onClick={() =>
                          runAction(k, () =>
                            adoptPolicySuggestion(householdId, {
                              actionClass: s.actionClass,
                              subjectPrincipalId: s.subjectPrincipalId,
                              kind: "demote",
                            }),
                          )
                        }
                      >
                        {isPending && busyKey === k ? "Working…" : "Demote"}
                      </button>
                      {msg ? (
                        <div className="mono muted" style={{ marginTop: 4 }}>
                          {msg}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
