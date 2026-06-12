#!/usr/bin/env bash
# One-line installer for MergN. Clones the repo to a fixed location and puts the
# `mergn` command on your PATH, so you can run `mergn run` / `mergn update` from
# anywhere.
#
#   curl -fsSL https://raw.githubusercontent.com/flowbaker/MergN/main/install.sh | bash
#
# Override the location with MERGN_DIR=/path before the pipe.
set -euo pipefail

REPO_URL="${MERGN_REPO:-https://github.com/flowbaker/MergN.git}"
DEST="${MERGN_DIR:-${HOME}/.mergn}"
BIN_DIR="${MERGN_BIN_DIR:-/usr/local/bin}"

ln_cmd() {
  if [ -w "${BIN_DIR}" ]; then ln -sf "$1" "$2"; else sudo ln -sf "$1" "$2"; fi
}

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

if [ -d "${DEST}/.git" ]; then
  echo "-> Updating existing MergN at ${DEST} ..."
  git -C "${DEST}" pull --ff-only
else
  echo "-> Cloning MergN into ${DEST} ..."
  git clone --depth 1 "${REPO_URL}" "${DEST}"
fi

chmod +x "${DEST}/mergn" "${DEST}/update.sh" 2>/dev/null || true
ln_cmd "${DEST}/mergn" "${BIN_DIR}/mergn"

echo "OK - 'mergn' is now on your PATH (${BIN_DIR}/mergn), repo at ${DEST}"
echo

# Prepare a runnable path so `mergn run` just works, whether or not the user
# knows Docker. Prefer Docker (everything bundled); otherwise set up native.
if command -v docker >/dev/null 2>&1; then
  echo "Docker detected - MergN will run in Docker (app + Mongo + NATS bundled)."
  echo "Make sure Docker is running, then:"
  echo "  mergn run        # start  ->  http://localhost:8787"
  echo "  mergn logs       # view logs    |   mergn update   # upgrade later"
elif command -v npm >/dev/null 2>&1; then
  echo "Docker not found - setting up the native (Node) install..."
  ( cd "${DEST}" && npm install && cd web && npm install )
  echo "OK - native deps installed. Start with:"
  echo "  mergn run        # backend :8787 + web :5173   |   mergn update"
else
  echo "Node is not installed. Install it with the command for your system:"
  if command -v brew >/dev/null 2>&1; then
    echo "  brew install node"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install -y nodejs npm"
  elif command -v pacman >/dev/null 2>&1; then
    echo "  sudo pacman -S --noconfirm nodejs npm"
  elif command -v apk >/dev/null 2>&1; then
    echo "  sudo apk add nodejs npm"
  else
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . \"\$HOME/.nvm/nvm.sh\" && nvm install 22"
  fi
  echo
  echo "Then re-run this installer (it will set up the native deps):"
  echo "  curl -fsSL \"https://raw.githubusercontent.com/flowbaker/MergN/main/install.sh?\$(date +%s)\" | bash"
fi
