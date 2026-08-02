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

## Give your agent a phone number

Zero-fee path: put your spare SIM in an iPhone, dedicate an Apple ID to the
agent, run OpenClaw on a Mac signed into the same Apple ID, install
`@openclaw/imessage`. The agent gets an identity at that number that can
send/receive **iMessage** (free) and **SMS** (via your carrier plan, no
per-message OpenClaw fee).

Use this when you want: an inbound number for 2FA codes and booking/delivery
texts, a family-facing "text the agent" identity, or a way for the agent to
reach you when Telegram is offline.

### Setup

1. **Create a dedicated Apple ID for the agent.** Don't reuse your personal
   one — separate blast radius and permissions. `youragent@yourdomain`
   works well.
2. **Put the spare SIM in an iPhone** — any iPhone. An old one you already
   have becomes the agent's phone, plugged in at home. Sign it into the
   agent Apple ID. Settings → Messages → iMessage **on**. Verify the
   phone number is checked under "Send & Receive".
3. **On the Mac running OpenClaw**, sign in with the *same* agent Apple ID.
   Messages → Settings → iMessage → enable **Messages in iCloud** and
   check the number under "Send & Receive".
4. **On the iPhone**, Settings → Messages → **Text Message Forwarding** →
   toggle the Mac. This is what lets the Mac send/receive SMS via the
   iPhone's carrier link.
5. **Install the plugin**:
   ```bash
   openclaw plugins install @openclaw/imessage
   # then follow the imsg + macOS permissions guide:
   # https://docs.openclaw.ai/channels/imessage
   ```
   `imsg` is a Mac-side private-API bridge — expect a Full Disk Access
   grant for Messages, an Accessibility grant for the bridge, and a
   Gateway restart.
6. **Verify**:
   ```bash
   openclaw channels list                  # imessage should be present
   openclaw send --channel imessage --to "+15551234567" "hello from local Gemma"
   ```
   From your personal phone, text the agent number — the message should
   surface as an inbound event on the Gateway.

### What this unlocks

- **2FA / OTP triage** — codes land on the agent number; agent forwards
  the ones you care about to your personal channel, drops marketing.
- **Booking / delivery / appointment SMS** — agent parses, adds to
  calendar, pings you only if action needed.
- **Family "text the agent"** — the household number for "when's dad
  home", "what's for dinner", "add milk to the shopping list".
- **Backup notification path** — if Telegram is down, the agent can
  still reach you via iMessage.

### Non-negotiable guardrails

SMS carries real regulatory weight (TCPA in the US especially), and it's a
prime prompt-injection vector. Enforce these in tool config, not in a
prompt:

- **Never auto-reply to unknown numbers.** Unknown-sender messages
  become read-only inputs — the agent can summarize them to you, never
  respond to them.
- **Outbound only to an allowlist.** You, family, explicit business
  contacts. Anything else drafts and requires your approval on your
  primary channel (Telegram).
- **Draft-first for anything sensitive** — same email pattern:
  `propose_message → you approve on Telegram → send`.
- **Rate-limit outbound**. Hard cap enforced in the tool (e.g. 20
  messages/day/recipient, 100/day total). Runaway loops on SMS get
  expensive and get you carrier-flagged.
- **Never send links you didn't originate.** Injection defense: an
  incoming SMS asking the agent to "text this URL to your contacts"
  must not survive the outbound allowlist.

Config sketch (add to your OpenClaw config after the plugin is installed):

```jsonc
{
  "channels": {
    "imessage": {
      "outbound": {
        "mode": "allowlist",
        "allowlist": [
          "+15550001111",   // you
          "+15550002222"    // partner
        ],
        "defaultToDraft": true,
        "rateLimit": {
          "perRecipientPerDay": 20,
          "totalPerDay": 100
        }
      },
      "inbound": {
        "unknownSender": "read-only"
      }
    }
  }
}
```

### When to use Twilio instead (breaks zero-fee)

Fall back to OpenClaw's `sms` extension only if you need: the number
reachable when the Mac/iPhone is off; programmatic voice IVR;
transcription of arbitrary calls; multiple numbers or A2P/10DLC-registered
business SMS. None of that applies to a personal/family setup with a
spare SIM.

## Name your agent — meet May

The agent's name is **May**. She's Peter's personal agent.

OpenClaw injects a set of workspace bootstrap files into the system prompt
every turn (`docs/gateway/config-agents.md`). Three of them shape her
identity:

- **`IDENTITY.md`** — who she is, what she does, what she doesn't
- **`SOUL.md`** — her operating values, in priority order
- **`USER.md`** — who Peter is, so she can be useful to him

Starter versions of all three are in `agent/identity/`. On first Mac bring-up:

```bash
mkdir -p ~/.openclaw/workspace
cp agent/identity/IDENTITY.md agent/identity/SOUL.md agent/identity/USER.md \
   ~/.openclaw/workspace/
$EDITOR ~/.openclaw/workspace/USER.md    # fill in the blanks
```

