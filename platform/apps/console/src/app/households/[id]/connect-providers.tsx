"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import type { CredentialSummary } from "@/lib/api";
import type { HouseholdId } from "@atelier/domain";
import { startGoogleOAuth } from "./actions";

export function ConnectProviders({
  householdId,
  credentials,
  oauthConfigured,
}: {
  householdId: HouseholdId;
  credentials: readonly CredentialSummary[];
  oauthConfigured: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const search = useSearchParams();
  const oauthStatus = search.get("oauth");
  const connected = search.get("connected");
  const reason = search.get("reason");

  const google = credentials.filter(
    (c) => (c.provider === "google_calendar" || c.provider === "gmail") && !c.revokedAt,
  );

  const handleConnect = () => {
    if (!oauthConfigured) {
      setError(
        "OAuth is not configured on the API. Set GOOGLE_OAUTH_CLIENT_ID / _SECRET and ATELIER_OAUTH_STATE_SECRET.",
      );
      return;
    }
    setError(null);
    startTransition(async () => {
      const returnTo = typeof window !== "undefined" ? window.location.href : "";
      const res = await startGoogleOAuth(householdId, returnTo);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.authUrl && typeof window !== "undefined") {
        window.location.href = res.authUrl;
      }
    });
  };

  return (
    <div className="card connect-card">
      <div className="connect-head">
        <div>
          <p className="connect-title">Google (Calendar + Gmail)</p>
          <p className="hint" style={{ marginTop: 4 }}>
            {google.length === 0
              ? "Not connected. One click authorizes both Calendar and Gmail send."
              : `${google.length} credential${google.length === 1 ? "" : "s"} on file.`}
          </p>
        </div>
        <button className="btn" type="button" disabled={pending} onClick={handleConnect}>
          {google.length === 0
            ? pending
              ? "Redirecting..."
              : "Connect Google"
            : pending
              ? "Redirecting..."
              : "Re-connect"}
        </button>
      </div>

      {google.length > 0 ? (
        <ul className="connect-list">
          {google.map((c) => (
            <li key={c.id}>
              <span className="tag">{c.provider}</span>{" "}
              <span className="mono">{c.label}</span>{" "}
              <span className="mono muted">
                {c.expiresAt
                  ? `expires ${new Date(c.expiresAt).toLocaleString()}`
                  : "no expiry"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {oauthStatus === "ok" ? (
        <p className="hint" style={{ color: "var(--accent)" }}>
          Connected {connected}.
        </p>
      ) : null}
      {oauthStatus === "error" ? (
        <p className="hint error">OAuth failed: {reason ?? "unknown"}</p>
      ) : null}
      {error ? <p className="hint error">{error}</p> : null}

      {!oauthConfigured ? (
        <p className="hint">
          OAuth env not set — Calendar and Gmail tools will fall back to their mock outputs.
        </p>
      ) : null}
    </div>
  );
}
