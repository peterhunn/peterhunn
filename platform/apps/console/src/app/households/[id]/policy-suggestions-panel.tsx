"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adoptPolicySuggestion } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// One promotion suggestion — either a single-subject pattern
// ("message.send / Alex") or a household-wide pattern (subject null).
export interface Suggestion {
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

  const keyOf = (s: Suggestion) =>
    `${s.actionClass}::${s.subjectPrincipalId ?? "_any"}`;

  const adopt = (s: Suggestion) => {
    const k = keyOf(s);
    setBusyKey(k);
    startTransition(async () => {
      const res = await adoptPolicySuggestion(householdId, {
        actionClass: s.actionClass,
        subjectPrincipalId: s.subjectPrincipalId,
      });
      setMessages((m) => ({ ...m, [k]: res.message }));
      setBusyKey(null);
      // Refresh so the promoted policy shows up in the Policies
      // list below, and the suggestion drops away.
      router.refresh();
    });
  };

  return (
    <div className="suggestions-panel">
      <div className="section-head">
        <h2>Autonomy ladder — promotion suggestions</h2>
        <span className="mono">
          {suggestions.length} pattern{suggestions.length === 1 ? "" : "s"}{" "}
          ready
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        These patterns have been approved cleanly {suggestions[0]?.nApprovals}+
        times in a row with no rejections. Promoting raises the underlying
        policy's autonomy to <span className="mono">execute</span>; escalation
        conditions carry over, so sensitive slices still go through approval.
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
          {suggestions.map((s) => {
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
                    onClick={() => adopt(s)}
                  >
                    {isPending && busyKey === k ? "Promoting…" : "Promote"}
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
    </div>
  );
}
