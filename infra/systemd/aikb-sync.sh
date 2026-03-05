#!/usr/bin/env bash
set -euo pipefail

AIKB_PATH="${AIKB_PATH:-/home/svc_ansible/AIKB}"
AIKB_REPO_URL="${AIKB_REPO_URL:-git@github.com:mcglothi/AIKB.git}"
AIKB_BRANCH="${AIKB_BRANCH:-main}"
AIKB_SSH_KEY="${AIKB_SSH_KEY:-/home/svc_ansible/.ssh/id_ed25519}"

mkdir -p "$(dirname "$AIKB_PATH")"

if [[ -f "$AIKB_SSH_KEY" ]]; then
  export GIT_SSH_COMMAND="ssh -i $AIKB_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
else
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
fi

if [[ ! -d "$AIKB_PATH/.git" ]]; then
  if [[ -d "$AIKB_PATH" ]] && [[ "$(find "$AIKB_PATH" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -gt 0 ]]; then
    mv "$AIKB_PATH" "${AIKB_PATH}.pre_git.$(date +%Y%m%d%H%M%S)"
  fi
  git clone --branch "$AIKB_BRANCH" --depth 1 "$AIKB_REPO_URL" "$AIKB_PATH"
  exit 0
fi

git -C "$AIKB_PATH" fetch --prune origin "$AIKB_BRANCH"
git -C "$AIKB_PATH" reset --hard "origin/$AIKB_BRANCH"
