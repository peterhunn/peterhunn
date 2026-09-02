# ATELIER Platform

Codename `ATELIER` — the working software for the Life Management service.

All documentation now lives in [`/docs`](../docs/README.md) at the repository
root. That folder is the single source of truth for the business model, the
architecture, the security posture, deployment, and every operator runbook.

## Quick start

```
pnpm install
pnpm --filter @atelier/db migrate:generate
pnpm --filter @atelier/db migrate:apply
pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts
pnpm --filter @atelier/api dev       # api on :3001
pnpm --filter @atelier/console dev   # console on :3000
```

Open http://localhost:3000, paste the token the seed script printed, and
you're inside the console. Full walkthroughs and the environment reference
are in [`/docs/21-repository.md`](../docs/21-repository.md) and
[`/docs/51-environment.md`](../docs/51-environment.md).
