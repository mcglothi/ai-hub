#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SRC_DIR="${1:-$HOME/Code/ai-hub/infra/systemd}"
ALT_SRC_DIR="$HOME/code/ai-hub/infra/systemd"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ai-memory-sync.env"

if [[ ! -d "$SRC_DIR" && -d "$ALT_SRC_DIR" ]]; then
  SRC_DIR="$ALT_SRC_DIR"
fi

mkdir -p "$UNIT_DIR"

install -m 0644 "$SRC_DIR/ai-memory-sync.service" "$UNIT_DIR/ai-memory-sync.service"
install -m 0644 "$SRC_DIR/ai-memory-sync.timer" "$UNIT_DIR/ai-memory-sync.timer"

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$SRC_DIR/ai-memory-sync.env.example" "$ENV_FILE"
fi

systemctl --user daemon-reload
systemctl --user enable --now ai-memory-sync.timer
systemctl --user start ai-memory-sync.service

systemctl --user status ai-memory-sync.timer --no-pager --lines=20 || true
