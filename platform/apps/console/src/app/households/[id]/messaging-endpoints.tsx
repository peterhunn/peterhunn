"use client";

import { useState, useTransition } from "react";
import { addMessagingEndpoint, revokeMessagingEndpoint } from "./actions";
import type { HouseholdId } from "@atelier/domain";
import type { Person } from "./invite-customer";

interface Endpoint {
  id: string;
  channel: "sms" | "whatsapp" | "imessage" | "email";
  address: string;
  label: string | null;
  principalId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export function MessagingEndpoints({
  householdId,
  initialEndpoints,
  people,
}: {
  householdId: HouseholdId;
  initialEndpoints: Endpoint[];
  people: {
    principal: Person[];
    member: Person[];
    staff: Person[];
    contact: Person[];
  };
}) {
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [channel, setChannel] = useState<Endpoint["channel"]>("sms");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [principalId, setPrincipalId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const active = endpoints.filter((e) => !e.revokedAt);

  const personIndex = new Map<string, string>();
  for (const kind of ["principal", "member", "staff", "contact"] as const) {
    for (const p of people[kind]) {
      const d = p.data as { fullName?: string; name?: string };
      personIndex.set(p.id, d.fullName ?? d.name ?? "(unnamed)");
    }
  }
  const allPeople: Array<{ id: string; label: string }> = [
    ...people.principal.map((p) => ({ id: p.id, label: `${personIndex.get(p.id)} · Principal` })),
    ...people.member.map((p) => ({ id: p.id, label: `${personIndex.get(p.id)} · Member` })),
    ...people.staff.map((p) => ({ id: p.id, label: `${personIndex.get(p.id)} · Staff` })),
    ...people.contact.map((p) => ({ id: p.id, label: `${personIndex.get(p.id)} · Contact` })),
  ];

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
          {active.map((e) => {
            const name = e.principalId ? personIndex.get(e.principalId) : null;
            return (
              <li key={e.id} className="endpoint-row">
                <span className={`tag tag-${e.channel}`}>{e.channel}</span>
                <span className="mono">{e.address}</span>
                {name ? (
                  <span className="muted">→ {name}</span>
                ) : (
                  <span className="muted">→ unassigned</span>
                )}
                {e.label ? <span className="muted">· {e.label}</span> : null}
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
            );
          })}
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
              ...(principalId ? { principalId } : {}),
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setAddress("");
              setLabel("");
              setPrincipalId("");
              setEndpoints((prev) => [
                ...prev,
                {
                  id: `pending_${Date.now()}`,
                  channel,
                  address,
                  label: label || null,
                  principalId: principalId || null,
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
        <select
          value={principalId}
          onChange={(e) => setPrincipalId(e.target.value)}
          disabled={isPending}
        >
          <option value="">— unassigned —</option>
          {allPeople.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
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
