import type { StoredCredential, ToolContext } from "../types.js";

// Shared Google OAuth helper used by every Google adapter. The
// credential blob shape is the same across products: an access token,
// optional refresh material, and product-specific extras (calendar_id,
// from_address, time_zone) that the caller reads directly.

export interface GoogleOAuthFields {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly [k: string]: unknown;
}

const isExpired = (expiresAt: string | null): boolean => {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) < Date.now();
};

export const refreshGoogleAccessToken = async (
  cred: GoogleOAuthFields,
): Promise<{ accessToken: string; expiresAt: string }> => {
  if (!cred.refresh_token || !cred.client_id || !cred.client_secret) {
    throw new Error("google_missing_refresh_config");
  }
  const params = new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`google_oauth_refresh_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("google_oauth_no_access_token");
  const expiresAt = new Date(
    Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  ).toISOString();
  return { accessToken: json.access_token, expiresAt };
};

// Read a Google-shaped credential for a provider from the tool
// context, refreshing the access token if it's expired.  Returns null
// if the household has not connected the provider, or if the refresh
// path is missing prerequisites.  Throws only for hard OAuth errors;
// callers treat null as "no live credential, use the mock path."
export const readGoogleAuth = async <T extends GoogleOAuthFields>(
  ctx: ToolContext,
  provider: string,
): Promise<
  | (T & { accessToken: string; credentialId: string })
  | null
> => {
  const raw = ctx.readCredential(provider);
  if (!raw) return null;
  const cred = raw.credential as T;
  let accessToken = cred.access_token;
  if (!accessToken || isExpired(raw.expiresAt)) {
    if (!cred.refresh_token) return null;
    const refreshed = await refreshGoogleAccessToken(cred);
    accessToken = refreshed.accessToken;
    // Persist the refreshed token back to the credentials store so
    // subsequent calls in this and the next hour don't refresh again.
    // Optional on the context — tests can leave it undefined.
    if (ctx.persistAccessToken) {
      try {
        ctx.persistAccessToken(raw.id, refreshed.accessToken, refreshed.expiresAt);
      } catch (err) {
        ctx.logger?.info(`${provider} persistAccessToken failed`, {
          error: (err as Error).message,
        });
      }
    }
    ctx.logger?.info(`${provider} refreshed access token`, {
      credentialId: raw.id,
      persisted: Boolean(ctx.persistAccessToken),
    });
  }
  return { ...cred, accessToken, credentialId: raw.id };
};

// Utility — encode a raw email message as base64url for the Gmail
// send endpoint.  Uses Buffer where available (Node), falls back to
// btoa for portability.
export const base64UrlEncode = (s: string): string => {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "utf-8").toString("base64")
      : btoa(unescape(encodeURIComponent(s)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export { isExpired as _isExpiredForTesting };
