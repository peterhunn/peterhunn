"use client";

import { useState, useTransition } from "react";
import { addMessagingEndpoint, revokeMessagingEndpoint } from "./actions";
import type { HouseholdId } from "@atelier/domain";

interface Endpoint {
  id: string;
  channel: "sms" | "whatsapp" | "imessage" | "email";
  address: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export function MessagingEndpoints({
  householdId,
  initialEndpoints,
}: {
  householdId: HouseholdId;
  initialEndpoints: Endpoint[];
}) {
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [channel, setChannel] = useState<Endpoint["channel"]>("sms");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const active = endpoints.filter((e) => !e.revokedAt);

  return (
    <div>
      <div className="section-head">
        <h2>Customer channels</h2>
        <span className="mono">{active.length} active</span>
      </div>
      {active.length === 0 ? (
        <div className="empty">
          No contact endpoints registered. Add a phone number so the
          customer can reach the service by SMS or WhatsApp.
        </div>
      ) : (
        <ul className="endpoint-list">
          {active.map((e) => (
            <li key={e.id} className="endpoint-row">
              <span className={`tag tag-${e.channel}`}>{e.channel}</span>
              <span className="mono">{e.address}</span>
              {e.label ? <span className="muted">{e.label}</span> : null}
              <button
                type="button"
                disabled={isPending}
                className="link-btn"
                onClick={() =>
                  startTransition(async () => {
                    const res = await revokeMessagingEndpoint(householdId, e.id);
                    setMessage(res.message);
                    if (!res.message.startsWith("Error")) {
                      setEndpoints((prev) =>
                        prev.map((x) =>
                          x.id === e.id ? { ...x, revokedAt: new Date().toISOString() } : x,
                        ),
                      );
                    }
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="endpoint-form"
        onSubmit={(evt) => {
          evt.preventDefault();
          startTransition(async () => {
            const res = await addMessagingEndpoint(householdId, {
              channel,
              address,
              ...(label ? { label } : {}),
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setAddress("");
              setLabel("");
              // Optimistic append; a hard refresh will re-read from the API.
              setEndpoints((prev) => [
                ...prev,
                {
                  id: `pending_${Date.now()}`,
                  channel,
                  address,
                  label: label || null,
                  createdAt: new Date().toISOString(),
                  revokedAt: null,
                },
              ]);
            }
          });
        }}
      >
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Endpoint["channel"])}
          disabled={isPending}
        >
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="imessage">iMessage</option>
          <option value="email">Email</option>
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
          Add
        </button>
        {message ? <span className="mono muted">{message}</span> : null}
      </form>
    </div>
  );
}
