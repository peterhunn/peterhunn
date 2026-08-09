# agent — May

A local-first personal AI agent for the Hunn family, built on a fork of
[OpenClaw](https://github.com/openclaw/openclaw), running a small model
on your own Mac via [Ollama](https://ollama.com).

No cloud model. No subscription. Your prompts, your context, your model.

## What's here

```
agent/
├── SETUP.md                       ← full end-to-end install (start here)
├── bootstrap-mac.sh               ← one-shot installer script
├── CONSENT.md                     ← signable record of who authorized what
├── HOUSE-RULES.md                 ← signable smart-home automation rules
│
├── openclaw.example.jsonc         ← config templates — merge into your OpenClaw config
├── obsidian.example.jsonc
├── email-family-ea.example.jsonc
│
├── identity/                      ← May's persona, injected into her system prompt
│   ├── IDENTITY.md
│   ├── SOUL.md
│   └── USER.md                    ← fill in on Mac setup
│
├── prompts/                       ← durable prompt templates for recurring flows
│   ├── morning-brief.md
│   ├── inbox-triage.md
│   ├── meeting-prep.md
│   ├── email-draft.md
│   └── end-of-day.md
│
├── docs/                          ← deep-dive references (see below)
└── roadmap/                       ← planned but not-yet-built capabilities
    ├── money-agent.md
    └── smart-home.md
```

## Quick start

Fork [OpenClaw](https://github.com/openclaw/openclaw), then:

```bash
git clone https://github.com/peterhunn/agent.git ~/src/agent
cd ~/src/agent
export OPENCLAW_FORK=https://github.com/peterhunn/openclaw.git
export SLM_MODEL=gemma4        # or gemma4:12b on a 24 GB+ Mac
./bootstrap-mac.sh
```

That's the fast path — for the full ordered checklist including
identity, mail, calendar, Telegram, family EA, Obsidian, and
verification, follow [`SETUP.md`](SETUP.md).

## Picking a model

| Model tag           | Approx RAM | Notes                              |
| ------------------- | ---------- | ---------------------------------- |
| `gemma4`            | ~8 GB      | Default. Google SLM, well-rounded. |
| `gemma4:12b`        | ~10 GB     | Sweet spot on a 24 GB Mac mini.    |
| `gemma4:27b`        | ~20 GB     | Bigger Gemma; needs 32 GB+.        |
| `qwen2.5-coder:7b`  | ~8 GB      | Code-tuned alternative.            |
| `qwen2.5-coder:14b` | ~14 GB     | Stronger reasoning; 32 GB Mac.     |
| `llama3.2:3b`       | ~3 GB      | Tiny + fast, weaker at code.       |
| `deepseek-r1:14b`   | ~14 GB     | Reasoning-tuned distill.           |

OpenClaw's onboarding requires **tool-calling support** and a **≥16K
context window** — the auto-picker skips tags missing either.

## Deep dives (see [`docs/`](docs/README.md))

| Doc | What it covers |
|---|---|
| [zero-fee.md](docs/zero-fee.md) | Which OpenClaw extensions to disable so nothing costs money |
| [name-your-agent.md](docs/name-your-agent.md) | How May's identity is defined; syncing the name across every channel |
| [personal-automation.md](docs/personal-automation.md) | Morning brief, inbox triage, verify-local — rationale for SETUP steps 5-8 |
| [family-ea-email.md](docs/family-ea-email.md) | May as executive assistant across four hunnfamily.com mailboxes |
| [obsidian.md](docs/obsidian.md) | Vault as second brain — three integration layers |
| [phone-number.md](docs/phone-number.md) | Zero-fee iMessage identity via a dedicated Apple ID |
| [family-fleet.md](docs/family-fleet.md) | Multi-user setup via `openclaw fleet` cells |
| [external-agents.md](docs/external-agents.md) | MCP / ACP / HTTP interop; trading-agent worked example |
| [model-preservation.md](docs/model-preservation.md) | Backing up Ollama weights; provenance; fallback models |
| [why-fork.md](docs/why-fork.md) | Why to fork OpenClaw instead of `brew install`ing |

## Related repos

- **[`peterhunn/openclaw`](https://github.com/peterhunn/openclaw)** —
  your OpenClaw fork (create by clicking Fork on `openclaw/openclaw`).
  Referenced by `bootstrap-mac.sh` via `$OPENCLAW_FORK`.
- **[`peterhunn/finances`](https://github.com/peterhunn/finances)** —
  the local finance app May calls over MCP for household bills,
  budgets, and transactions.
