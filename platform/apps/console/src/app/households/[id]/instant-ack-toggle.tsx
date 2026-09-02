"use client";

import { useState, useTransition } from "react";
import { setInstantAck } from "./actions";
import type { HouseholdId } from "@atelier/domain";

// Small inline switch on the household header. When on, the
// concierge line answers a customer's inbound SMS with an instant
// "Got it, I'll follow up" reply — an agent-authored outbound
// going to the customer without manager review. Off by default so
// no customer-facing agent surface exists unless the household
// explicitly opts in. STOP/START consent confirmations still fire
// unconditionally either way.
export function InstantAckToggle({
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
              const res = await setInstantAck(householdId, next);
              setMessage(res.message);
            });
          }}
        />
        <span>Instant ack {enabled ? "on" : "off"}</span>
      </label>
      <span className="autopilot-help">
        {enabled
          ? "Customer receives an automated “Got it, will follow up” SMS on every inbound. Manager still reviews and sends the real reply from the console."
          : "No automated reply. Customer waits for the manager. Recommended — keeps every customer-facing message manager-written."}
      </span>
      {message ? <span className="mono muted">{message}</span> : null}
    </div>
  );
}
