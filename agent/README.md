# agent

A local-first personal AI agent built on a fork of
[OpenClaw](https://github.com/openclaw/openclaw), pointed at a small language
model running on your own Mac via [Ollama](https://ollama.com).

No cloud model. No subscription. Your prompts, your context, your model.

## What you need

- A Mac (Apple Silicon strongly recommended — 16 GB RAM minimum for a 7B model,
  32 GB+ if you want to go bigger).
- A GitHub account, and a fork of `openclaw/openclaw` under your own account.
  Fork it in the browser — this script clones from your fork so any
  customizations you push land in your own repo.
- Homebrew (the script installs it if missing).

## Quick start

```bash
# 1. Fork https://github.com/openclaw/openclaw in the GitHub UI.

# 2. Run bootstrap, pointing it at your fork.
export OPENCLAW_FORK=https://github.com/<you>/openclaw.git
export SLM_MODEL=gemma4                  # any Ollama-hosted model tag
./bootstrap-mac.sh
```

That's it. When it finishes, `openclaw` is on your `PATH`, Ollama is running
in the background serving `$SLM_MODEL`, and the agent is wired to talk to it
locally.

## Picking a model

The bootstrap defaults to `gemma4` — OpenClaw's own suggested default,
tool-calling capable, ≥16K context, comfortable on a 16 GB Mac. Some other
reasonable choices:

| Model tag              | Approx RAM | Notes                              |
| ---------------------- | ---------- | ---------------------------------- |
| `gemma4`               | ~8 GB      | Default. Google SLM, well-rounded. |
| `gemma4:27b`           | ~20 GB     | Bigger Gemma; needs 32 GB+ Mac.    |
| `qwen2.5-coder:7b`     | ~8 GB      | Code-tuned alternative.            |
| `qwen2.5-coder:14b`    | ~14 GB     | Stronger reasoning; 32 GB Mac.     |
| `llama3.2:3b`          | ~3 GB      | Tiny + fast, weaker at code.       |
| `deepseek-r1:14b`      | ~14 GB     | Reasoning-tuned distill.           |

The requirement OpenClaw enforces during onboarding is **tool-calling
support** plus a **≥16K context window**. Any tag missing either metadatum is
skipped by the auto-picker but can still be selected manually.

## Files

- `bootstrap-mac.sh` — one-shot installer + runner.
- `openclaw.example.jsonc` — provider config snippet that pins the local
  Ollama endpoint and your chosen model. Copy into your OpenClaw config dir
  (`~/Library/Application Support/openclaw/`) if you want to skip the
  interactive onboarding wizard entirely.

## Zero-fee configuration

OpenClaw itself is MIT-licensed and free. Every recurring cost comes from
optional third-party integrations bundled as providers/extensions. To pay
nothing beyond hardware and electricity, **disable** the paid surfaces below
and **enable only** the local set.

### Disable — paid cloud model providers

Every provider in `docs/providers/` **except** the local runtimes listed
further down is either metered per-token or requires a paid API key.
Disable the extensions with the same names under `extensions/`:

- Frontier LLMs: `openai`, `anthropic`, `anthropic-vertex`, `google`,
  `xai`, `deepseek`, `mistral`, `cohere`, `meta`, `qwen`, `moonshot`,
  `zai`, `longcat`, `minimax`, `stepfun`
- Inference marketplaces: `openrouter`, `together`, `fireworks`, `groq`,
  `cerebras`, `deepinfra`, `baseten`, `gmi`, `novita`, `chutes`, `arcee`,
  `synthetic`, `venice`, `kilocode`, `perplexity`
- Cloud-only wrappers: `ollama-cloud`, `clawrouter`, `vercel-ai-gateway`,
  `cloudflare-ai-gateway`, `github-copilot`, `copilot`, `copilot-proxy`,
  `opencode` (cloud variant)
- Hosted embeddings: `voyage`
- Regional clouds: `bedrock`, `bedrock-mantle`, `microsoft-foundry`,
  `alibaba`, `tencent`, `volcengine`, `qianfan`, `xiaomi`, `byteplus`

### Disable — paid speech, image, video, audio

- Speech-to-text / TTS: `azure-speech`, `deepgram`, `elevenlabs`,
  `fish-audio`, `inworld`, `senseaudio`
- Image / video / music generation: `fal`, `runway`, `pixverse`,
  `pixverse`, `vydra`
- Web/search APIs: `brave`, `exa`, `firecrawl`, `tavily`

### Disable — channels with per-message fees

Most channels are free. These have real per-message costs:

- `sms` (Twilio) — per SMS
- `voice-call` (Twilio) — per minute
- `whatsapp` — Meta Business API session/conversation fees
- `zoom-meetings`, `teams-meetings`, `google-meet` — often require
  paid workspace tiers to hit the APIs

Free channels you can keep: `slack`, `discord`, `telegram`, `matrix`,
`signal`, `imessage`, `irc`, `nostr`, `webhooks`, and the built-in WebChat.

### Disable — hosted deploy targets

Delete or ignore `fly.toml`, `render.yaml`, and anything under `deploy/`
targeting a paid host. Run OpenClaw on your Mac (or a homelab box) via the
Docker Compose file or directly.

### Keep — the free local stack

- **Model runtimes:** `ollama`, `lmstudio`, `llama-cpp`, `vllm`, `sglang`,
  `comfy` (self-hosted image gen)
- **Search:** `duckduckgo`, `searxng` (self-hosted)
- **Local speech:** `tts-local-cli`, `talk-voice`
- **Memory / RAG:** `memory-core`, `memory-lancedb`, `memory-wiki`
  (embeddings via your Ollama model — no external calls)
- **Local tools:** `browser`, `cua-computer`, `openshell`, `document-extract`,
  `web-readability`
- **Observability (free if self-hosted):** `diagnostics-otel`,
  `diagnostics-prometheus` — point them at a local collector, not a
  vendor endpoint
- **Secrets:** `vault`, `onepassword` (no fee unless you already pay for 1P)

### The one-line rule

If an extension's `README.md` mentions "API key", "usage-based pricing",
"free tier", or a vendor dashboard URL — assume it costs money and leave
it disabled. If it only mentions a local port/binary/socket, it's free.

### Config sketch

OpenClaw loads extensions dynamically. Rather than allow everything and
prune, invert it: allowlist. In your `config.jsonc`, keep only the
extensions listed under **Keep** above. On first run:

```bash
openclaw extensions list          # see what's enabled
openclaw extensions disable <id>  # per-extension teardown
```

`openclaw doctor --fix` will flag any config referring to a provider
whose extension you've disabled.

## Personal automation quickstart

Once `bootstrap-mac.sh` finishes, this is the recipe for turning it into a
real assistant that reads your email, watches your calendar, and pings you
on your phone — all local, zero recurring fees.

Ingredients: **Gmail + Google Calendar** via the `gog` skill, **Telegram**
as the assistant→you channel (free, works on iOS/Android/desktop), and
**OpenClaw automations** for scheduling.

Swap Telegram for Signal, Matrix, iMessage, or Discord — same shape.
Swap `gog` for `himalaya` if you're on Fastmail / Proton / iCloud / IMAP.

### 1. Install the two CLIs

```bash
brew install gogcli himalaya    # only install the one you need
```

### 2. Authorize Google Workspace (free OAuth)

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   personal project, enable **Gmail API** and **Google Calendar API**, and
   create an **OAuth 2.0 Client ID** of type "Desktop". Download the
   `client_secret.json`. All of this is free.
2. Authorize `gog` once:
   ```bash
   gog auth credentials ~/Downloads/client_secret.json
   gog auth add you@gmail.com --services gmail,calendar
   gog auth list
   ```

Sanity check:

```bash
gog gmail search 'newer_than:1d' --max 5
gog calendar events primary --from "$(date -Iseconds)" --to "$(date -v+7d -Iseconds)"
```

### 3. Wire up Telegram as your notification channel

1. Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`,
   copy the token.
2. Message your new bot once so it can DM you back, then find your chat id
   (open `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. Add the channel to OpenClaw:
   ```bash
   openclaw channels add telegram
   # follow prompts: paste token, paste chat id, name it "me"
   openclaw channels list
   ```

Test it:

```bash
openclaw send --channel me "Hello from local Gemma."
```

### 4. Morning brief — 07:00 every weekday

One automation that reads today's calendar + overnight unread mail, hands
both to Gemma to summarize, and DMs you the result on Telegram.

```bash
openclaw automations create \
  --cron "0 7 * * 1-5" --tz "$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')" \
  --name "morning-brief" \
  --session main \
  --channel me \
  --system-event "Produce my morning brief:
    - Today's calendar via: gog calendar events primary --from <today> --to <tomorrow>
    - Unread mail since 6pm yesterday via: gog gmail search 'is:unread newer_than:14h' --max 25
    Return: (1) top 3 meetings with prep notes, (2) mail worth acting on today,
    (3) anything I said I'd follow up on. Keep it under 200 words."
```

### 5. Inbox triage — every 15 minutes during work hours

Reuses the bundled `taskflow-inbox-triage` skill pattern: classify → route.

```bash
openclaw automations create \
  --cron "*/15 9-18 * * 1-5" --tz "$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')" \
  --name "inbox-triage" \
  --session main \
  --channel me \
  --system-event "Run skills/taskflow-inbox-triage over new mail (newer_than:20m).
    Business threads: draft a reply and Telegram me for approval before sending.
    Personal + urgent: Telegram me now.
    Everything else: hold for the 6pm end-of-day summary."
```

For near-realtime instead of every-15-minutes, swap the cron for the
**Gmail PubSub** trigger — see `docs/automation/cron-jobs.md#gmail-pubsub-integration`
in the fork. Google Pub/Sub is free at personal message volumes.

### 6. Draft-and-send loop (safe by default)

`gog` supports drafts. Any automation that composes on your behalf should
create a draft first and Telegram you the draft id, then a `send` command
you can execute or approve:

```bash
gog gmail drafts create --to a@b.com --subject "Re: Hi" --body-file -
gog gmail drafts send <draftId>
```

The `himalaya` SKILL enforces the same "confirm before send/delete/move"
rule; keep that guardrail on until you trust the model's judgement.

### 7. Verifying everything is local

```bash
openclaw models list --provider ollama       # should show gemma4
openclaw extensions list                     # should show only local + gog/himalaya/telegram
openclaw automations list                    # your morning-brief + inbox-triage
lsof -i -n | grep -i 'ollama\|openclaw'      # only loopback sockets, no outbound https
```

If `lsof` shows the agent talking to `*.openai.com`, `*.anthropic.com`,
or any other cloud endpoint, an extension slipped through — disable it
with `openclaw extensions disable <id>` and rerun.

## Family setup with Fleet

Pointing everyone at one OpenClaw instance is the wrong shape — OpenClaw is
built for **one trusted operator per Gateway**. Sessions route traffic;
they don't authorize one family member against another. Practical
translation: kids would see your inbox.

The right shape is `openclaw fleet` (docs: `docs/gateway/multi-tenant-hosting.md`).
Each family member gets a **cell**: a full Gateway in a hardened
container, isolated state, isolated credentials, its own Gmail/GCal OAuth,
its own Telegram bot. All cells run on the same Mac host and share the
underlying Ollama daemon, so model weights load once.

Fleet needs Docker or Podman on the host. On a Mac, install
[OrbStack](https://orbstack.dev) (free personal use, lighter than Docker
Desktop) or Docker Desktop.

### Provisioning cells

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

### Kids' cells: strip the sharp edges

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

### Shared family state

Don't try to share memory *between* cells. Share **systems of record**
instead: a shared Google Family Calendar, a shared Google Doc for the
weekly plan, a shared Sheet for chores/allowance. Each cell reaches
those through its own OAuth. Private assistants, shared source of truth.

### Backup + encryption

- Cell state lives under `<state-dir>/fleet/cells/<name>/` — covered by
  Time Machine if you have it on.
- Turn on **FileVault** (System Settings → Privacy & Security → FileVault).
  Non-negotiable if the Mac is a family device.
- Auth-profile secrets are under
  `<state-dir>/fleet/auth-profile-secrets/<tenant>/` — same backup story.

### Fleet is experimental

The Fleet CLI is flagged experimental in the docs — commands and flags
can change between releases without a deprecation window. Fine for a
family; wouldn't run a business on it.

## Calling external agents (MCP)

OpenClaw can hand work off to other agents you (or someone else) built.
Three interop paths — pick based on what the other agent already speaks:

| Path | Package | When to use |
|---|---|---|
| **MCP server** | `mcp-http` | Recommended default. Standard protocol, works with everything (Claude Desktop, Cursor, ChatGPT desktop, etc.) without rewriting. |
| **ACP** | `acp-core` | OpenClaw's peer-to-peer agent protocol. Use when you want bidirectional conversation between agents, not just tool calls. |
| **Plain HTTP tool** | `plugin-sdk` | Fastest. Wrap any existing REST endpoint as a custom tool. |

### Example: your trading agent

Assuming your trading agent exposes an MCP server on `127.0.0.1:8710` with
tools `get_positions`, `propose_trade`, `execute_order`:

```jsonc
// ~/Library/Application Support/openclaw/config.jsonc
{
  "mcp": {
    "servers": {
      "trader": {
        "transport": "http",
        "url": "http://127.0.0.1:8710",
        "toolsAllowed": ["get_positions", "propose_trade", "execute_order"]
      }
    }
  }
}
```

Then in a chat / automation:

```
you (Telegram)  →  OpenClaw (Gemma 4 parses intent, drafts proposal)
                →  trader.propose_trade({...})
                →  OpenClaw asks you on Telegram: "Sell 100 AAPL @ market, confirm?"
                →  you: "yes"
                →  trader.execute_order(proposalId, confirmationToken)
```

### Non-negotiable trading guardrails

Same shape as the draft-first email pattern, higher stakes:

- **Two-call design**: `propose_trade` returns a signed proposal id;
  `execute_order` requires that id **and** a fresh user confirmation
  token. Model can call `propose`; only a user-confirmed action calls
  `execute`. Enforce this in the trading agent, not in a prompt.
- **Hard caps in the trading agent** (never the model): per-order size,
  per-day dollar volume, per-symbol whitelist, market-hours only,
  no-shorting flag. Model asks for anything; agent refuses out-of-policy.
- **Never let Gemma 4 auto-execute.** Not because it's local — because
  it's an 8B model. Frontier models shouldn't auto-execute either. This
  is a policy rule, not a capability rule.
- **Full audit trail**: enable `diagnostics-otel` and export to a local
  Prometheus + a permanent log store. Every proposal, every
  confirmation, every fill — timestamped, model-attributed. This is
  your receipt if a broker asks.
- **Dedicated confirmation channel**: don't confirm trades over the
  same Telegram bot you use for reminders. Second bot, 2FA'd account,
  minimal contact list. A compromised general-purpose channel becomes
  a compromised trading loop.

The same pattern applies to any high-stakes external agent — deploy
agent, billing agent, HR agent. Split proposal from execution; enforce
policy in the agent, not in the model prompt.

## Why a fork and not just `brew install openclaw`?

Because "AI in the cloud is not aligned with you; it's aligned with the
company that owns it." Same logic for the agent runtime — you want the code
you can read, patch, and pin.
