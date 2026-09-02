"use client";

import { useState, useTransition } from "react";
import { createVerification } from "./actions";
import type { HouseholdId } from "@atelier/domain";

type Channel = "sms" | "whatsapp" | "imessage" | "email";

interface Verification {
  id: string;
  channel: Channel;
  code: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedFromAddress: string | null;
  label: string | null;
}

// Manager-facing panel: mint a verification code, then ask the
// customer to text it from the number they want to register.
// The webhook binds the from-address on match.
export function VerifyEndpoint({
  householdId,
  initialVerifications,
}: {
  householdId: HouseholdId;
  initialVerifications: Verification[];
}) {
  const [channel, setChannel] = useState<Channel>("sms");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState<Verification[]>(
    initialVerifications.filter((v) => !v.consumedAt),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <div className="section-head">
        <h2>Verify a customer number</h2>
      </div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        Mint a 6-digit code, then ask the customer to text it from
        the number they want to bind. On a match, the webhook
        registers their number as a contact endpoint.
      </p>
      <form
        className="endpoint-form"
        onSubmit={(evt) => {
          evt.preventDefault();
          startTransition(async () => {
            const res = await createVerification(householdId, {
              channel,
              ...(label ? { label } : {}),
            });
            setMessage(res.message);
            if (res.code && res.expiresAt) {
              setPending((prev) => [
                {
                  id: `local_${Date.now()}`,
                  channel,
                  code: res.code!,
                  expiresAt: res.expiresAt!,
                  consumedAt: null,
                  consumedFromAddress: null,
                  label: label || null,
                },
                ...prev,
              ]);
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
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Alex's iPhone)"
          disabled={isPending}
        />
        <button type="submit" disabled={isPending}>
          Mint code
        </button>
      </form>
      {message ? <p className="mono" style={{ marginTop: "0.5rem" }}>{message}</p> : null}

      {pending.length > 0 ? (
        <ul className="endpoint-list" style={{ marginTop: "0.75rem" }}>
          {pending.map((v) => (
            <li key={v.id} className="endpoint-row">
              <span className={`tag tag-${v.channel}`}>{v.channel}</span>
              <span
                className="mono"
                style={{ fontSize: "1.15rem", letterSpacing: "0.1em" }}
              >
                {v.code}
              </span>
              <span className="muted">
                expires {new Date(v.expiresAt).toLocaleTimeString()}
              </span>
              {v.label ? <span className="muted">· {v.label}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
