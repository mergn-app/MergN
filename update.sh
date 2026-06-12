#!/usr/bin/env bash
# Unified updater for MergN - works for BOTH install paths (Docker and native).
# Run it from the repo root:  ./update.sh   (or  ./update.sh --build  to build
# the Docker image locally instead of pulling the prebuilt one).
set -euo pipefail
cd "$(dirname "$0")"

BUILD=0
[ "${1:-}" = "--build" ] && BUILD=1

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# 1) pull the latest source (also updates docker-compose.yml itself)
say "-> Checking for updates..."
if git rev-parse --git-dir >/dev/null 2>&1; then
  git fetch --quiet origin || true
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse '@{u}' 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo "$LOCAL")
  if [ "$LOCAL" = "$REMOTE" ]; then
    say "OK Source already up to date ($(git rev-parse --short HEAD))."
  else
    BEHIND=$(git rev-list --count "HEAD..$REMOTE" 2>/dev/null || echo "?")
    say "-> $BEHIND new commit(s) - pulling..."
    git pull --ff-only
  fi
else
  say "! Not a git checkout - skipping source pull."
fi

# 2) detect install mode and apply
if command -v docker >/dev/null 2>&1 && docker compose ps >/dev/null 2>&1 \
   && docker compose ps --services 2>/dev/null | grep -qx app; then
  if [ "$BUILD" = "1" ]; then
    say "-> Docker install - rebuilding image locally..."
    docker compose up -d --build
  else
    say "-> Docker install - pulling the latest image..."
    docker compose pull
    docker compose up -d
    docker image prune -f >/dev/null 2>&1 || true
  fi
  say "OK Updated. Logs:  docker compose logs -f app"
else
  say "-> Native install - installing dependencies..."
  npm install
  ( cd web && npm install )
  say "OK Updated. Restart:  npm run server   (and in another shell:  cd web && npm run dev)"
fi
