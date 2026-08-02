# Roadmap

Future capabilities for May, captured in enough detail that when it's
time to build one, the architectural decisions are already made and
you're just executing.

**Do not start any of these until base May has run stably for at least
four weeks** (morning brief, family EA email, Obsidian second brain,
verified local-only). Adding capability on top of an unproven base is
how the whole stack becomes untrustworthy.

## Items

| Item | Status | Prerequisites | ETA |
|---|---|---|---|
| [Money agent](money-agent.md) — bills, groceries, subscriptions | Planned | Base stable ≥ 4 weeks | Month 2+ |
| [Smart home](smart-home.md) — Google Home + Rainbird via Home Assistant | Planned | Base stable, Home Assistant deployed | Month 2+ |

## How to add a roadmap item

Copy the shape of an existing file. Every roadmap item includes:

1. **What it is** — one paragraph, plain English
2. **Why not now** — the specific prerequisites that must exist first
3. **Layers of maturity** — passive → assisted → autonomous, so you can
   start with the safe layer and grow trust
4. **Architecture** — how it plugs into May (MCP server, HTTP tool,
   extension), what caps and guardrails apply
5. **Manual steps** — the browser clicks, device setup, or admin work
   that scripts can't do
6. **When it fails** — realistic failure modes and their recovery paths
