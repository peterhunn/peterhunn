"use client";

import { useState, useTransition } from "react";
import { setAutopilot } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// Small inline switch on the household header. The scheduler on the
// API reads households.autopilotEnabled on every tick, so a change
// takes effect on the next sync — no restart.
export function AutopilotToggle({
  householdId,
  initialEnabled,
}: {
  householdId: HouseholdId;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="autopilot-row">
      <label className="autopilot-switch">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isPending}
          onChange={(e) => {
            const next = e.target.checked;
            setEnabled(next);
            startTransition(async () => {
              const res = await setAutopilot(householdId, next);
              setMessage(res.message);
            });
          }}
        />
        <span>
          Autopilot {enabled ? "on" : "paused"}
        </span>
      </label>
      <span className="autopilot-help">
        {enabled
          ? "New synced messages and events are auto-triaged; drafts land in the approval queue."
          : "Sync still runs; agents don't fire automatically. Manager must click Run intent."}
      </span>
      {message ? <span className="mono muted">{message}</span> : null}
    </div>
  );
}
