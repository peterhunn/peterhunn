"use client";

import { useState, useTransition } from "react";
import { startRegistration } from "@simplewebauthn/browser";

export interface Passkey {
  readonly id: string;
  readonly deviceLabel: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export function PasskeyList({ initialPasskeys }: { initialPasskeys: readonly Passkey[] }) {
  const [passkeys, setPasskeys] = useState<readonly Passkey[]>(initialPasskeys);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const register = async () => {
    setError(null);
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Give the device a name — 'MacBook', 'YubiKey', etc.");
      return;
    }
    try {
      const optsRes = await fetch("/api/webauthn/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceLabel: trimmed }),
      });
      if (!optsRes.ok) {
        setError("Could not start passkey registration.");
        return;
      }
      const { options, challengeId } = (await optsRes.json()) as {
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeId: string;
      };
      const attestation = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch("/api/webauthn/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId,
          deviceLabel: trimmed,
          response: attestation,
        }),
      });
      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Registration failed.");
        return;
      }
      const { credential } = (await verifyRes.json()) as {
        credential: { id: string; deviceLabel: string };
      };
      setPasskeys((prev) => [
        ...prev,
        {
          id: credential.id,
          deviceLabel: credential.deviceLabel,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ]);
      setLabel("");
    } catch (err) {
      const msg = (err as Error).message ?? "unknown_error";
      setError(msg === "NotAllowedError" ? "Cancelled." : msg);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/passkeys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not delete that passkey.");
      return;
    }
    setPasskeys((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <section className="passkeys">
      <div className="passkey-register">
        <div className="form-field">
          <label htmlFor="deviceLabel">Register a new device</label>
          <input
            id="deviceLabel"
            type="text"
            placeholder="e.g. MacBook, YubiKey"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <button
          className="btn"
          type="button"
          onClick={() => startTransition(register)}
          disabled={pending}
        >
          {pending ? "Waiting..." : "Add passkey"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {passkeys.length === 0 ? (
        <p className="hint">No passkeys registered yet.</p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((pk) => (
            <li key={pk.id} className="passkey-row">
              <div>
                <div className="passkey-label">{pk.deviceLabel}</div>
                <div className="passkey-meta">
                  Registered {new Date(pk.createdAt).toLocaleDateString()}
                  {pk.lastUsedAt ? (
                    <> · Last used {new Date(pk.lastUsedAt).toLocaleDateString()}</>
                  ) : (
                    <> · Never used</>
                  )}
                </div>
              </div>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => void remove(pk.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
