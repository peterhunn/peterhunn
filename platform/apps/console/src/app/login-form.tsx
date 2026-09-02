"use client";

import { useState, useTransition } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="login"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const res = await login(formData);
          if (res?.error) setError(res.error);
        });
      }}
    >
      <div className="form-field">
        <label htmlFor="token">Bearer token</label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="off"
          placeholder="atl_..."
          required
        />
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Sign in"}
      </button>
    </form>
  );
}
