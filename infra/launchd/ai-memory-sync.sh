#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV_FILE="$HOME/.config/ai-memory-sync.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

exec python3 "$HOME/Code/ai-hub/apps/sessions/sync_agent.py" --device "$(hostname)"