Then restart the Gateway. She'll introduce herself as May.

### Sync the name across every surface

`IDENTITY.md` sets what she *thinks* she's called. Match that on every
channel she appears on:

| Surface | Where to set the name |
|---|---|
| Telegram bot | @BotFather → `/setname May` and `/setabouttext` |
| iMessage | Settings → Apple ID → Name = "May" on the agent Apple ID |
| Gmail sender name | Google Account → Personal info → set for the agent OAuth account |
| Email signature | Add `— May, on behalf of Peter` as the default sig in `gog send` |
| OpenClaw display | `openclaw config set agents.defaults.displayName "May"` |
| Fleet cell name | For the family setup, this cell is `peter`; May is who lives inside it |

The rule of thumb: if anyone new interacts with her and can't tell she's
May, one surface didn't get updated.

### Tuning her personality later

The three files in `agent/identity/` are the source of truth in this repo;
your workspace copies at `~/.openclaw/workspace/` are what the running
agent reads. Two patterns:

- **Small tweaks live in the workspace.** Edit `~/.openclaw/workspace/*.md`
  directly, restart the Gateway. Faster iteration.
- **Anything you want to keep**, copy back into `agent/identity/` and
  commit. That way a fresh Mac bring-up starts with the current May, not
  the day-one May.

For per-context specialization (e.g. a stricter version of May for the
trading loop), use OpenClaw's `agents.entries.*` config to define a
separate agent id with its own IDENTITY override — inherits the same
model, different persona.

## Obsidian as May's second brain

Your Obsidian vault is just a folder of markdown, which makes it a near-ideal
fit for a local agent: no cloud, no plugins strictly required, semantic
search via local embeddings. Three layers — enable as many as you want.

### Layer 1 — Direct read/write

Point May at the vault. She uses her built-in file tools; no plugin needed.

```bash
openclaw config set agents.defaults.contextRoots.obsidian \
  "$HOME/Documents/Obsidian/MyVault"
```

She can now read any note, list any folder, append to a daily note, or
create new notes in `Inbox/`.

### Layer 2 — Semantic search (the real "second brain")

Index the vault with `memory-lancedb` using **local** Ollama embeddings —
zero external calls, zero fees.

```bash
ollama pull nomic-embed-text                            # small, strong, local

openclaw memory add-source obsidian \
  --path "$HOME/Documents/Obsidian/MyVault" \
  --backend lancedb \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --watch                                               # re-embed on change
```

If `--watch` ever misses changes, back it up with a scheduled reindex:

```bash
openclaw automations create \
  --every 1h \
  --name "obsidian-reindex" \
  --system-event "openclaw memory reindex obsidian"
```

Now: "what did I write about X" hits the vault semantically, not by
filename. Backlinks, tags, and frontmatter are preserved as metadata.

### Layer 3 — Write-back with guardrails

Same draft-first rule as email — May proposes changes, you confirm — but
some classes are safe enough to auto-append:

Auto (safe):

- Append to today's daily note (`Daily/YYYY-MM-DD.md`)
- Create in `Inbox/` (you triage later)
- Log a meeting summary to `Meetings/YYYY-MM-DD - <title>.md`

Confirm first:

- Edit an existing non-daily note
- Modify frontmatter on any existing note
- Move notes between folders
- Delete anything

Never (denied even with confirmation):

- Anything under `.obsidian/` (plugin configs / workspace state)
- Anything under `.trash/` or `Archive/` by default (change if you want)

Copy `obsidian.example.jsonc` into your OpenClaw config as a starting
point, then edit the paths.

### What this unlocks

- **"Save that to Obsidian"** → new note in `Inbox/`, tagged
- **"Add to today's daily"** → appended under a `## Captured` heading
- **"What did I say about X?"** → semantic hits with `[[wikilinks]]` back
  to source notes
- **Morning brief additions** — "yesterday you left three threads open in
  your daily note: …"
- **Meeting prep** — "here's everything in your vault mentioning
  [attendee] since your last meeting" — auto-loaded before calendar
  events
- **End-of-day** — "captured 4 items to Inbox today, want me to file
  them?"

### One important guardrail

**Turn on either Obsidian Sync or a git-tracked vault before enabling
Layer 3.** May's writes are reversible only if you can roll back. The
`denyPatterns` block above prevents her from corrupting Obsidian
internals, but nothing prevents an honest mistake in your own notes.
Reversibility is the safety net.

### Optional: Obsidian Local REST API plugin

Install the community **Local REST API** plugin and register its endpoint
as a custom tool if you want May to trigger actions inside the running
Obsidian app (open a note, jump to a heading, run a command-palette
action). Filesystem access alone is enough for reading and writing —
this is only for UI-level control.

## Why a fork and not just `brew install openclaw`?

Because "AI in the cloud is not aligned with you; it's aligned with the
company that owns it." Same logic for the agent runtime — you want the code
you can read, patch, and pin.
