"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";

export function PasskeyLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSignIn = async () => {
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter the email tied to your manager account.");
      return;
    }
    try {
      const optsRes = await fetch("/api/webauthn/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!optsRes.ok) {
        setError("Could not start the passkey ceremony.");
        return;
      }
      const { options, challengeId } = (await optsRes.json()) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId: string;
      };

      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/webauthn/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, response: assertion }),
      });
      if (!verifyRes.ok) {
        setError("That passkey didn't match. Try another device?");
        return;
      }
      router.push("/dashboard");
    } catch (err) {
      // Most common cause: user cancelled the platform prompt.
      const msg = (err as Error).message ?? "unknown_error";
      setError(msg === "NotAllowedError" ? "Cancelled." : msg);
    }
  };

  return (
    <div className="passkey-login">
      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username webauthn"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button
        className="btn"
        type="button"
        disabled={pending}
        onClick={() => startTransition(handleSignIn)}
      >
        {pending ? "Waiting for passkey..." : "Sign in with a passkey"}
      </button>
    </div>
  );
}
