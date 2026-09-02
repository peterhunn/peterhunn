"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enablePlaybook } from "./actions";
import type { HouseholdId } from "@atelier/domain";

export interface PlaybookSuggestion {
  playbookId: string;
  name: string;
  description: string;
  domain: string;
  reason: string;
  signal: { count: number; threshold: number; unit: string };
}

export function PlaybookSuggestionsPanel({
  householdId,
  suggestions,
}: {
  householdId: HouseholdId;
  suggestions: PlaybookSuggestion[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  if (suggestions.length === 0) return null;

  const onEnable = (playbookId: string) => {
    setBusy(playbookId);
    startTransition(async () => {
      const res = await enablePlaybook(householdId, playbookId);
      setMessages((m) => ({ ...m, [playbookId]: res.message }));
      setBusy(null);
      // Refresh: the enabled playbook shows up under Playbooks and
      // drops out of the suggestions list.
      router.refresh();
    });
  };

  return (
    <div className="suggestions-panel">
      <div className="section-head">
        <h2>Playbook suggestions</h2>
        <span className="mono">
          {suggestions.length} shipped playbook
          {suggestions.length === 1 ? "" : "s"} match this household
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        These playbooks aren't enabled yet, and the household's activity
        shape indicates they'd earn their keep. Enabling uses the default
        schedule and config — adjust after the first firing if the cadence
        is wrong.
      </p>
      <div className="playbook-suggestion-list">
        {suggestions.map((s) => (
          <div key={s.playbookId} className="playbook-suggestion">
            <div className="playbook-suggestion-header">
              <h3>{s.name}</h3>
              <span className="tag">{s.domain}</span>
            </div>
            <p className="muted">{s.description}</p>
            <p>
              <strong>Why now:</strong> {s.reason}
            </p>
            <div className="playbook-suggestion-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={isPending && busy === s.playbookId}
                onClick={() => onEnable(s.playbookId)}
              >
                {isPending && busy === s.playbookId
                  ? "Enabling…"
                  : "Enable playbook"}
              </button>
              {messages[s.playbookId] ? (
                <span className="mono muted" style={{ marginLeft: 12 }}>
                  {messages[s.playbookId]}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
