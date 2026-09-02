"use client";

import { useState, useTransition } from "react";
import { inviteCustomer } from "./actions";
import type { HouseholdId } from "@atelier/domain";

type Channel = "sms" | "whatsapp";

export interface Person {
  id: string;
  data: Record<string, unknown>;
}

// One-click customer onboarding for the shared-line deploy: enter
// a phone number, pick which profile it belongs to, click Invite.
// The server (a) mints a code and (b) sends "reply CODE to
// +concierge" from the concierge line in a single call. When the
// customer replies, the inbound webhook binds their number to
// this household AND to the selected profile so every future
// message identifies WHO is texting, not just which household.
export function InviteCustomer({
  householdId,
  conciergeNumber,
  sharedLineActive,
  people,
}: {
  householdId: HouseholdId;
  conciergeNumber: string | null;
  sharedLineActive: boolean;
  people: {
    principal: Person[];
    member: Person[];
    staff: Person[];
    contact: Person[];
  };
}) {
  const [channel, setChannel] = useState<Channel>("sms");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [principalId, setPrincipalId] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const allPeople: Array<{ id: string; label: string }> = [
    ...people.principal.map((p) => ({ id: p.id, label: personLabel(p, "Principal") })),
    ...people.member.map((p) => ({ id: p.id, label: personLabel(p, "Member") })),
    ...people.staff.map((p) => ({ id: p.id, label: personLabel(p, "Staff") })),
    ...people.contact.map((p) => ({ id: p.id, label: personLabel(p, "Contact") })),
  ];

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
        Enter the person's phone and pick which profile it belongs to. The
        server sends "reply CODE" from the concierge line; when they reply,
        their number is bound to that profile so every future message
        identifies who's texting.
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
              ...(principalId ? { principalId } : {}),
            });
            setMessage(res.message);
            if (!res.message.startsWith("Error")) {
              setAddress("");
              setLabel("");
              setPrincipalId("");
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
        <select
          value={principalId}
          onChange={(e) => setPrincipalId(e.target.value)}
          disabled={isPending || allPeople.length === 0}
          title="Which profile does this number belong to?"
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
          Send invite
        </button>
      </form>
      {message ? (
        <p className="mono" style={{ marginTop: "0.5rem" }}>
          {message}
        </p>
      ) : null}
      {allPeople.length === 0 ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Add people to this household first so the invite can bind the
          number to a profile.
        </p>
      ) : null}
    </div>
  );
}

const personLabel = (p: Person, kind: string): string => {
  const d = p.data as { fullName?: string; name?: string };
  const name = d.fullName ?? d.name ?? "(unnamed)";
  return `${name} · ${kind}`;
};
