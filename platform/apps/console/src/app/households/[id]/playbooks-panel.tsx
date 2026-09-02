"use client";

import { useState, useTransition } from "react";
import { disablePlaybook, enablePlaybook, runPlaybookNow } from "./actions";
import type { HouseholdId } from "@atelier/domain";

interface PlaybookView {
  id: string;
  name: string;
  description: string;
  domain: string;
  schedule: Record<string, unknown>;
  enabled: boolean;
  registered: boolean;
  lastFireAt: string | null;
  nextFireAt: string | null;
  lastRunId: string | null;
}

const describeSchedule = (s: Record<string, unknown>): string => {
  if (s["kind"] === "weekly") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Weekly · ${days[s["dayOfWeek"] as number] ?? "?"} @ ${String(
      s["hourUtc"],
    ).padStart(2, "0")}:00 UTC`;
  }
  if (s["kind"] === "monthly") {
    return `Monthly · day ${s["dayOfMonth"]} @ ${String(s["hourUtc"]).padStart(
      2,
      "0",
    )}:00 UTC`;
  }
  if (s["kind"] === "interval_hours") {
    return `Every ${s["hours"]}h`;
  }
  return JSON.stringify(s);
};

export function PlaybooksPanel({
  householdId,
  initialPlaybooks,
}: {
  householdId: HouseholdId;
  initialPlaybooks: PlaybookView[];
}) {
  const [playbooks, setPlaybooks] = useState(initialPlaybooks);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const patchLocal = (id: string, patch: Partial<PlaybookView>): void => {
    setPlaybooks((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  return (
    <div>
      <div className="section-head">
        <h2>Playbooks</h2>
        <span className="mono">
          {playbooks.filter((p) => p.enabled).length} / {playbooks.length} enabled
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        Packaged autonomy templates — one click enables a recurring
        task that lands proposed actions in the approval queue on
        its schedule.
      </p>
      <ul className="playbook-list">
        {playbooks.map((p) => (
          <li key={p.id} className={`playbook-row ${p.enabled ? "on" : "off"}`}>
            <div className="playbook-header">
              <span className="playbook-name">{p.name}</span>
              <span className="tag">{p.domain}</span>
              <span className="muted mono">{describeSchedule(p.schedule)}</span>
            </div>
            <p className="playbook-desc">{p.description}</p>
            <div className="playbook-meta">
              {p.lastFireAt ? (
                <span className="mono muted">
                  last {new Date(p.lastFireAt).toLocaleString()}
                </span>
              ) : (
                <span className="mono muted">never fired</span>
              )}
              {p.nextFireAt ? (
                <span className="mono muted">
                  next {new Date(p.nextFireAt).toLocaleString()}
                </span>
              ) : null}
              {status[p.id] ? <span className="mono">{status[p.id]}</span> : null}
            </div>
            <div className="playbook-actions">
              {p.enabled ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await disablePlaybook(householdId, p.id);
                      setStatus((s) => ({ ...s, [p.id]: res.message }));
                      if (!res.message.startsWith("Error")) {
                        patchLocal(p.id, { enabled: false });
                      }
                    })
                  }
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await enablePlaybook(householdId, p.id);
                      setStatus((s) => ({ ...s, [p.id]: res.message }));
                      if (!res.message.startsWith("Error")) {
                        patchLocal(p.id, { enabled: true, registered: true });
                      }
                    })
                  }
                >
                  Enable
                </button>
              )}
              <button
                type="button"
                className="link-btn"
                disabled={isPending || !p.registered}
                onClick={() =>
                  startTransition(async () => {
                    const res = await runPlaybookNow(householdId, p.id);
                    setStatus((s) => ({ ...s, [p.id]: res.message }));
                  })
                }
              >
                Run now
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
