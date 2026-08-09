# Personal automation quickstart

Background + rationale for the automations wired in
[`../SETUP.md`](../SETUP.md) steps 4-6. The setup doc has the exact
commands; this doc explains why they look the way they do and shows the
alternative shapes.

Ingredients: **Gmail + Google Calendar** via the `gog` skill, **Telegram**
as the assistant→you channel (free, works on iOS/Android/desktop), and
**OpenClaw automations** for scheduling.

Swap Telegram for Signal, Matrix, iMessage, or Discord — same shape.
Swap `gog` for `himalaya` if you're on Fastmail / Proton / iCloud / IMAP.

## Morning brief — 07:00 every weekday

Reads today's calendar + overnight unread mail, hands both to Gemma to
summarize, DMs the result on Telegram. The prompt is
[`../prompts/morning-brief.md`](../prompts/morning-brief.md) so you can
iterate without touching the automation config:

```bash
TZ="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"
openclaw automations create \
  --cron "0 7 * * 1-5" --tz "$TZ" \
  --name "morning-brief" --session main --channel me \
  --system-event "$(cat ~/src/agent/prompts/morning-brief.md)"
```

## Inbox triage — every 15 min during work hours

Reuses the bundled `taskflow-inbox-triage` skill pattern: classify → route.
Prompt is [`../prompts/inbox-triage.md`](../prompts/inbox-triage.md):

```bash
openclaw automations create \
  --cron "*/15 9-18 * * 1-5" --tz "$TZ" \
  --name "inbox-triage" --session main --channel me \
  --system-event "$(cat ~/src/agent/prompts/inbox-triage.md)"
```

For near-realtime instead of every-15-minutes, swap the cron for the
**Gmail PubSub** trigger (`docs/automation/cron-jobs.md#gmail-pubsub-integration`
in the OpenClaw fork). Google Pub/Sub is free at personal message volumes.

## Draft-and-send guardrail

`gog` supports drafts. Any automation that composes on your behalf
should create a draft first and Telegram you the draft id, then a
`send` command you can execute or approve:

```bash
gog gmail drafts create --to a@b.com --subject "Re: Hi" --body-file -
gog gmail drafts send <draftId>
```

The `himalaya` SKILL enforces the same "confirm before send/delete/move"
rule; keep that guardrail on until you trust the model's judgement.

## Verifying everything is local

```bash
openclaw models list --provider ollama       # should show gemma4
openclaw extensions list                     # only local + gog/himalaya/telegram
openclaw automations list                    # your morning-brief + inbox-triage
lsof -i -n | grep -i 'ollama\|openclaw'      # only loopback sockets
```

If `lsof` shows the agent talking to `*.openai.com`, `*.anthropic.com`,
or any other cloud endpoint, an extension slipped through — disable it
with `openclaw extensions disable <id>` and rerun.
