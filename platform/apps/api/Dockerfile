# ATELIER API — multi-stage build for the Fastify service.
#
# The workspace packages point their `main` at ./src/index.ts so
# they resolve straight through TS in dev. We keep that in prod too
# and run the API through tsx — cheap enough for phase-0 traffic and
# avoids maintaining a parallel `main -> dist/index.js` field on
# every package. When throughput warrants it, add a real tsc build.
#
# Build context is the platform/ directory (see fly.toml).

# ── deps ───────────────────────────────────────────────────────────
FROM node:20.11-alpine AS deps
RUN apk add --no-cache python3 make g++ libc6-compat
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/console/package.json ./apps/console/
COPY packages/agents/package.json ./packages/agents/
COPY packages/db/package.json ./packages/db/
COPY packages/domain/package.json ./packages/domain/
COPY packages/policy/package.json ./packages/policy/
COPY packages/router/package.json ./packages/router/
COPY scripts/package.json ./scripts/ 2>/dev/null || true
RUN pnpm install --no-frozen-lockfile

# ── migrations ─────────────────────────────────────────────────────
# Emit the drizzle SQL from the schema so the runtime image can
# apply them before serving traffic. Kept in its own stage so the
# node_modules layer above stays cacheable.
FROM deps AS migrations
COPY packages/db ./packages/db
RUN pnpm --filter @atelier/db migrate:generate

# ── runtime ────────────────────────────────────────────────────────
FROM node:20.11-alpine AS runtime
RUN apk add --no-cache libc6-compat tini
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
# SQLite lives under packages/db/data — a fly volume mounts here.
ENV ATELIER_DB_URL=/app/packages/db/data/atelier.db
# Document blobs share the same volume mount so backups cover the
# database + the uploaded files together.
ENV ATELIER_BLOB_DIR=/app/packages/db/data/blobs

# Bring the installed workspace + source over. We copy source (not
# dist) because tsx is the runtime — see the file header.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=migrations /app/packages/db ./packages/db
COPY apps/api ./apps/api
COPY packages/agents ./packages/agents
COPY packages/domain ./packages/domain
COPY packages/policy ./packages/policy
COPY packages/router ./packages/router
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# fly deploys can restart on any signal; tini forwards SIGTERM so
# our graceful shutdown (scheduler.stop + app.close) actually runs.
ENTRYPOINT ["/sbin/tini", "--"]

EXPOSE 3001
CMD ["pnpm", "--filter", "@atelier/api", "start"]
