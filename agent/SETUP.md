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
  --system-event "Produce my morning brief:
    - Today's calendar via: gog calendar events primary --from <today> --to <tomorrow>
    - Unread mail since 6pm yesterday via: gog gmail search 'is:unread newer_than:14h' --max 25
    Return: (1) top 3 meetings with prep notes, (2) mail worth acting on today,
    (3) anything I said I'd follow up on. Keep it under 200 words."

openclaw automations list
```

Confirm at 07:00 tomorrow that it lands. If not, `openclaw automations
runs --id <job-id>` shows what happened.

---

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

## Optional add-ons (add only after the base is stable ~1 week)

- **iMessage / phone number** — see README "Give your agent a phone number"
- **Inbox triage automation** — README "Personal automation quickstart" step 5
- **Family with Fleet** — README "Family setup with Fleet" (needs OrbStack)
- **External agents (trading, etc.)** — README "Calling external agents (MCP)"

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
