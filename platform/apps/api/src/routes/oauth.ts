import { createHmac, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { credentialRepo, householdRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// OAuth consent flow — currently Google (Calendar + Gmail scopes in
// one call). A manager clicks Connect Google in the console; the
// server signs an HMAC state carrying the household id and returnTo;
// the browser bounces to Google; Google calls back the API with
// code+state; we exchange the code for tokens, hit userinfo to learn
// the from_address, store two credential entries (google_calendar +
// gmail), and redirect the browser back to the console household
// page.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
];

const STATE_TTL_MS = 15 * 60 * 1000;

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf as never)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

interface StatePayload {
  h: string; // household id
  r: string; // returnTo
  n: string; // nonce
  t: number; // issued at (ms)
}

// The active secret signs new consent flows; a secondary "previous"
// secret is accepted during verification only. Rotation flow:
//   1. Move current secret → ATELIER_OAUTH_STATE_SECRET_PREVIOUS
//   2. Put fresh secret → ATELIER_OAUTH_STATE_SECRET
//   3. Restart. In-flight consent redirects verify under the
//      previous secret; new mints sign under the fresh one.
//   4. After STATE_TTL_MS (15 minutes) pass, unset the previous
//      secret. Verification loses the fallback and stays strict.
const stateSecret = (): string => {
  const s = process.env["ATELIER_OAUTH_STATE_SECRET"];
  if (!s || s.length < 16) {
    throw new Error(
      "ATELIER_OAUTH_STATE_SECRET is not set — required (>=16 chars) for OAuth flows",
    );
  }
  return s;
};

const previousStateSecret = (): string | null => {
  const s = process.env["ATELIER_OAUTH_STATE_SECRET_PREVIOUS"];
  if (!s || s.length < 16) return null;
  return s;
};

const signState = (payload: StatePayload): string => {
  const json = JSON.stringify(payload);
  const body = b64url(json);
  // Always sign new state with the active (current) secret.
  const sig = b64url(createHmac("sha256", stateSecret()).update(body).digest());
  return `${body}.${sig}`;
};

const verifyState = (state: string): StatePayload | null => {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  // Verify against the current secret first (hot path). Fall back
  // to the previous secret so in-flight consent redirects survive
  // a fresh rotation — see the block comment at stateSecret().
  const current = b64url(
    createHmac("sha256", stateSecret()).update(body).digest(),
  );
  let matched = current === sig;
  if (!matched) {
    const prev = previousStateSecret();
    if (prev) {
      const alt = b64url(createHmac("sha256", prev).update(body).digest());
      matched = alt === sig;
    }
  }
  if (!matched) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf-8")) as StatePayload;
  } catch {
    return null;
  }
  if (Date.now() - payload.t > STATE_TTL_MS) return null;
  return payload;
};

const requireGoogleClient = (): { clientId: string; clientSecret: string; redirectUri: string } => {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const redirectUri =
    process.env["GOOGLE_OAUTH_REDIRECT_URI"] ??
    "http://localhost:3001/oauth/google/callback";
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set to start the OAuth flow",
    );
  }
  return { clientId, clientSecret, redirectUri };
};

const consoleUrl = (): string =>
  process.env["ATELIER_CONSOLE_URL"] ?? "http://localhost:3000";

const errRedirect = (returnTo: string, err: string): string => {
  try {
    const url = new URL(returnTo);
    url.searchParams.set("oauth", "error");
    url.searchParams.set("reason", err.slice(0, 120));
    return url.toString();
  } catch {
    return `${consoleUrl()}/dashboard?oauth=error&reason=${encodeURIComponent(err.slice(0, 120))}`;
  }
};

const okRedirect = (returnTo: string, connected: readonly string[]): string => {
  try {
    const url = new URL(returnTo);
    url.searchParams.set("oauth", "ok");
    url.searchParams.set("connected", connected.join(","));
    return url.toString();
  } catch {
    return `${consoleUrl()}/dashboard?oauth=ok&connected=${connected.join(",")}`;
  }
};

