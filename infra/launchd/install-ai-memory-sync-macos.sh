#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="${1:-$HOME/Code/ai-hub/infra/launchd}"
ALT_SRC_DIR="$HOME/code/ai-hub/infra/launchd"
if [[ ! -d "$SRC_DIR" && -d "$ALT_SRC_DIR" ]]; then
  SRC_DIR="$ALT_SRC_DIR"
fi

mkdir -p "$HOME/.local/bin" "$HOME/.config" "$HOME/Library/LaunchAgents"
install -m 700 "$SRC_DIR/ai-memory-sync.sh" "$HOME/.local/bin/ai-memory-sync.sh"
install -m 644 "$SRC_DIR/com.timmcg.ai-memory-sync.plist" "$HOME/Library/LaunchAgents/com.timmcg.ai-memory-sync.plist"

if [[ ! -f "$HOME/.config/ai-memory-sync.env" ]]; then
  cat > "$HOME/.config/ai-memory-sync.env" <<'ENV'
# Secret reference: [Stored in Vaultwarden: PAT/AIKB Memory Core/API Key]
# MMC_API_KEY=replace_me
ENV
  chmod 600 "$HOME/.config/ai-memory-sync.env"
fi

launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.timmcg.ai-memory-sync.plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.timmcg.ai-memory-sync.plist"
launchctl kickstart -k "gui/$(id -u)/com.timmcg.ai-memory-sync"

echo "Installed LaunchAgent: com.timmcg.ai-memory-sync"
launchctl print "gui/$(id -u)/com.timmcg.ai-memory-sync" | sed -n '1,60p'
