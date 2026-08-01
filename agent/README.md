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
export SLM_MODEL=qwen2.5-coder:7b        # any Ollama-hosted model tag
./bootstrap-mac.sh
```

That's it. When it finishes, `openclaw` is on your `PATH`, Ollama is running
in the background serving `$SLM_MODEL`, and the agent is wired to talk to it
locally.

## Picking a model

The bootstrap defaults to `qwen2.5-coder:7b` because it's a competent coding
SLM that runs comfortably on a 16 GB Mac. Some other reasonable choices:

| Model tag              | Approx RAM | Notes                              |
| ---------------------- | ---------- | ---------------------------------- |
| `qwen2.5-coder:7b`     | ~8 GB      | Default. Balanced for code + chat. |
| `qwen2.5-coder:14b`    | ~14 GB     | Better reasoning; needs 32 GB Mac. |
| `llama3.2:3b`          | ~3 GB      | Tiny + fast, weaker at code.       |
| `gemma3:12b`           | ~10 GB     | Strong general-purpose SLM.        |
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

## Why a fork and not just `brew install openclaw`?

Because "AI in the cloud is not aligned with you; it's aligned with the
company that owns it." Same logic for the agent runtime — you want the code
you can read, patch, and pin.
