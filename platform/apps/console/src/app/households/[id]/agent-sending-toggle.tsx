"use client";

import { useState, useTransition } from "react";
import { setAgentSending } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// The wire-level enforcement for the manager-mediated-only model.
// When off (default), sendOutboundMessage and sendOutboundEmail
// refuse any send whose authoredBy.type === "agent", and the
// orchestrator refuses auto-execute of any communication-class
// tool for this household — no matter what the policy engine
// said. Manager-authored sends bypass the flag entirely.
export function AgentSendingToggle({
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
              const res = await setAgentSending(householdId, next);
              setMessage(res.message);
            });
          }}
        />
        <span>Agent-authored sends {enabled ? "allowed" : "blocked"}</span>
      </label>
      <span className="autopilot-help">
        {enabled
          ? "Communication-class tools (SMS + email) can fire without manager review when a policy grants execute. Turn off to enforce manager-typed customer messaging even against a mis-set policy."
          : "Every customer outbound is manager-typed. Agents draft into the approval queue only; the wire seam refuses any send stamped agent-authored even if a policy said execute."}
      </span>
      {message ? <span className="mono muted">{message}</span> : null}
    </div>
  );
}
