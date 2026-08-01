#!/usr/bin/env bash
# Bring up a local OpenClaw agent on macOS, pointed at your own SLM via Ollama.
#
# Usage:
#   export OPENCLAW_FORK=https://github.com/<you>/openclaw.git
#   export SLM_MODEL=gemma4     # optional, this is the default
#   ./bootstrap-mac.sh

set -euo pipefail

: "${OPENCLAW_FORK:?Set OPENCLAW_FORK to your fork of openclaw/openclaw (git URL).}"
SLM_MODEL="${SLM_MODEL:-gemma4}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
CHECKOUT_DIR="${CHECKOUT_DIR:-$HOME/src/openclaw}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap is macOS-only. Detected: $(uname -s)" >&2
  exit 1
fi

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# Homebrew
if ! command -v brew >/dev/null 2>&1; then
  log "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Ollama
if ! command -v ollama >/dev/null 2>&1; then
  log "Installing Ollama"
  brew install --cask ollama
fi

# Start the Ollama daemon if it isn't already answering
if ! curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  log "Starting Ollama daemon"
  open -a Ollama || true
  for _ in {1..30}; do
    curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Pull the model if it isn't already local
if ! ollama list | awk '{print $1}' | grep -Fxq "$SLM_MODEL"; then
  log "Pulling $SLM_MODEL (this can take a while on first run)"
  ollama pull "$SLM_MODEL"
fi

# Node + pnpm (OpenClaw is a TS monorepo)
command -v node   >/dev/null 2>&1 || { log "Installing Node.js"; brew install node; }
command -v pnpm   >/dev/null 2>&1 || { log "Installing pnpm";    brew install pnpm; }

# Clone your fork
if [[ ! -d "$CHECKOUT_DIR/.git" ]]; then
  log "Cloning fork into $CHECKOUT_DIR"
  mkdir -p "$(dirname "$CHECKOUT_DIR")"
  git clone "$OPENCLAW_FORK" "$CHECKOUT_DIR"
else
  log "Fork already checked out at $CHECKOUT_DIR, pulling latest"
  git -C "$CHECKOUT_DIR" pull --ff-only
fi

# Build
log "Installing OpenClaw dependencies"
(cd "$CHECKOUT_DIR" && pnpm install --frozen-lockfile=false)

log "Building OpenClaw"
(cd "$CHECKOUT_DIR" && pnpm build)

# Link the CLI onto PATH via pnpm
(cd "$CHECKOUT_DIR" && pnpm link --global) || true

# Non-interactive onboarding, wired to the local Ollama daemon and your model.
# `ollama-local` is OpenClaw's marker for loopback/LAN Ollama hosts that
# don't need a real bearer token.
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-ollama-local}"
log "Running openclaw onboard (non-interactive)"
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "$OLLAMA_URL" \
  --custom-model-id "$SLM_MODEL" \
  --accept-risk

log "Verifying provider"
openclaw models list --provider ollama || true

cat <<EOF

Done. Your local agent is configured:

  runtime : Ollama at $OLLAMA_URL
  model   : $SLM_MODEL
  source  : $CHECKOUT_DIR   (fork: $OPENCLAW_FORK)

Try it:
  openclaw chat "summarize the diff between HEAD~1 and HEAD"

To swap models later:
  ollama pull <new-tag>
  openclaw config set models.default <new-tag>
EOF
