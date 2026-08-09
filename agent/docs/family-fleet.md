# Family setup with Fleet

Pointing everyone at one OpenClaw instance is the wrong shape — OpenClaw
is built for **one trusted operator per Gateway**. Sessions route traffic;
they don't authorize one family member against another. Practical
translation: kids would see your inbox.

The right shape is `openclaw fleet` (docs: `docs/gateway/multi-tenant-hosting.md`
in the OpenClaw fork). Each family member gets a **cell**: a full Gateway
in a hardened container, isolated state, isolated credentials, its own
Gmail/GCal OAuth, its own Telegram bot. All cells run on the same Mac
host and share the underlying Ollama daemon, so model weights load once.

Fleet needs Docker or Podman on the host. On a Mac, install
[OrbStack](https://orbstack.dev) (free personal use, lighter than Docker
Desktop) or Docker Desktop.

## Provisioning cells

```bash
openclaw fleet create peter
openclaw fleet create partner
openclaw fleet create kid1
openclaw fleet create kid2
openclaw fleet ls
```

Each `create` prints a Gateway token **once** — store it in your password
manager, you can't recover it later. Each cell publishes to
`127.0.0.1:<allocated-port>` on the host; use `openclaw fleet ls` to see
which port belongs to whom.

Each cell then goes through its own bring-up (its own `openclaw onboard`,
its own `gog auth add`, its own Telegram bot). Yes it's repetitive; that
isolation is the point.

## Kids' cells: strip the sharp edges

For each kid cell, disable the tools that can send email, spend money, or
touch the shell:

```bash
openclaw --cell kid1 extensions disable openshell
openclaw --cell kid1 extensions disable gog          # or restrict to read-only
openclaw --cell kid1 extensions disable webhooks
openclaw --cell kid1 config set tools.email.send.mode "draft-only"
```

Constrain their automations to homework/reminders/summaries — nothing
that reaches outside the house. Consider a smaller model tag for kids
(`gemma4` vs `gemma4:27b`) — less overkill, less memory, still capable.

## Shared family state

Don't try to share memory *between* cells. Share **systems of record**
instead: a shared Google Family Calendar, a shared Google Doc for the
weekly plan, a shared Sheet for chores/allowance. Each cell reaches
those through its own OAuth. Private assistants, shared source of truth.

## Backup + encryption

- Cell state lives under `<state-dir>/fleet/cells/<name>/` — covered by
  Time Machine if you have it on.
- Turn on **FileVault** (System Settings → Privacy & Security → FileVault).
  Non-negotiable if the Mac is a family device.
- Auth-profile secrets are under
  `<state-dir>/fleet/auth-profile-secrets/<tenant>/` — same backup story.

## Fleet is experimental

The Fleet CLI is flagged experimental in the OpenClaw docs — commands
and flags can change between releases without a deprecation window. Fine
for a family; wouldn't run a business on it.
