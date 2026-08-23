# Deploy — ATELIER API

The API ships as a single container to [fly.io](https://fly.io).
Console (Next.js) is not deployed by this config yet; it stays local
until we're ready to point it at a real API URL.

## Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed
  and logged in (`fly auth login`).
- A fly organization + app name that isn't taken (`atelier-api` in
  the config; change if needed).

## First deploy

```bash
cd platform

# 1. Provision the app + volume without deploying yet. --copy-config
#    tells fly to reuse the committed fly.toml instead of prompting.
fly launch --no-deploy --name atelier-api --region sea --copy-config

# 2. One SQLite volume, 1GB, in the same region as the app.
fly volumes create atelier_data --size 1 --region sea

# 3. Set secrets. ATELIER_CREDENTIAL_KEY is REQUIRED — the API
#    refuses to start without it. Everything else is optional
#    (unset providers fall back to a mock with a visible reason).
fly secrets set \
  ATELIER_CREDENTIAL_KEY=$(openssl rand -hex 32) \
  ATELIER_OAUTH_STATE_SECRET=$(openssl rand -hex 32) \
  ANTHROPIC_API_KEY=... \
  OPENAI_API_KEY=... \
  GOOGLE_API_KEY=... \
  GOOGLE_OAUTH_CLIENT_ID=... \
  GOOGLE_OAUTH_CLIENT_SECRET=... \
  GOOGLE_OAUTH_REDIRECT_URI=https://atelier-api.fly.dev/oauth/google/callback \
  ATELIER_TWILIO_AUTH_TOKEN=...

# 4. Deploy.
fly deploy
```

`fly deploy` builds the Dockerfile at `apps/api/Dockerfile` against
the `platform/` build context. On success it rolls out a single
machine attached to the `atelier_data` volume. `fly status` shows
health.

## Verifying

```bash
fly status
curl https://atelier-api.fly.dev/healthz
fly logs
```

`/healthz` is public and cheap. Everything else requires a bearer
token — mint one with `pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts`
locally, or seed against the fly SSH shell:

```bash
fly ssh console
cd /app
pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts
```

## Updating

```bash
git push  # CI runs typecheck + test on the branch
fly deploy  # ships the current HEAD's Dockerfile build
```

## Rotating ATELIER_CREDENTIAL_KEY

The master key wraps every stored credential (Google refresh
tokens, Twilio auth tokens, anything the platform holds on the
customer's behalf) with AES-256-GCM. Rotate on suspected
exposure — or on a schedule.

Zero-downtime rotation isn't wired yet. Today rotation looks
like:

```bash
# 1. Generate the new key locally, keep the old one handy.
NEW_KEY=$(openssl rand -hex 32)

# 2. Set NEW_KEY as the primary. The API will fail to decrypt
#    existing rows — this is a brief outage until step 3 runs.
fly secrets set ATELIER_CREDENTIAL_KEY=$NEW_KEY
fly deploy

# 3. Re-encrypt every row with the new key. Bounce into an SSH
#    console on the machine that holds the OLD key, or ship a
#    one-shot job that reads OLD_KEY + NEW_KEY. This is a
#    follow-up — the current migrateLegacyRows() only upgrades
#    plaintext, not old-encrypted → new-encrypted.
```

Losing the key = every stored credential becomes
unrecoverable. Every household re-connects Google, re-enters
Twilio, etc. Treat it like a database.

## Notes

- **SQLite in production is a phase-0 choice.** The schema is
  portable to Postgres; when traffic warrants it, provision a
  fly Postgres cluster and swap the client factory in
  `packages/db/src/client.ts` to use `drizzle-orm/postgres-js`.
- **Single-machine deploy.** The scheduler holds an in-process
  in-flight flag; running two machines would double-fire the
  syncs. Stay at `min_machines_running = 1` until the scheduler
  moves to a distributed lock (Redis, Postgres advisory lock).
- **Backups.** `fly volumes` snapshots the SQLite file at your
  configured cadence. Schedule at least daily
  (`fly volumes update atelier_data --snapshot-retention 30`).
- **Secrets rotation.** `fly secrets set NAME=new` triggers a
  restart; rotating `ATELIER_OAUTH_STATE_SECRET` invalidates
  in-flight consent redirects (15-min TTL anyway).