export const oauthRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const credentials = credentialRepo(db);
  const households = householdRepo(db);

  app.get(
    "/oauth/google/config",
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async () => {
      const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
      const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
      const stateSet = Boolean(process.env["ATELIER_OAUTH_STATE_SECRET"]);
      return {
        configured: Boolean(clientId && clientSecret && stateSet),
        clientId: Boolean(clientId),
        clientSecret: Boolean(clientSecret),
        stateSecret: stateSet,
        redirectUri:
          process.env["GOOGLE_OAUTH_REDIRECT_URI"] ??
          "http://localhost:3001/oauth/google/callback",
        scopes: GOOGLE_SCOPES,
      };
    },
  );

  app.post<{
    Params: { householdId: string };
    Body: { returnTo?: string };
  }>(
    "/households/:householdId/oauth/google/start",
    {
      config: { audit: { action: "oauth.start", resourceType: "credential", sensitive: true } },
    },
    async (req, reply) => {
      let google;
      try {
        google = requireGoogleClient();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      let state: string;
      try {
        const payload: StatePayload = {
          h: req.householdContext as string,
          r: (req.body?.returnTo ?? `${consoleUrl()}/households/${req.householdContext}`).slice(0, 500),
          n: randomBytes(12).toString("hex"),
          t: Date.now(),
        };
        state = signState(payload);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }

      const params = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: google.redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        scope: GOOGLE_SCOPES.join(" "),
        state,
      });
      return { authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}` };
    },
  );

  // Google POSTs the browser here after consent. Public route — no
  // bearer token; the state HMAC is the trust anchor.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/google/callback",
    {
      config: {
        public: true,
        // Rate limit strictly — the callback verifies an HMAC + hits
        // Google's token endpoint. Nothing legitimate hits this
        // more than a few times a minute from one client.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const { code, state, error } = req.query;
      const payload = state ? verifyState(state) : null;
      const returnTo = payload?.r ?? `${consoleUrl()}/dashboard`;

      if (error) return reply.redirect(errRedirect(returnTo, `google_${error}`));
      if (!code || !state || !payload) {
        return reply.redirect(errRedirect(returnTo, "invalid_state"));
      }

      const hh = households.get(payload.h as HouseholdId);
      if (!hh) return reply.redirect(errRedirect(returnTo, "household_not_found"));

      let google;
      try {
        google = requireGoogleClient();
      } catch (err) {
        return reply.redirect(errRedirect(returnTo, (err as Error).message));
      }

      // Exchange code → tokens via OAuth2Client.
      const oauth2Client = new OAuth2Client(
        google.clientId,
        google.clientSecret,
        google.redirectUri,
      );
      let tokens: {
        access_token?: string | null;
        refresh_token?: string | null;
        expiry_date?: number | null;
        scope?: string | null;
      };
      try {
        const tokenRes = await oauth2Client.getToken(code);
        tokens = tokenRes.tokens;
      } catch (err) {
        return reply.redirect(
          errRedirect(returnTo, `token_exchange:${(err as Error).message.slice(0, 80)}`),
        );
      }
      if (!tokens.access_token) {
        return reply.redirect(errRedirect(returnTo, "no_access_token"));
      }
      // SDK's Credentials type uses required-but-non-null fields
      // under exactOptionalPropertyTypes; only pass keys whose value
      // is a real string / number, not null / undefined.
      oauth2Client.setCredentials({
        access_token: tokens.access_token,
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        ...(tokens.expiry_date != null && { expiry_date: tokens.expiry_date }),
        ...(tokens.scope && { scope: tokens.scope }),
      });

      // Fetch userinfo for from_address / from_name. Fetch stays raw
      // (googleapis has a userinfo endpoint but it lives in a
      // separate service package we'd need to add for one call).
      let email = "";
      let name = "";
      try {
        const uiRes = await fetch(GOOGLE_USERINFO_URL, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        if (uiRes.ok) {
          const uiJson = (await uiRes.json()) as { email?: string; name?: string };
          email = uiJson.email ?? "";
          name = uiJson.name ?? "";
        }
      } catch {
        // non-fatal — the tokens are still usable for Calendar
      }

      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : new Date(Date.now() + 3540 * 1000).toISOString();
      const scopeStr = tokens.scope ?? GOOGLE_SCOPES.join(" ");

      const shared = {
        access_token: tokens.access_token,
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        client_id: google.clientId,
        client_secret: google.clientSecret,
      };

      const connected: string[] = [];

      if (scopeStr.includes("calendar")) {
        credentials.store({
          householdId: hh.id,
          provider: "google_calendar",
          kind: "oauth2",
          label: email ? `Google Calendar (${email})` : "Google Calendar",
          credential: {
            ...shared,
            calendar_id: "primary",
            time_zone: "UTC",
          },
          scopes: scopeStr.split(/\s+/).filter((s) => s.includes("calendar")),
          expiresAt,
        });
        connected.push("google_calendar");
      }

      if (scopeStr.includes("gmail")) {
        credentials.store({
          householdId: hh.id,
          provider: "gmail",
          kind: "oauth2",
          label: email ? `Gmail (${email})` : "Gmail",
          credential: {
            ...shared,
            ...(email && { from_address: email }),
            ...(name && { from_name: name }),
          },
          scopes: scopeStr.split(/\s+/).filter((s) => s.includes("gmail")),
          expiresAt,
        });
        connected.push("gmail");
      }

      return reply.redirect(okRedirect(returnTo, connected));
    },
  );
};
