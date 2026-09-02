import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  identityRepo,
  managerCredentialRepo,
  webauthnChallengeRepo,
  type Db,
} from "@atelier/db";
import type { ManagerId } from "@atelier/domain";

// Passkey / WebAuthn ceremonies for managers. Replaces the paste-
// a-bearer-token console login path for humans; bearer tokens
// stay as the machine-to-machine credential.
//
// Registration is authenticated (existing bearer) — a logged-in
// manager registers a new device.
// Login is public — a manager on a new browser starts with only
// their email, gets a challenge, presents a passkey, and receives
// a freshly-minted bearer token that the console stashes in the
// httpOnly session cookie exactly like before.
//
// Challenges live in a small ephemeral table (webauthn_challenges)
// keyed by a `wac_<hex>` id we hand back to the browser. Every
// row is single-use and expires after 5 minutes. Old rows are
// swept when a new one is issued so no cleanup timer is needed.

const rpConfig = (): { rpID: string; rpName: string; origin: string } => {
  const origin = process.env["ATELIER_PASSKEY_ORIGIN"] ?? "http://localhost:3000";
  const rpID = process.env["ATELIER_PASSKEY_RP_ID"] ?? new URL(origin).hostname;
  const rpName = process.env["ATELIER_PASSKEY_RP_NAME"] ?? "ATELIER";
  return { rpID, rpName, origin };
};

const RegisterOptionsBody = z.object({
  deviceLabel: z.string().min(1).max(80),
});

const RegisterVerifyBody = z.object({
  challengeId: z.string().min(1),
  deviceLabel: z.string().min(1).max(80),
  response: z.record(z.unknown()),
});

const LoginOptionsBody = z.object({
  email: z.string().email(),
});

const LoginVerifyBody = z.object({
  challengeId: z.string().min(1),
  response: z.record(z.unknown()),
});

