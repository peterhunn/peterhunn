import { OAuth2Client } from "google-auth-library";
import type { StoredCredential, ToolContext } from "../types.js";

// Shared Google helper. Wraps a household's stored Google credential
// in a configured OAuth2Client so downstream code hands the SDK
// clients (google.calendar / google.gmail) a live auth object with
// refresh handling for free.
//
// The credential blob shape (unchanged from the pre-SDK version):
//   { access_token, refresh_token?, expires_at?, client_id?,
//     client_secret?, ...product-specific extras }
//
// Persistence: when the OAuth2Client refreshes a token, its
// "tokens" event fires; we forward that to
// ctx.persistAccessToken so subsequent calls in this and the next
// hour don't refresh again.

export interface GoogleOAuthFields {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly [k: string]: unknown;
}

export interface GoogleAuth<T extends GoogleOAuthFields> {
  readonly client: OAuth2Client;
  // Legacy shape kept for tools that still want the raw token
  // string. Reads through to the client's current credentials so a
  // background refresh is visible without another read.
  readonly accessToken: string;
  readonly credential: T;
  readonly credentialId: string;
}

const isExpired = (expiresAt: string | null): boolean => {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) < Date.now();
};

// Read a Google-shaped credential for a provider and return a
// configured OAuth2Client. The client is primed with the stored
// access token; refresh is handled by google-auth-library as needed
// (it re-reads the token, calls the refresh endpoint, updates its
// own credentials, and fires our persistence listener).
//
// Returns null when the household has not connected the provider
// or when the refresh path is missing prerequisites — same contract
// as the pre-SDK version.
export const readGoogleAuth = async <T extends GoogleOAuthFields>(
  ctx: ToolContext,
  provider: string,
): Promise<GoogleAuth<T> | null> => {
  const raw = ctx.readCredential(provider);
  if (!raw) return null;
  const cred = raw.credential as T;
  if (!cred.access_token && !cred.refresh_token) return null;

  const client = new OAuth2Client(cred.client_id, cred.client_secret);
  client.setCredentials({
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    ...(raw.expiresAt ? { expiry_date: Date.parse(raw.expiresAt) } : {}),
  });

  // Forward every refresh to the credentials store so the next call
  // (and the next process boot) picks up the fresh token.
  client.on("tokens", (tokens) => {
    if (!tokens.access_token || !tokens.expiry_date) return;
    if (!ctx.persistAccessToken) return;
    try {
      ctx.persistAccessToken(
        raw.id,
        tokens.access_token,
        new Date(tokens.expiry_date).toISOString(),
      );
      ctx.logger?.info(`${provider} access token persisted after refresh`, {
        credentialId: raw.id,
      });
    } catch (err) {
      ctx.logger?.info(`${provider} persistAccessToken failed`, {
        error: (err as Error).message,
      });
    }
  });

  // Proactively refresh if the stored token is expired — this
  // avoids a first-call round-trip that would happen implicitly
  // and lets us surface refresh errors cleanly.
  if (!cred.access_token || isExpired(raw.expiresAt)) {
    if (!cred.refresh_token) return null;
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
    } catch {
      return null;
    }
  }

  const accessToken =
    (client.credentials.access_token as string | null | undefined) ??
    cred.access_token ??
    "";
  return {
    client,
    accessToken,
    credential: cred,
    credentialId: raw.id,
  };
};

// Utility — encode a raw email message as base64url for the Gmail
// send endpoint. Uses Buffer where available (Node), falls back to
// btoa for portability.
export const base64UrlEncode = (s: string): string => {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "utf-8").toString("base64")
      : btoa(unescape(encodeURIComponent(s)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export { isExpired as _isExpiredForTesting };
