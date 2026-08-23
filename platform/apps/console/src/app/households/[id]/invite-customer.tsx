"use client";

import { useState, useTransition } from "react";
import { inviteCustomer } from "./actions";
import type { HouseholdId } from "@atelier/domain";

type Channel = "sms" | "whatsapp";

// One-click customer onboarding for the shared-line deploy: enter
// a phone number, click Invite, and the server (a) mints a code
// and (b) sends "reply CODE to +concierge" from the concierge
// line in a single call. When the customer replies, the inbound
// webhook binds their number to this household.
export function InviteCustomer({
  householdId,
  conciergeNumber,
  sharedLineActive,
}: {
  householdId: HouseholdId;
  conciergeNumber: string | null;
  sharedLineActive: boolean;
}) {
  const [channel, setChannel] = useState<Channel>("sms");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <div className="section-head">
        <h2>Invite a customer</h2>
        {sharedLineActive && conciergeNumber ? (
          <span className="mono muted">concierge: {conciergeNumber}</span>
        ) : (
          <span className="muted">no shared line configured</span>
        )}
      </div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        Enter the customer's phone. The server sends "reply CODE" from the
        concierge line; when they reply, their number is bound to this
        household and they can text in freely.
      </p>
      <form
        className="endpoint-form"
        onSubmit={(evt) => {
          evt.preventDefault();
          startTransition(async () => {
            const res = await inviteCustomer(householdId, {
              channel,
              address,
              ...(label ? { label } : {}),
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setAddress("");
              setLabel("");
            }
          });
        }}
      >
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          disabled={isPending}
        >
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="+14155551212"
          disabled={isPending}
          required
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          disabled={isPending}
        />
        <button type="submit" disabled={isPending || !address}>
          Send invite
        </button>
      </form>
      {message ? (
        <p className="mono" style={{ marginTop: "0.5rem" }}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
