# Zero-fee configuration

OpenClaw itself is MIT-licensed and free. Every recurring cost comes from
optional third-party integrations bundled as providers/extensions. To pay
nothing beyond hardware and electricity, **disable** the paid surfaces below
and **enable only** the local set.

## Disable — paid cloud model providers

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

## Disable — paid speech, image, video, audio

- Speech-to-text / TTS: `azure-speech`, `deepgram`, `elevenlabs`,
  `fish-audio`, `inworld`, `senseaudio`
- Image / video / music generation: `fal`, `runway`, `pixverse`, `vydra`
- Web/search APIs: `brave`, `exa`, `firecrawl`, `tavily`

## Disable — channels with per-message fees

Most channels are free. These have real per-message costs:

- `sms` (Twilio) — per SMS
- `voice-call` (Twilio) — per minute
- `whatsapp` — Meta Business API session/conversation fees
- `zoom-meetings`, `teams-meetings`, `google-meet` — often require
  paid workspace tiers to hit the APIs

Free channels you can keep: `slack`, `discord`, `telegram`, `matrix`,
`signal`, `imessage`, `irc`, `nostr`, `webhooks`, and the built-in WebChat.

## Disable — hosted deploy targets

Delete or ignore `fly.toml`, `render.yaml`, and anything under `deploy/`
targeting a paid host. Run OpenClaw on your Mac (or a homelab box) via the
Docker Compose file or directly.

## Keep — the free local stack

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

## The one-line rule

If an extension's `README.md` mentions "API key", "usage-based pricing",
"free tier", or a vendor dashboard URL — assume it costs money and leave
it disabled. If it only mentions a local port/binary/socket, it's free.

## Config sketch

OpenClaw loads extensions dynamically. Rather than allow everything and
prune, invert it: allowlist. In your `config.jsonc`, keep only the
extensions listed under **Keep** above. On first run:

```bash
openclaw extensions list          # see what's enabled
openclaw extensions disable <id>  # per-extension teardown
```

`openclaw doctor --fix` will flag any config referring to a provider
whose extension you've disabled.
