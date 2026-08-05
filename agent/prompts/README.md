# Prompts

Durable prompt templates for May's recurring flows. Each file is a
complete `--system-event` payload for an OpenClaw automation, or a
skill body loadable into her workspace.

## Why extract these

The bash snippets in `SETUP.md` inlined the prompts for convenience,
but a prompt worth iterating on shouldn't live inside a cron command.
Files in this directory:

- Can be edited without touching automation config
- Can be referenced from multiple automations
- Can be reviewed / diffed / rolled back like any other code
- Survive OpenClaw flag renames (the automation shape may change; the
  prompt content stays)

## Using a prompt from an automation

```bash
openclaw automations create \
  --cron "0 7 * * 1-5" --tz "$TZ" \
  --name "morning-brief" --session main --channel me \
  --system-event "$(cat ~/src/agent/prompts/morning-brief.md)"
```

Or the equivalent when you'd rather not shell-quote a long file — most
OpenClaw builds accept `--system-event-file`:

```bash
openclaw automations create ... \
  --system-event-file ~/src/agent/prompts/morning-brief.md
```

## Editing tips

- **Every prompt should be self-contained.** Don't rely on May
  remembering earlier prompts. Each turn is fresh context except for
  the workspace bootstrap files (`IDENTITY.md`, `SOUL.md`, `USER.md`,
  `CONSENT.md`).
- **Name recipients by role, not by identity.** "Peter's approval
  channel" not `me` — the channel name can change, the role can't.
- **Ask for the output shape you actually want.** "Under 200 words",
  "one bullet per meeting", "prose paragraphs, not lists". Explicit
  beats hopeful.
- **Iterate on real transcripts.** When a morning brief lands wrong,
  paste the actual output into the prompt file as a "don't do this"
  example and re-run. Rapid grounding beats abstract reasoning.

## Prompts in this directory

| File | Trigger | Output goes to |
|---|---|---|
| [morning-brief.md](morning-brief.md) | Cron 07:00 weekdays | Peter's Telegram (`me`) |
| [inbox-triage.md](inbox-triage.md) | Cron every 15 min, work hours | Per-owner Telegram |
| [meeting-prep.md](meeting-prep.md) | 15 min before every calendar event | Owner's Telegram |
| [email-draft.md](email-draft.md) | Invoked as-needed by other flows | Draft on the owner's account |
| [end-of-day.md](end-of-day.md) | Cron 18:00 daily | Peter's Telegram (`me`) |
