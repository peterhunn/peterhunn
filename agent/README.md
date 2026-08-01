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

## Why a fork and not just `brew install openclaw`?

Because "AI in the cloud is not aligned with you; it's aligned with the
company that owns it." Same logic for the agent runtime — you want the code
you can read, patch, and pin.