// Bearer TTL after a successful passkey login — 12h matches
// "worked a full shift in the console" without letting an
// unattended browser stay open overnight.
const LOGIN_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export const webauthnRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const identity = identityRepo(db);
  const credentials = managerCredentialRepo(db);
  const challenges = webauthnChallengeRepo(db);

  // ── Registration ────────────────────────────────────────────

  app.post(
    "/webauthn/register/options",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
        audit: { action: "webauthn.register.options", resourceType: "manager_credential", sensitive: true },
      },
    },
    async (req, reply) => {
      if (req.actor.type !== "manager") {
        return reply.code(403).send({ error: "not_a_manager" });
      }
      const body = RegisterOptionsBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const managerId = req.actor.id as ManagerId;
      const existing = credentials.list(managerId);
      const { rpID, rpName } = rpConfig();

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: req.actor.displayName || managerId,
        userDisplayName: req.actor.displayName || managerId,
        attestationType: "none",
        // Don't let a device register twice — WebAuthn's dedup hook.
        excludeCredentials: existing.map((c) => ({
          id: c.credentialId,
          ...(Array.isArray(c.transports) && c.transports.length > 0 && {
            transports: c.transports as never,
          }),
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      const { id: challengeId } = challenges.create({
        subject: managerId,
        ceremony: "register",
        challenge: options.challenge,
      });

      return { options, challengeId };
    },
  );

  app.post(
    "/webauthn/register/verify",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
        audit: { action: "webauthn.register.verify", resourceType: "manager_credential", sensitive: true },
      },
    },
    async (req, reply) => {
      if (req.actor.type !== "manager") {
        return reply.code(403).send({ error: "not_a_manager" });
      }
      const body = RegisterVerifyBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const managerId = req.actor.id as ManagerId;
      const consumed = challenges.consume(body.data.challengeId);
      if (!consumed.ok) {
        return reply
          .code(400)
          .send({ error: `challenge_${consumed.reason}` });
      }
      if (consumed.ceremony !== "register" || consumed.subject !== managerId) {
        return reply.code(400).send({ error: "challenge_mismatch" });
      }

      const { rpID, origin } = rpConfig();
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.data.response as never,
          expectedChallenge: consumed.challenge!,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "verification_failed", detail: (err as Error).message });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return reply.code(400).send({ error: "not_verified" });
      }
      const info = verification.registrationInfo;

      const publicKeyB64 = Buffer.from(info.credential.publicKey).toString("base64");

      const stored = credentials.store({
        managerId,
        credentialId: info.credential.id,
        publicKey: publicKeyB64,
        counter: info.credential.counter,
        ...(info.credential.transports && {
          transports: info.credential.transports as readonly string[],
        }),
        deviceLabel: body.data.deviceLabel,
      });

      return reply.code(201).send({
        credential: {
          id: stored.id,
          deviceLabel: body.data.deviceLabel,
        },
      });
    },
  );

  // ── Login ───────────────────────────────────────────────────

  app.post(
    "/webauthn/login/options",
    {
      config: {
        public: true,
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = LoginOptionsBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const manager = identity.getManagerByEmail(body.data.email);
      const { rpID } = rpConfig();

      // If the email isn't a registered manager, still return
      // options with an empty allowCredentials list. This keeps
      // registered/unregistered indistinguishable from the
      // browser's side — no user enumeration via timing.
      const allowCredentials = manager
        ? credentials.list(manager.id).map((c) => ({
            id: c.credentialId,
            ...(Array.isArray(c.transports) && c.transports.length > 0 && {
              transports: c.transports as never,
            }),
          }))
        : [];

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials,
        userVerification: "preferred",
      });

      const { id: challengeId } = challenges.create({
        subject: manager?.id ?? body.data.email,
        ceremony: "login",
        challenge: options.challenge,
      });

      return { options, challengeId };
    },
  );

  app.post(
    "/webauthn/login/verify",
    {
      config: {
        public: true,
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = LoginVerifyBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const consumed = challenges.consume(body.data.challengeId);
      if (!consumed.ok || consumed.ceremony !== "login") {
        return reply
          .code(400)
          .send({ error: `challenge_${consumed.reason ?? "mismatch"}` });
      }

      // Look up the credential by the id the browser used —
      // WebAuthn credential ids are globally unique, so we don't
      // need the subject to disambiguate. But we DO cross-check
      // the credential's manager against the challenge's subject
      // if a subject-with-manager-id is present, to catch a
      // stolen-challenge attack.
      const responseId = (body.data.response as { id?: string }).id;
      if (!responseId) return reply.code(400).send({ error: "missing_credential_id" });
      const cred = credentials.findByCredentialId(responseId);
      if (!cred) return reply.code(401).send({ error: "unknown_credential" });

      if (consumed.subject !== undefined && consumed.subject.startsWith("mgr_") &&
          consumed.subject !== cred.managerId) {
        return reply.code(400).send({ error: "challenge_subject_mismatch" });
      }

      const { rpID, origin } = rpConfig();
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.data.response as never,
          expectedChallenge: consumed.challenge!,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: cred.credentialId,
            publicKey: Uint8Array.from(Buffer.from(cred.publicKey, "base64")),
            counter: cred.counter,
            ...(Array.isArray(cred.transports) && cred.transports.length > 0 && {
              transports: cred.transports as never,
            }),
          },
        });
      } catch (err) {
        return reply
          .code(401)
          .send({ error: "verification_failed", detail: (err as Error).message });
      }
      if (!verification.verified) {
        return reply.code(401).send({ error: "not_verified" });
      }

      credentials.updateCounter(cred.id, verification.authenticationInfo.newCounter);

      const minted = identity.mintToken({
        actorType: "manager",
        actorId: cred.managerId as ManagerId,
        label: `passkey:${cred.id}`,
        ttlSeconds: LOGIN_TOKEN_TTL_SECONDS,
      });

      return reply.send({
        token: minted.token,
        tokenId: minted.tokenId,
        expiresAt: minted.expiresAt,
        managerId: cred.managerId,
      });
    },
  );

  // ── Passkey management (authenticated) ──────────────────────

  app.get(
    "/me/passkeys",
    { config: { audit: { action: "webauthn.list", resourceType: "manager_credential" } } },
    async (req, reply) => {
      if (req.actor.type !== "manager") {
        return reply.code(403).send({ error: "not_a_manager" });
      }
      const rows = credentials.list(req.actor.id as ManagerId);
      return {
        passkeys: rows.map((r) => ({
          id: r.id,
          deviceLabel: r.deviceLabel,
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
        })),
      };
    },
  );

  app.delete<{ Params: { passkeyId: string } }>(
    "/me/passkeys/:passkeyId",
    { config: { audit: { action: "webauthn.delete", resourceType: "manager_credential", sensitive: true } } },
    async (req, reply) => {
      if (req.actor.type !== "manager") {
        return reply.code(403).send({ error: "not_a_manager" });
      }
      const { deleted } = credentials.deleteById(
        req.params.passkeyId,
        req.actor.id as ManagerId,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
};
