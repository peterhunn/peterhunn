# SETUP — end-to-end

Everything you need to go from zero to a working local May, in order.
Do them in this order; each step depends on the previous one.

Legend: 🌐 = browser step (you), ⌨️ = terminal step (paste + run).

---

## 0. Prerequisites

- **A Mac**, 16 GB RAM minimum (32 GB comfortable). Apple Silicon
  strongly preferred.
- **A GitHub account** (you already have `peterhunn`).
- Roughly **1-2 hours** of focused time, plus ~5 GB of download for
  the Gemma 4 weights.

---

## 1. Fork OpenClaw 🌐

- Go to `https://github.com/openclaw/openclaw`
- Click **Fork** → confirm
- Fork lands at `https://github.com/peterhunn/openclaw`

Why fork instead of using upstream directly: you own the code you run.
If upstream ships a breaking change, your fork stays pinned.

---

## 2. Bootstrap May ⌨️

```bash
git clone https://github.com/peterhunn/agent.git ~/src/agent
cd ~/src/agent

export OPENCLAW_FORK=https://github.com/peterhunn/openclaw.git
export SLM_MODEL=gemma4
./bootstrap-mac.sh
```

Expect ~30 min. Installs Homebrew, Ollama, Node, pnpm; clones your
OpenClaw fork; builds it; pulls the Gemma 4 model; runs `openclaw onboard`
pinned at your local Ollama.

---

## 3. Give May her identity ⌨️

```bash
mkdir -p ~/.openclaw/workspace
cp ~/src/agent/identity/IDENTITY.md \
   ~/src/agent/identity/SOUL.md \
   ~/src/agent/identity/USER.md \
   ~/.openclaw/workspace/

open -a TextEdit ~/.openclaw/workspace/USER.md
# fill in the blanks: timezone, focus hours, people, tone prefs, etc.

# smoke test
openclaw chat "who are you?"
# expected: "I'm May, Peter's personal agent..."
```

---

## 4. Email + Calendar (via `gog`) 🌐 then ⌨️

**Browser first:**

