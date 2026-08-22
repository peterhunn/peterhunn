# Contributing

Read `ARCHITECTURE.md` first — every recipe below assumes those
invariants. Then pick the change you're making:

- Adding a node type to the ontology → §1
- Adding a first-class agent → §2
- Adding a tool → §3
- Adding a provider adapter → §4
- Adding a route → §5
- Adding a repository → §6
- Changing a schema → §7
- Adding a playbook → §8
- Writing tests → §9

## 1. Add a node type

Node types are a closed set registered in
`packages/domain/src/entities.ts`.

1. Author a Zod schema for the data shape (colocated with its
   Accord category block — Participants, Assets, Concepts,
   Events, Transactions).
2. Add an entry to `NODE_TYPE_SPECS`:

   ```ts
   "my.new.type": spec("asset", MyNewTypeData),
   ```

   `spec(category, schema)` is the helper. The category drives
   the by-category route, the CTO exporter, and future generic
   surfaces — pick it deliberately.
3. **Do not** touch `NodeTypeSchemas` — it's a back-compat
   projection over `NODE_TYPE_SPECS`.
4. Add a category test if the type belongs to an existing
   category test group (`packages/domain/test/categories.test.ts`).
5. Regenerate the CTO artifact if you distribute it:
   `pnpm --filter @atelier/domain generate:cto`.

## 2. Add a first-class agent

1. Create `packages/agents/src/agents/<name>.ts`. Export an
   object satisfying the `Agent` interface (`handles(intent)`,
   `handle(intent, ctx)`).
2. Export it from `packages/agents/src/index.ts`.
3. Register it in the orchestrator constructor in
   `apps/api/src/runtime.ts` (the `agents:` array).
4. If the agent makes model calls, register any new task class
   in `packages/router/src/registry.ts` with tier + provider
   preferences. Follow the existing rows.
5. If the agent needs a tool, follow §3.
6. Add a test that spins up an in-memory orchestrator, feeds an
   intent, asserts the outputs shape.

## 3. Add a tool

1. Create `packages/agents/src/tools/<name>.ts`. Export an
   object satisfying `Tool<Inputs, Outputs>`.
2. Declare:
   - `sideEffectClass` — one of `read`, `write_reversible`,
     `write_hard`, `communication`, `financial_hazardous`. The
     policy evaluator uses this.
   - `actionClass` — a fully-qualified verb (`vendor.schedule`,
     `calendar.appointment.create`). Rolling limits key on this.
   - `version` — bump when the input/output shape or the
     side-effect semantics change.
3. Real integrations must ship with a mock fallback path. Every
   mock response stamps `provider: "mock"` and a `reason`.
4. Register the tool in `apps/api/src/runtime.ts` in
   `buildToolRegistry()`.
5. Author policies that grant the household authority (seed
   script or a manager-facing UI).

## 4. Add a provider adapter

1. Add `packages/router/src/providers/<name>.ts`. Implement the
   `Provider` interface: `call(deps, request)` returns a
   `ProviderResponse`.
2. Model calls flow through `packages/router/src/call.ts` which
   records to the `model_calls` ledger — tokens (in/out/cached/
   cache_write), latency, cost estimate, finish reason. All
   fields required.
3. Register in `packages/router/src/registry.ts` — add one row
   per model with tier, provider name, task classes the model
   is preferred for.
4. Real adapter reads its API key from env; missing key falls
   back to the mock adapter with a visible reason. Never leave
   a missing-key path silent.

## 5. Add a route

1. New file under `apps/api/src/routes/<name>.ts`. Export
   `<name>Routes(db): FastifyPluginAsync`.
2. Register in `apps/api/src/server.ts`.
3. Every household-scoped route uses the `:householdId`
   parameter and reads `req.householdContext` inside the
   handler (never `req.params.householdId` directly — the auth
   plugin does the grant check when it sets the context).
4. Public routes (webhooks, health) tag `config: { public: true }`.
5. Every household-scoped route names an audit action:
   `config: { audit: { action: "...", resourceType: "...",
   sensitive?: true } }`. The audit plugin uses this to write
   the `audit_events` row.
6. Validate request bodies with Zod. Return 400 with
   `{ error, issues }` on parse failure.
7. Errors from downstream tools are surfaced as `{ error,
   detail }` on the appropriate status — never leak a stack
   trace.

## 6. Add a repository

1. New file under `packages/db/src/repositories/<name>.ts`.
   Export a factory `(<name>Repo(db) => { ... })`.
2. Every method that touches a household-scoped table takes a
   `HouseholdId` argument and filters on it. If you add a method
   that doesn't, tenancy is broken.
3. Never expose secret material from list/read methods that
   the API might return. Metadata only. Raw blobs are a
   `getSecret` variant that lives on the server side only.
4. Re-export from `packages/db/src/index.ts`.
5. If the repo needs a new table, follow §7.

## 7. Change a schema

1. Edit or add a file under `packages/db/src/schema/`.
2. Re-export from `packages/db/src/schema/index.ts`.
3. Regenerate migrations:
   `pnpm --filter @atelier/db migrate:generate`.
4. Commit both the schema file and the generated migration
   SQL. **Do not** rely on CI to regenerate — the artifact is
   part of the review.
5. Non-additive migrations (rename, drop, retype) need a
   deploy plan in the PR body: how do existing rows migrate?
   Is there downtime? The current SQLite deploy pattern is
   simple — new schema + apply migrations + restart — but
   drops that lose data need explicit approval.

## 8. Add a playbook

1. Author the `PlaybookDefinition` in
   `packages/agents/src/playbooks.ts`. Declare id, name,
   description, domain, schedule (weekly | monthly |
   interval_hours), default config, and `buildIntent(config)`.
2. Register in the same file's `buildPlaybookRegistry()`.
3. Test the schedule ceiling behavior if it's a new shape.
4. Seed-enable it if it's high-value for a fresh clone.

## 9. Tests

- Vitest across every package. `pnpm test` runs the whole tree.
- Network mocking: **use msw**. `vi.stubGlobal("fetch")` only
  works for raw fetch call sites — it doesn't intercept axios
  (twilio SDK) or gaxios (googleapis SDK). msw catches all
  three at the socket layer. See any `.test.ts` in
  `packages/agents/test/` for the pattern.
- API tests use `buildServer(db)` with an in-memory SQLite and
  `app.inject(...)` to fire requests. Migrations apply at
  `beforeAll`.
- Set `onUnhandledRequest: "error"` on the msw server so a
  missing handler surfaces as a test failure rather than a
  silent live call. Use `"bypass"` only for tests that expect
  incidental network activity we don't care to stub (currently
  just the messaging integration test's planner side).

## Style

- No emojis in code or committed docs unless explicitly asked.
- Comments explain the *why* (a hidden constraint, a subtle
  invariant, a specific bug workaround). Well-named identifiers
  do the *what*.
- No feature flags or backwards-compat shims when a direct
  change will do — the codebase is early enough to move things.
- Prefer editing existing files over creating new ones.
- Never introduce a fallback for a scenario that can't happen.
  Validate at system boundaries, trust internal code.

## Commit messages

- One subject line summarizing the change. Present tense.
- Body: what changed, why, and what the caveats are.
- If tests are added: name what they cover.
- If a security-shaped invariant is touched: cross-reference
  the SECURITY.md item.
- Never commit secrets. If you accidentally do,
  `git rm --cached` isn't enough — rotate the secret, then
  amend the history.