- Open `https://console.cloud.google.com`
- Create a personal project (name doesn't matter)
- **APIs & Services → Enabled APIs** → enable **Gmail API** and
  **Google Calendar API**
- **Credentials → Create Credentials → OAuth client ID**
  → application type **Desktop app**
- Download the JSON → save as `~/Downloads/client_secret.json`

**Terminal:**

```bash
brew install gogcli
gog auth credentials ~/Downloads/client_secret.json
gog auth add you@gmail.com --services gmail,calendar
# browser opens for Google consent → approve → back to terminal

gog auth list

# verify
gog gmail search 'newer_than:1d' --max 3
gog calendar events primary \
  --from "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --to   "$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ)"
```

---

## 5. Telegram — May's notify-you channel 🌐 then ⌨️

**Browser / Telegram first:**

- Message `@BotFather` on Telegram
- `/newbot` → follow prompts → copy the token
- `/setname` → **May** (so she introduces herself consistently)
- DM your new bot **any message** so it can DM you back
- Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser
- Find the `"chat":{"id": ...}` number — that's your chat id

**Terminal:**

```bash
openclaw channels add telegram
# paste token, paste chat id, name the channel "me"
openclaw channels list

openclaw send --channel me "hello from May"
# check your phone — should DM within seconds
```

---

## 6. First automation — morning brief ⌨️

```bash
TZ="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"
openclaw automations create \
  --cron "0 7 * * 1-5" --tz "$TZ" \
  --name "morning-brief" \
  --session main \
  --channel me \
  --system-event "$(cat ~/src/agent/prompts/morning-brief.md)"
# If your OpenClaw build supports --system-event-file, prefer that:
#   --system-event-file ~/src/agent/prompts/morning-brief.md

openclaw automations list
```

Prompts live under `prompts/` — see `prompts/README.md`. Edit them
without touching automation config; add more (`inbox-triage`,
`meeting-prep`, `email-draft`, `end-of-day`) and register additional
automations pointing at those files.

Confirm at 07:00 tomorrow that it lands. If not, `openclaw automations
runs --id <job-id>` shows what happened.

---

## 6b. Family EA email — May's identity + Peter/Shweta/office mailboxes 🌐 then ⌨️

Prerequisite: everyone whose mailbox May will access has read and signed
`CONSENT.md`. Copy it into `~/.openclaw/workspace/CONSENT.md` before
running the OAuth grants — May reads it as bootstrap context.

**Browser** (`admin.google.com`):

- **Users → Add new user** → `may@hunnfamily.com` (adds one Workspace
  license, ~$6/mo)

**Terminal** (each `gog auth add` opens a browser — whoever owns the
account must be logged into that browser and consent):

```bash
gog auth add may@hunnfamily.com    --services gmail,calendar,drive
gog auth add office@hunnfamily.com --services gmail,calendar
gog auth add peter@hunnfamily.com  --services gmail,calendar   # Peter consents
gog auth add shweta@hunnfamily.com --services gmail,calendar   # Shweta consents

gog auth list       # verify all four
```

**Second Telegram channel for Shweta** (so she approves her own drafts):

- Shweta on Telegram: `@BotFather` → `/newbot` → `/setname May (Shweta)`
  → copy token. DM the bot once. Get chat id from
  `https://api.telegram.org/bot<TOKEN>/getUpdates`.

```bash
openclaw channels add telegram
# name: "shweta"
# paste her bot token and chat id
openclaw channels list
```

**Merge the family EA config**:

```bash
open -a TextEdit ~/src/agent/email-family-ea.example.jsonc
open -a TextEdit "$HOME/Library/Application Support/openclaw/config.jsonc"
# copy the identities + tools.gmail + calendars blocks over, save.

openclaw doctor    # validate
```

Smoke test:

```bash
openclaw chat "search my inbox for anything from shweta this week and summarize"
openclaw chat "draft a reply to <latest email in peter@> — casual tone, one paragraph"
# expected: draft lands on Peter's Telegram for approval
```

## 7. Obsidian second brain (optional but strongly recommended) ⌨️

```bash
# 1. Direct file access
openclaw config set agents.defaults.contextRoots.obsidian \
  "$HOME/Documents/Obsidian/MyVault"

# 2. Semantic search over the vault
ollama pull nomic-embed-text
openclaw memory add-source obsidian \
  --path "$HOME/Documents/Obsidian/MyVault" \
  --backend lancedb \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --watch

# 3. Write-back with guardrails — merge obsidian.example.jsonc into your config
open -a TextEdit ~/src/agent/obsidian.example.jsonc
open -a TextEdit "$HOME/Library/Application Support/openclaw/config.jsonc"
# copy the agents.contextRoots + memory.sources + tools.obsidian blocks over,
# edit the vaultPath to match yours, save.

# smoke test
openclaw chat "save this to today's daily: figured out May can index my vault"
openclaw chat "what did I write today about May?"
```

**Before enabling write-back, turn on Obsidian Sync or make the vault
a git repo.** May's writes are reversible only if you can roll back.

---

## 8. Verify local-only ⌨️

```bash
openclaw models list --provider ollama
# expect: gemma4 (plus nomic-embed-text if you did step 7)

openclaw extensions list
# expect: only local extensions + gog + telegram (+ obsidian tool if step 7)

lsof -i -n -P 2>/dev/null | grep -Ei 'ollama|openclaw|node' | grep -v '127.0.0.1\|LISTEN'
# expect: empty. Any *.openai.com or *.anthropic.com means an extension
# slipped through — disable with: openclaw extensions disable <id>
```

That's the base. May is running locally, reading your mail + calendar,
searching your Obsidian vault, and DMing you the morning brief.

---

## 7b. Preserve your model — three insurance policies ⌨️

Once everything's verified, spend five minutes making sure a lost disk
or a vanished model registry can't take May down. Local weights are only
autonomous if you actually keep a local copy of them.

```bash
# 1. Note total footprint, then back up ~/.ollama/models
du -sh ~/.ollama/models/
# Option A: rely on Time Machine (verify ~/.ollama is included)
# Option B: explicit one-shot copy to an external drive
rsync -aP ~/.ollama/models/ /Volumes/Backup/ollama-models/

# 2. Record model provenance so you can prove/reproduce which version is yours
mkdir -p ~/.openclaw/model-provenance
ollama list                        > ~/.openclaw/model-provenance/list-$(date +%F).txt
ollama show gemma4  --modelfile    > ~/.openclaw/model-provenance/gemma4-$(date +%F).txt
ollama show nomic-embed-text --modelfile \
                                   > ~/.openclaw/model-provenance/nomic-embed-text-$(date +%F).txt

# 3. Pre-pull one fallback model while it's easy — insurance for the day
#    a registry stops serving your primary model
ollama pull qwen2.5:14b            # strong general-purpose alternative (~9 GB)
ollama pull llama3.2:3b            # small always-runnable fallback (~2 GB)
```

Restoring from a lost disk: `rsync -aP /Volumes/Backup/ollama-models/
~/.ollama/models/` and Ollama picks the models up on next launch.

Repeat the `ollama show ... > provenance` snapshot **any time you swap
the default model** so the record stays current.

## Roadmap items (post-base, capture-only for now)

Longer-horizon capabilities documented in `roadmap/`. Do not start any
of these until base May has run stably for ≥ 4 weeks and the current
optional add-ons list below is settled. Read the roadmap docs when it's
time to actually build.

- **Money agent** (`roadmap/money-agent.md`) — bills, groceries,
  subscriptions. Passive → assisted → autonomous, dedicated finance
  agent behind an MCP boundary, dedicated money confirmation channel.
- **Smart home** (`roadmap/smart-home.md`) — Google Home + Rainbird
  irrigation via Home Assistant. HA as middleware, four maturity
  layers, physical override always wins.

## Optional add-ons (add only after the base is stable ~1 week)

- **iMessage / phone number** — [`docs/phone-number.md`](docs/phone-number.md)
- **Inbox triage automation** — [`docs/personal-automation.md`](docs/personal-automation.md)
- **Family with Fleet** — [`docs/family-fleet.md`](docs/family-fleet.md) (needs OrbStack)
- **External agents (trading, etc.)** — [`docs/external-agents.md`](docs/external-agents.md)

Do these one at a time. Each one adds surface area for things to break.

---

## When something breaks

- **`openclaw doctor`** — validates config, tells you what's misconfigured.
- **`openclaw doctor --fix`** — auto-corrects common issues.
- **`openclaw automations runs --id <job-id>`** — see what a job actually did.
- **`~/.openclaw/logs/`** — Gateway logs.
- **`brew services list`** — is Ollama running?

If stuck, paste the error into the chat with Claude — it's diagnosable
from here.
